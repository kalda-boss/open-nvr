# Copyright (c) 2026 OpenNVR
# This file is part of OpenNVR.
#
# OpenNVR is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# OpenNVR is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with OpenNVR.  If not, see <https://www.gnu.org/licenses/>.

"""Startup MediaMTX provisioning with retries.

Background: on a host reboot core and MediaMTX start together, and the
startup loop used to try each camera exactly once. One camera's upsert hit a
transient connection error while the other ten succeeded; nothing retried
it, so MediaMTX had no path for that camera and it went unrecorded for 70
minutes until someone re-provisioned it by hand. A camera that fails here
has no live view and no recording, so it is retried with backoff, and any
camera still failing after the last round is logged at ERROR by id.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from core.logging_config import main_logger

# Seconds to wait before each retry round: ~3 min in total, enough to ride
# out MediaMTX reloading its API listener or finishing a slow start.
RETRY_DELAYS_SECONDS: tuple[float, ...] = (5, 10, 20, 40, 60, 60)


@dataclass
class ProvisionJob:
    camera_id: int
    camera_ip: str | None
    payload: dict[str, Any]


Upsert = Callable[[int, str | None, dict[str, Any]], Awaitable[dict[str, Any]]]


async def _attempt(job: ProvisionJob, upsert: Upsert) -> bool:
    try:
        # upsert, not add: when MediaMTX outlives a server restart every
        # path already exists, and a plain add leaves each one on whatever
        # config it had.
        res = await upsert(job.camera_id, job.camera_ip, job.payload)
    except Exception as e:
        main_logger.warning(
            f"[MTX] provision error camera_id={job.camera_id}: {e}",
            extra={"camera_id": job.camera_id},
        )
        # Don't log full traceback for connection errors to reduce noise
        if "ConnectionError" not in str(type(e)):
            main_logger.error(
                f"[MTX] Unexpected error camera_id={job.camera_id}: {e}",
                extra={"camera_id": job.camera_id},
                exc_info=True,
            )
        return False

    main_logger.log_action(
        "mediamtx.path_provision",
        camera_id=job.camera_id,
        message=f"MediaMTX path provisioned: path={res.get('path')} status={res.get('status')} http={res.get('http_status')}",
        extra_data={"provision_result": res},
    )
    # The service returns "ok", never "success" — this counter used to log
    # 0 successes on every startup.
    return res.get("status") == "ok"


async def provision_pass(jobs: list[ProvisionJob], upsert: Upsert) -> list[int]:
    """Try every job once. Returns the camera ids that failed."""
    failed = [job.camera_id for job in jobs if not await _attempt(job, upsert)]
    main_logger.info(
        f"[MTX] Background provisioning completed: {len(jobs) - len(failed)} success, {len(failed)} failed"
    )
    return failed


async def retry_failed(
    failed: list[int],
    load_jobs: Callable[[list[int]], list[ProvisionJob]],
    upsert: Upsert,
    *,
    retry_delays: tuple[float, ...] = RETRY_DELAYS_SECONDS,
    sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
) -> list[int]:
    """Retry failed cameras with backoff. Returns the ids still failing.

    ``load_jobs`` rebuilds the jobs from the DB before every round, so a
    camera paused, binned or edited during the wait isn't provisioned from
    a stale snapshot (that would resurrect a torn-down path or undo the
    edit's own provisioning).
    """
    pending = list(failed)
    for round_no, delay in enumerate(retry_delays, start=1):
        if not pending:
            break
        main_logger.info(
            f"[MTX] Retrying provisioning in {delay:g}s (round {round_no}/{len(retry_delays)}) "
            f"for camera_ids={pending}"
        )
        await sleep(delay)
        pending = [
            job.camera_id for job in load_jobs(pending)
            if not await _attempt(job, upsert)
        ]

    if pending:
        main_logger.error(
            f"[MTX] Provisioning still failing after {len(retry_delays)} retries for "
            f"camera_ids={pending}: these cameras have no MediaMTX path and are NOT recording",
            extra={"camera_ids": pending},
        )
    elif failed:
        main_logger.info("[MTX] Provisioning retry succeeded; all cameras provisioned")
    return pending
