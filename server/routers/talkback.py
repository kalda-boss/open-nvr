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

"""Talk-back — push-to-talk from the browser to a camera's speaker.

* ``GET /cameras/{id}/talk`` — can this camera talk, and may the caller?
* ``WS  /cameras/{id}/talk/ws?ticket=…`` — hold it open while talking. The
  client sends binary frames of 16-bit LE PCM, 8 kHz mono; the server relays
  them over the camera's ONVIF backchannel (services/talkback.py). Closing
  the socket ends the talk.

The socket authenticates with the same single-use ticket as the events
stream (``POST /events/ws-ticket``) and passes the same device-firewall
check. Speaking needs the ``talk.speak`` permission AND access to the camera.
Every talk is audit-logged with its duration. One talker per camera.
"""

from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy.orm import Session

from core.auth import get_current_active_user
from core.client_ip import get_client_ip
from core.database import SessionLocal, get_db
from core.logging_config import main_logger
from core.permissions import PermissionChecker, get_camera_or_403, user_has_permission
from models import Camera, User
from routers.events import _authenticate_ws, _ws_firewall_allows, _ws_ticket_bindings
from services import talkback
from services.audit_service import write_audit_log

router = APIRouter(prefix="/cameras", tags=["talkback"])

TALK_PERMISSION = "talk.speak"

#: Longest single talk. Push-to-talk is seconds; a socket held open for
#: minutes is a stuck button or a stuck tab, not someone still speaking.
MAX_TALK_SECONDS = 120


@router.get("/{camera_id}/talk")
async def get_talk_capability(
    refresh: bool = Query(False, description="Re-probe instead of using the cache"),
    camera: Camera = Depends(get_camera_or_403),
    current_user: User = Depends(get_current_active_user),
):
    """Whether this camera can talk (``supported``/``reason``), whether the
    caller may (``allowed``), and who is talking right now, if anyone."""
    cap = await talkback.talk_capability(camera, force=refresh)
    return {
        **cap,
        "allowed": user_has_permission(current_user, TALK_PERMISSION),
        "in_use_by": talkback.current_talker(camera.id),
    }


def _authorize(ticket: str | None, camera_id: int, ip: str):
    """``((user_id, username), camera, ticket binding, refusal)``; refusal is
    None when the socket may open. One session for the user and the camera
    check, like events_stream, so nothing runs on a detached row."""
    binding = _ws_ticket_bindings.get(ticket) if ticket else None
    db_gen = get_db()
    db: Session = next(db_gen)
    try:
        user = _authenticate_ws(ticket, db, binding, ip)
        if user is None or not isinstance(user, User):
            # A service ticket has no person behind it to hold a speaker.
            return None, None, binding, "unauthorized"
        if not user_has_permission(user, TALK_PERMISSION):
            return None, None, binding, "forbidden"
        try:
            camera = PermissionChecker(Camera).check(camera_id, user, db)
        except HTTPException:
            return None, None, binding, "forbidden"
        if camera.deleted_at is not None:
            return None, None, binding, "forbidden"
        db.expunge(camera)
        return (user.id, user.username), camera, binding, None
    finally:
        try:
            next(db_gen)
        except StopIteration:
            pass


@router.websocket("/{camera_id}/talk/ws")
async def talk_stream(
    websocket: WebSocket,
    camera_id: int,
    ticket: str | None = Query(default=None, description="Single-use WS ticket"),
):
    """Relay the caller's microphone to the camera's speaker until closed.

    Control frames (JSON text) sent by the server: ``{"type": "ready"}`` once
    the camera has accepted the backchannel (start sending audio then), and
    ``{"type": "error", "reason": …}`` before closing on failure.
    """
    ip = get_client_ip(websocket)
    who, camera, binding, refusal = _authorize(ticket, camera_id, ip)
    if refusal is None and not _ws_firewall_allows(websocket, binding):
        refusal = "device_not_approved"
    if refusal is not None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason=refusal)
        return
    user_id, username = who

    await websocket.accept()
    if not talkback.claim(camera_id, username):
        await websocket.send_json({"type": "error", "reason": "in_use",
                                   "by": talkback.current_talker(camera_id)})
        await websocket.close()
        return

    started = time.monotonic()
    session = None
    outcome = "ok"
    try:
        target = talkback.stream_target(camera)
        if target is None:
            outcome = "no_stream"
            await websocket.send_json({"type": "error", "reason": outcome})
            return
        session = talkback.TalkSession(target)
        try:
            await session.open()
        except (OSError, TimeoutError, talkback.RtspError) as e:
            main_logger.warning("talkback: camera %s backchannel failed: %s", camera_id, e)
            outcome = "camera_refused"
            await websocket.send_json({"type": "error", "reason": outcome})
            return
        await websocket.send_json({"type": "ready"})
        while True:
            remaining = MAX_TALK_SECONDS - (time.monotonic() - started)
            try:
                msg = await asyncio.wait_for(websocket.receive(), max(remaining, 0))
            except TimeoutError:
                outcome = "time_limit"
                break
            if msg["type"] == "websocket.disconnect":
                break
            data = msg.get("bytes")
            if data:
                try:
                    await session.send_pcm(data)
                except (OSError, TimeoutError) as e:
                    main_logger.warning("talkback: camera %s send failed: %s", camera_id, e)
                    outcome = "camera_dropped"
                    break
    except WebSocketDisconnect:
        pass
    finally:
        if session is not None:
            await session.close()
        talkback.release(camera_id)
        seconds = round(time.monotonic() - started, 1)
        main_logger.info("talkback: %s talked on camera %s for %ss (%s)",
                         username, camera_id, seconds, outcome)
        with SessionLocal() as db:
            try:
                write_audit_log(
                    db, action="camera.talk", user_id=user_id, entity_type="camera",
                    entity_id=camera_id, details={"seconds": seconds, "outcome": outcome},
                    ip=ip,
                )
            except Exception as e:  # noqa: BLE001 - never fail the socket on audit
                main_logger.warning("talkback: audit write failed: %s", e)
        try:
            await websocket.close()
        except RuntimeError:
            pass
