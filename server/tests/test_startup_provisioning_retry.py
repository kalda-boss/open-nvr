# Copyright (c) 2026 OpenNVR
# Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0)
"""Startup provisioning retries a camera whose path failed to provision.

Field incident: after a host reboot one camera's upsert hit a transient
MediaMTX connection error while ten others succeeded. The startup loop tried
once, so that camera had no path and went unrecorded for 70 minutes.
"""

import asyncio
import os
import secrets
import sys
from pathlib import Path

from cryptography.fernet import Fernet

_HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_HERE))
os.environ.setdefault("DATABASE_URL", "sqlite:///./_mtx_test.db")
os.environ.setdefault("SECRET_KEY", secrets.token_urlsafe(48))
os.environ.setdefault("MEDIAMTX_SECRET", secrets.token_hex(32))
os.environ.setdefault("INTERNAL_API_KEY", secrets.token_urlsafe(48))
os.environ.setdefault("CREDENTIAL_ENCRYPTION_KEY", Fernet.generate_key().decode())

from services.startup_provisioning import ProvisionJob, provision_pass, retry_failed


def _job(cam_id, url="rtsp://cam"):
    return ProvisionJob(cam_id, f"10.0.0.{cam_id}", {"source_url": url})


class _FlakyUpsert:
    """Fails each camera id the given number of times, then returns ok."""

    def __init__(self, failures):
        self.failures = dict(failures)
        self.calls = []

    async def __call__(self, camera_id, camera_ip, payload):
        self.calls.append((camera_id, payload))
        if self.failures.get(camera_id, 0) > 0:
            self.failures[camera_id] -= 1
            return {"status": "connection_error", "path": f"cam-{camera_id}"}
        return {"status": "ok", "path": f"cam-{camera_id}", "http_status": 200}


async def _no_sleep(_):
    return None


def test_first_pass_reports_only_the_failures():
    upsert = _FlakyUpsert({1: 1})
    failed = asyncio.run(provision_pass([_job(1), _job(2), _job(3)], upsert))
    assert failed == [1]


def test_an_exception_counts_as_a_failure():
    async def boom(camera_id, camera_ip, payload):
        raise RuntimeError("unexpected")

    assert asyncio.run(provision_pass([_job(4)], boom)) == [4]


def test_a_transient_failure_is_retried_until_it_lands():
    upsert = _FlakyUpsert({1: 3})
    still = asyncio.run(retry_failed(
        [1], lambda ids: [_job(i) for i in ids], upsert,
        retry_delays=(1, 1, 1, 1), sleep=_no_sleep,
    ))
    assert still == []
    assert [c[0] for c in upsert.calls] == [1, 1, 1, 1]


def test_only_failed_cameras_are_retried():
    upsert = _FlakyUpsert({})
    asked = []

    def load(ids):
        asked.append(list(ids))
        return [_job(i) for i in ids]

    asyncio.run(retry_failed([7], load, upsert, retry_delays=(1,), sleep=_no_sleep))
    assert asked == [[7]]
    assert [c[0] for c in upsert.calls] == [7]


def test_a_camera_that_never_recovers_is_reported():
    upsert = _FlakyUpsert({1: 99})
    still = asyncio.run(retry_failed(
        [1], lambda ids: [_job(i) for i in ids], upsert,
        retry_delays=(1, 1), sleep=_no_sleep,
    ))
    assert still == [1]
    assert len(upsert.calls) == 2


def test_each_round_reloads_from_the_db():
    """A camera edited during the wait is retried with its new config."""
    upsert = _FlakyUpsert({1: 1})
    rounds = iter([[_job(1, "rtsp://old")], [_job(1, "rtsp://edited")]])
    asyncio.run(retry_failed(
        [1], lambda ids: next(rounds), upsert,
        retry_delays=(1, 1), sleep=_no_sleep,
    ))
    assert [c[1]["source_url"] for c in upsert.calls] == ["rtsp://old", "rtsp://edited"]


def test_a_camera_paused_during_the_wait_is_not_resurrected():
    upsert = _FlakyUpsert({})
    still = asyncio.run(retry_failed(
        [1], lambda ids: [], upsert, retry_delays=(1, 1), sleep=_no_sleep,
    ))
    assert still == []
    assert upsert.calls == []


def test_backoff_waits_between_rounds():
    waits = []

    async def record(delay):
        waits.append(delay)

    asyncio.run(retry_failed(
        [1], lambda ids: [_job(i) for i in ids], _FlakyUpsert({1: 99}),
        retry_delays=(5, 10, 20), sleep=record,
    ))
    assert waits == [5, 10, 20]
