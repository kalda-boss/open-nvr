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

"""Motion activity index for recorded footage.

Every recorded clip gets a per-second motion score, measured from the clip
itself. It exists for all footage, whatever recorded it and whether or not
live detection runs (a CPU-bound box sets DETECT_PIPELINE_ENABLED=false and
then has no other motion signal). The playback timeline draws it as the
motion bar, and "next/previous activity" jumps along it.

How a clip is scored
--------------------
ffmpeg decodes only the KEYFRAMES (``-skip_frame nokey``): one frame per GOP,
2 s on a typical camera, at a few percent of a full decode's CPU (about 1.2 s
for a minute of 2688x1520 HEVC). Each keyframe is area-scaled to 256x144 luma,
and that averaging is what makes sensor noise disappear. Each keyframe is then
compared with the one before it:

* the frame-wide median shift is removed first, so auto-exposure drift is not
  motion;
* a pixel has changed when it moved more than ``PIXEL_DELTA`` levels;
* a cross-shaped erosion drops isolated changed pixels (noise, OSD digits);
* the score is the changed fraction of the frame. Above ``SCENE_CHANGE`` the
  whole picture flipped (IR cut filter, lights switched), which is not motion,
  so the pair scores 0.

A fraction ``f`` is stored as ``round(255 * sqrt(f))`` in one byte, which keeps
most of the resolution where people are: someone crossing a wide shot changes
0.1-5 % of it. Byte ``i`` of ``recordings.motion`` covers second ``i`` of the
clip; a keyframe pair marks every second between its two frames.

Scheduling
----------
One background loop keeps the index current. It scores the newest clips first,
so fresh footage is scored about a minute after it is written, and otherwise
backfills older clips. A day someone has open in the player goes to the front
of the queue (:func:`prioritize`), starting nearest the playhead. ffmpeg runs
under ``nice`` with one thread per job, so ``MOTION_INDEX_WORKERS`` bounds the
CPU this can take.
"""

from __future__ import annotations

import asyncio
import contextlib
import math
import re
import shutil
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from core.config import settings
from core.logging_config import recording_logger

#: Size every keyframe is scaled to before comparing. Fixed (aspect is
#: irrelevant to change detection), so a frame is always this many bytes.
ANALYSIS_WIDTH = 256
ANALYSIS_HEIGHT = 144
FRAME_BYTES = ANALYSIS_WIDTH * ANALYSIS_HEIGHT

#: Luma levels a pixel must move by, after removing the frame-wide shift.
PIXEL_DELTA = 20
#: Changed fraction above which a pair is a whole-scene flip, not motion.
#: Frigate's lightning threshold, for the same reason.
SCENE_CHANGE = 0.8

#: Largest byte a clip can store; SCENE_CHANGE already caps real scores at
#: round(255 * sqrt(0.8)) = 228. The day array uses the two values above it.
MAX_SCORE = 253
#: Day-array cell inside a clip that has not been scored yet.
PENDING = 254
#: Day-array cell with no recorded clip.
NO_FOOTAGE = 255

#: Kill an ffmpeg that takes longer than this on one clip (a wedged mount).
FFMPEG_TIMEOUT_SECONDS = 120
#: Timeouts on the same clip before it is given up on (stored empty).
MAX_TIMEOUTS_PER_CLIP = 2
#: Sleep when there is nothing to score; a prioritize() call wakes it early.
IDLE_SECONDS = 20
#: Back-off when the recordings root looks unmounted or ffmpeg is stuck.
UNAVAILABLE_BACKOFF_SECONDS = 300
#: How long an open day stays at the front of the queue without a refresh.
#: The player re-requests it every few seconds while it is being scored.
PRIORITY_TTL_SECONDS = 120
#: Let recording and provisioning settle before the first batch.
STARTUP_DELAY_SECONDS = 45

_PTS_RE = re.compile(r"\bn:\s*(\d+)\s+pts:\s*\S+\s+pts_time:(-?[0-9.]+)")
_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):([0-9.]+)")


# ---------------------------------------------------------------------------
# Scoring (pure; numpy is imported lazily so importing this module is free)
# ---------------------------------------------------------------------------


def pair_fraction(prev, cur) -> float:
    """Changed fraction of the frame between two keyframes (uint8 HxW)."""
    import numpy as np

    d = cur.astype(np.int16) - prev.astype(np.int16)
    # Auto-exposure moves every pixel by about the same amount; the median
    # is that shift wherever under half the frame truly changed.
    d -= np.int16(np.median(d))
    m = np.abs(d) > PIXEL_DELTA
    if np.count_nonzero(m) > SCENE_CHANGE * m.size:
        return 0.0
    # A pixel survives only if its four neighbours changed too.
    kept = m[1:-1, 1:-1] & m[:-2, 1:-1] & m[2:, 1:-1] & m[1:-1, :-2] & m[1:-1, 2:]
    return float(np.count_nonzero(kept)) / m.size


def encode_fraction(fraction: float) -> int:
    """One byte for a changed fraction: ``round(255 * sqrt(f))``."""
    if fraction <= 0:
        return 0
    return min(MAX_SCORE, round(255 * math.sqrt(fraction)))


def decode_score(score: int) -> float:
    """Inverse of :func:`encode_fraction` (for callers that want a fraction)."""
    return (score / 255) ** 2


def rasterize(times: list[float], scores: list[int], duration: float) -> bytes:
    """One byte per second of the clip from keyframe-pair scores.

    ``times[i]`` is keyframe ``i``'s offset into the clip (s); ``scores[i]``
    measures the change between keyframes ``i`` and ``i + 1``, so it covers
    ``[times[i], times[i + 1])``. Where a second is covered twice the higher
    score wins. Before the first and after the last keyframe no pair spans
    the time, so those seconds take the nearest pair's score: motion that
    crosses a clip boundary stays continuous on the timeline.
    """
    n = max(1, math.ceil(duration - 1e-6)) if duration and duration > 0 else 0
    if n == 0 and times:
        n = max(1, math.ceil(times[-1]) + 1)
    out = bytearray(n)
    if not scores or n == 0:
        return bytes(out)
    for i, v in enumerate(scores):
        if v <= 0:
            continue
        a = max(0, round(times[i]))
        b = min(n, max(a + 1, round(times[i + 1])))
        for s in range(a, b):
            if v > out[s]:
                out[s] = v
    for s in range(0, min(n, round(times[0]))):
        out[s] = max(out[s], scores[0])
    for s in range(max(0, round(times[-1])), n):
        out[s] = max(out[s], scores[-1])
    return bytes(out)


def parse_showinfo(stderr: str) -> tuple[dict[int, float], float | None]:
    """Frame offsets (``n -> pts_time``) and the container duration."""
    times: dict[int, float] = {}
    for m in _PTS_RE.finditer(stderr):
        try:
            times[int(m.group(1))] = float(m.group(2))
        except ValueError:
            continue
    duration = None
    dm = _DURATION_RE.search(stderr)
    if dm:
        h, mi, s = dm.groups()
        duration = int(h) * 3600 + int(mi) * 60 + float(s)
    return times, duration


def score_frames(raw: bytes, stderr: str, duration: float | None) -> bytes:
    """Per-second motion bytes from ffmpeg's raw keyframes and its log."""
    import numpy as np

    count = len(raw) // FRAME_BYTES
    times_by_n, container_duration = parse_showinfo(stderr)
    duration = duration or container_duration
    if count == 0:
        return b""
    frames = np.frombuffer(raw[: count * FRAME_BYTES], np.uint8).reshape(
        count, ANALYSIS_HEIGHT, ANALYSIS_WIDTH
    )
    times = [times_by_n.get(i) for i in range(count)]
    if any(t is None for t in times):
        # No usable timestamps: spread the keyframes evenly over the clip.
        span = duration or float(count)
        times = [i * span / count for i in range(count)]
    scores = [
        encode_fraction(pair_fraction(frames[i - 1], frames[i]))
        for i in range(1, count)
    ]
    return rasterize(times, scores, duration or (times[-1] + 1.0))


def ffmpeg_command(path: str) -> list[str]:
    cmd = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "info",
        # One decode thread: N workers never use more than N cores.
        "-threads", "1",
        "-discard:v", "nokey", "-skip_frame", "nokey",
        "-i", path,
        "-map", "0:v:0",
        "-vf", (
            f"scale={ANALYSIS_WIDTH}:{ANALYSIS_HEIGHT}:flags=area,"
            "format=gray,showinfo"
        ),
        "-fps_mode", "passthrough",
        "-f", "rawvideo", "pipe:1",
    ]
    nice = shutil.which("nice")
    return [nice, "-n", "15", *cmd] if nice else cmd


class ClipUnavailableError(Exception):
    """The clip could not be read for a reason that may pass (retry later)."""


async def analyze_clip(path: Path, duration: float | None) -> bytes:
    """Score one clip. ``b""`` means it can never be scored (unreadable)."""
    proc = await asyncio.create_subprocess_exec(
        *ffmpeg_command(str(path)),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        raw, err = await asyncio.wait_for(
            proc.communicate(), timeout=FFMPEG_TIMEOUT_SECONDS
        )
    except TimeoutError:
        raise ClipUnavailableError(f"ffmpeg timed out on {path}") from None
    finally:
        # Timeout or shutdown: never leave an ffmpeg behind.
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
    text = err.decode("utf-8", "replace")
    if proc.returncode != 0 and len(raw) < FRAME_BYTES:
        recording_logger.debug(
            f"Motion index: ffmpeg could not read {path}: {text[-300:]}"
        )
        return b""
    # numpy work is a few ms; off the loop all the same.
    return await asyncio.to_thread(score_frames, raw, text, duration)


# ---------------------------------------------------------------------------
# Day view (what the API serves)
# ---------------------------------------------------------------------------


def day_motion(db, camera_id: int, start_utc: datetime, end_utc: datetime) -> dict:
    """One byte per second of ``[start_utc, end_utc)`` for one camera.

    Cells hold a clip's score (``0..MAX_SCORE``), ``PENDING`` inside a clip
    not scored yet, or ``NO_FOOTAGE``. Clips are selected exactly like the
    timeline's footage blocks (``start_time`` inside the window), so the two
    always line up.
    """
    from models import Recording

    cells = max(0, math.ceil((end_utc - start_utc).total_seconds()))
    out = bytearray([NO_FOOTAGE]) * cells
    rows = (
        db.query(Recording.start_time, Recording.end_time, Recording.duration,
                 Recording.motion)
        .filter(
            Recording.camera_id == camera_id,
            Recording.start_time >= start_utc,
            Recording.start_time < end_utc,
        )
        .order_by(Recording.start_time.asc())
        .all()
    )
    scored = pending = 0
    for start, end, duration, motion in rows:
        if start.tzinfo is None:
            start = start.replace(tzinfo=UTC)
        offset = (start - start_utc).total_seconds()
        base = int(offset + 0.5)
        if motion is None:
            pending += 1
            if end is not None:
                if end.tzinfo is None:
                    end = end.replace(tzinfo=UTC)
                length = (end - start).total_seconds()
            else:
                length = float(duration or 0)
            stop = min(cells, int(offset + length + 0.5))
            for i in range(max(0, base), stop):
                if out[i] == NO_FOOTAGE:
                    out[i] = PENDING
            continue
        scored += 1
        if not motion:
            # Unreadable clip: footage exists, its motion is unknown — show
            # it as quiet rather than as "still analysing" forever.
            length = float(duration or 0)
            motion = bytes(max(0, int(length + 0.5)))
        lo, hi = max(0, base), min(cells, base + len(motion))
        if lo >= hi:
            continue
        chunk = motion[lo - base: hi - base]
        current = out[lo:hi]
        if all(c >= PENDING for c in current):
            out[lo:hi] = chunk
        else:
            # Clips meet (or overlap by a cell) at their boundaries.
            for j, v in enumerate(chunk):
                c = current[j]
                out[lo + j] = v if c >= PENDING else max(c, v)
    return {"values": bytes(out), "scored": scored, "pending": pending}


# ---------------------------------------------------------------------------
# Background indexer
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _Clip:
    id: int
    camera_id: int
    file_path: str
    duration: float | None


#: (camera_id, start, end) -> (focus instant or None, expiry monotonic time).
#: Written by request handlers, read by the batch query in a worker thread.
_priority: dict[tuple[int, datetime, datetime], tuple[datetime | None, float]] = {}
_priority_lock = threading.Lock()
_wake: asyncio.Event | None = None
#: Clip id -> ffmpeg timeouts seen, so one bad file cannot stall the queue.
_timeouts: dict[int, int] = {}


def prioritize(
    camera_id: int, start: datetime, end: datetime, focus: datetime | None = None
) -> None:
    """Score this camera's clips in ``[start, end)`` before anything else,
    nearest ``focus`` first. Called by the motion API for an open day."""
    with _priority_lock:
        _priority[(camera_id, start, end)] = (
            focus, time.monotonic() + PRIORITY_TTL_SECONDS
        )
    if _wake is not None:
        _wake.set()


def _distance(start: datetime, focus: datetime) -> float:
    if start.tzinfo is None:
        start = start.replace(tzinfo=UTC)
    return abs((start - focus).total_seconds())


def next_batch(db, limit: int) -> list[_Clip]:
    """Clips to score next: those of open days first, else the newest.

    Open days are interleaved nearest their focus, so a camera grid sharing
    one playhead fills in around it on every camera at once; a day opened
    without a focus goes newest first.
    """
    from models import Recording

    cols = (Recording.id, Recording.camera_id, Recording.file_path,
            Recording.duration, Recording.start_time)
    now = time.monotonic()
    with _priority_lock:
        for key in [k for k, (_, expiry) in _priority.items() if expiry < now]:
            del _priority[key]
        windows = list(_priority.items())
    candidates: list[tuple[float, _Clip]] = []
    for (camera_id, start, end), (focus, _) in windows:
        rows = (
            db.query(*cols)
            .filter(
                Recording.camera_id == camera_id,
                Recording.start_time >= start,
                Recording.start_time < end,
                Recording.motion.is_(None),
            )
            .all()
        )
        if not rows:
            with _priority_lock:
                _priority.pop((camera_id, start, end), None)
            continue
        anchor = focus or end
        candidates.extend(
            (_distance(r.start_time, anchor),
             _Clip(r.id, r.camera_id, r.file_path, r.duration))
            for r in rows
        )
    if candidates:
        candidates.sort(key=lambda kv: kv[0])
        return [clip for _, clip in candidates[:limit]]
    rows = (
        db.query(*cols)
        .filter(Recording.motion.is_(None))
        .order_by(Recording.start_time.desc())
        .limit(limit)
        .all()
    )
    return [_Clip(r.id, r.camera_id, r.file_path, r.duration) for r in rows]


def store_scores(db, results: list[tuple[int, bytes]]) -> None:
    """Write scores; a clip deleted meanwhile (retention) just matches nothing."""
    from models import Recording

    for clip_id, motion in results:
        db.query(Recording).filter(Recording.id == clip_id).update(
            {Recording.motion: motion}, synchronize_session=False
        )
    db.commit()


def _root_available(root: Path) -> bool:
    """False when the recordings root looks unmounted (no camera dirs)."""
    try:
        return any(p.name.startswith("cam-") for p in root.iterdir())
    except OSError:
        return False


async def _score(sem: asyncio.Semaphore, root: Path, clip: _Clip) -> bytes | None:
    """The clip's bytes, or None to leave it unscored for now."""
    path = root / clip.file_path
    async with sem:
        exists = await asyncio.to_thread(path.is_file)
        if not exists:
            # A clip retention or an operator already deleted (the reconciler
            # drops its row) — unless the whole archive is missing, which is
            # an unplugged drive and must not mark everything unreadable.
            if not await asyncio.to_thread(_root_available, root):
                raise ClipUnavailableError(f"recordings root {root} unavailable")
            return b""
        try:
            return await analyze_clip(path, clip.duration)
        except ClipUnavailableError:
            seen = _timeouts.get(clip.id, 0) + 1
            _timeouts[clip.id] = seen
            if seen >= MAX_TIMEOUTS_PER_CLIP:
                _timeouts.pop(clip.id, None)
                recording_logger.warning(
                    f"Motion index: giving up on {clip.file_path} after {seen} "
                    "ffmpeg timeouts"
                )
                return b""
            raise


def _batch_with_root(limit: int) -> tuple[list[_Clip], Path]:
    from core.database import SessionLocal
    from services.storage_service import get_effective_recordings_base_path

    db = SessionLocal()
    try:
        return next_batch(db, limit), Path(get_effective_recordings_base_path(db))
    finally:
        db.close()


def _store(results: list[tuple[int, bytes]]) -> None:
    from core.database import SessionLocal

    db = SessionLocal()
    try:
        store_scores(db, results)
    finally:
        db.close()


async def run_motion_index_loop() -> None:
    """Keep ``recordings.motion`` current. Scheduled from the app lifespan."""
    global _wake

    if not settings.motion_index_enabled:
        recording_logger.info("Motion index disabled (MOTION_INDEX_ENABLED=false)")
        return
    if shutil.which("ffmpeg") is None:
        recording_logger.warning("Motion index off: ffmpeg is not installed")
        return
    try:
        import numpy  # noqa: F401
    except ImportError:
        recording_logger.warning("Motion index off: numpy is not installed")
        return

    workers = max(1, int(settings.motion_index_workers))
    sem = asyncio.Semaphore(workers)
    _wake = asyncio.Event()
    recording_logger.info(f"Motion index started ({workers} worker(s))")
    await asyncio.sleep(STARTUP_DELAY_SECONDS)

    scored_since_log = 0
    last_log = time.monotonic()
    while True:
        try:
            batch, root = await asyncio.to_thread(_batch_with_root, workers * 4)
        except Exception as e:
            recording_logger.error(f"Motion index query failed: {e}", exc_info=True)
            await asyncio.sleep(60)
            continue

        if not batch:
            _wake.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(_wake.wait(), timeout=IDLE_SECONDS)
            continue

        results = await asyncio.gather(
            *(_score(sem, root, clip) for clip in batch), return_exceptions=True
        )
        done: list[tuple[int, bytes]] = []
        unavailable = None
        for clip, res in zip(batch, results, strict=True):
            if isinstance(res, ClipUnavailableError):
                unavailable = res
            elif isinstance(res, asyncio.CancelledError):
                raise res
            elif isinstance(res, BaseException):
                recording_logger.error(
                    f"Motion index failed on {clip.file_path}: {res!r}"
                )
                done.append((clip.id, b""))
            elif res is not None:
                done.append((clip.id, res))
        if done:
            try:
                await asyncio.to_thread(_store, done)
                scored_since_log += len(done)
            except Exception as e:
                recording_logger.error(
                    f"Motion index write failed: {e}", exc_info=True
                )
                await asyncio.sleep(60)
        if unavailable is not None:
            recording_logger.warning(
                f"Motion index paused for {UNAVAILABLE_BACKOFF_SECONDS}s: "
                f"{unavailable}"
            )
            await asyncio.sleep(UNAVAILABLE_BACKOFF_SECONDS)
        if time.monotonic() - last_log >= 600 and scored_since_log:
            recording_logger.info(
                f"Motion index: scored {scored_since_log} clip(s) in the last "
                f"{int(time.monotonic() - last_log)}s"
            )
            scored_since_log = 0
            last_log = time.monotonic()
