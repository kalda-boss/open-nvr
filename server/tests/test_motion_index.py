# Copyright (c) 2026 OpenNVR
# Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0)
"""Motion index: scoring recorded clips for the timeline's motion bar. Run with:

    cd server && pytest tests/test_motion_index.py -v

Coverage:
* Pair scoring: identical frames and a uniform exposure shift are not motion,
  isolated noise pixels are eroded away, a moving object is, and a whole-frame
  flip (IR switch) scores 0.
* The one-byte encoding round-trips and caps below the day-array sentinels.
* Rasterizing keyframe pairs onto seconds, including the clip's head/tail.
* showinfo parsing and scoring raw keyframes end to end.
* The day array: scores placed at the right seconds, unscored clips PENDING,
  gaps NO_FOOTAGE, unreadable clips quiet.
* Queue order: newest unscored first; an open day first, nearest its focus.
* The /recordings/motion endpoint's payload, window checks and prioritising.
* A real ffmpeg run over a generated clip (skipped without ffmpeg).
"""

from __future__ import annotations

import asyncio
import base64
import os
import secrets
import shutil
import subprocess
import sys
import uuid as _uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import pytest
from cryptography.fernet import Fernet
from fastapi import HTTPException

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "server"))

os.environ.setdefault("DATABASE_URL", "postgresql://u:p@localhost/x")
os.environ.setdefault("SECRET_KEY", secrets.token_urlsafe(48))
os.environ.setdefault("MEDIAMTX_SECRET", secrets.token_hex(32))
os.environ.setdefault("INTERNAL_API_KEY", secrets.token_urlsafe(48))
os.environ.setdefault("CREDENTIAL_ENCRYPTION_KEY", Fernet.generate_key().decode())

sys.modules.pop("core.logging_config", None)

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

import routers.recordings as rec_router  # noqa: E402
import services.motion_index as mi  # noqa: E402
from core.database import Base  # noqa: E402
from models import Camera, Recording, Role, User  # noqa: E402

H, W = mi.ANALYSIS_HEIGHT, mi.ANALYSIS_WIDTH
DAY = datetime(2026, 10, 18, 5, 0, 0, tzinfo=UTC)  # local midnight, CDT


@pytest.fixture(autouse=True)
def _clean_queue():
    mi._priority.clear()
    mi._timeouts.clear()
    yield
    mi._priority.clear()


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    role = Role(name="admin")
    s.add(role)
    s.commit()
    owner = User(username="t", email="t@t.io", hashed_password="x", role_id=role.id)
    s.add(owner)
    s.commit()
    s.info["owner_id"] = owner.id
    yield s
    s.close()


def _camera(db) -> Camera:
    cam = Camera(name="Cam", ip_address="10.0.0.9", owner_id=db.info["owner_id"],
                 uuid=str(_uuid.uuid4()))
    db.add(cam)
    db.commit()
    return cam


def _clip(db, cam, start, seconds=60.0, motion=None, name=None) -> Recording:
    row = Recording(
        camera_id=cam.id,
        filename=name or f"{start:%H-%M-%S}.mp4",
        file_path=f"cam-{cam.id}/{start:%Y-%m-%d/%H}/{name or f'{start:%M-%S}.mp4'}",
        duration=seconds,
        start_time=start,
        end_time=start + timedelta(seconds=seconds),
        motion=motion,
    )
    db.add(row)
    db.commit()
    return row


def _scene(seed=1):
    """A textured, static 'room' so shifts and noise have something to act on."""
    rng = np.random.default_rng(seed)
    base = rng.integers(60, 190, size=(H // 8, W // 8), dtype=np.uint8)
    return np.kron(base, np.ones((8, 8), dtype=np.uint8))


# ---------------------------------------------------------------------------
# Pair scoring
# ---------------------------------------------------------------------------


def test_identical_frames_are_not_motion():
    f = _scene()
    assert mi.pair_fraction(f, f.copy()) == 0.0


def test_uniform_exposure_shift_is_not_motion():
    f = _scene()
    brighter = (f.astype(np.int16) + 35).clip(0, 255).astype(np.uint8)
    assert mi.pair_fraction(f, brighter) == 0.0


def test_isolated_noise_pixels_are_eroded():
    f = _scene()
    noisy = f.copy()
    rng = np.random.default_rng(7)
    ys = rng.integers(0, H, size=400)
    xs = rng.integers(0, W, size=400)
    noisy[ys, xs] = 255 - noisy[ys, xs]  # single pixels, flipped hard
    assert mi.pair_fraction(f, noisy) < 0.0005


def test_moving_object_is_motion():
    a, b = _scene(), _scene()
    a[40:80, 30:50] = 250  # a figure here ...
    b[40:80, 120:140] = 250  # ... then over there
    fraction = mi.pair_fraction(a, b)
    # Two 40x20 blobs changed; erosion trims a pixel off every edge.
    assert 2 * 38 * 18 / (H * W) * 0.8 < fraction < 2 * 40 * 20 / (H * W)


def test_whole_frame_flip_is_not_motion():
    # IR cut filter / lights switched: every surface changes at once.
    a = _scene()
    assert mi.pair_fraction(a, 255 - a) == 0.0


def test_encoding_round_trips_and_stays_below_sentinels():
    assert mi.encode_fraction(0) == 0
    # A byte b quantises f to within about 1/b of itself.
    for f in (0.0005, 0.002, 0.01, 0.05, 0.3):
        b = mi.encode_fraction(f)
        assert abs(mi.decode_score(b) - f) / f < 1.1 / b
    assert mi.encode_fraction(mi.SCENE_CHANGE) <= mi.MAX_SCORE < mi.PENDING
    assert mi.encode_fraction(1.0) == mi.MAX_SCORE


# ---------------------------------------------------------------------------
# Keyframe pairs -> seconds
# ---------------------------------------------------------------------------


def test_rasterize_marks_the_seconds_a_pair_spans():
    times = [0.02, 2.02, 4.02, 6.02]
    out = mi.rasterize(times, [0, 40, 0], 8.0)
    assert list(out) == [0, 0, 40, 40, 0, 0, 0, 0]


def test_rasterize_holds_the_last_pair_to_the_clip_end():
    times = [0.02, 2.02, 4.02]
    out = mi.rasterize(times, [0, 25], 6.2)
    assert list(out) == [0, 0, 25, 25, 25, 25, 25]


def test_rasterize_holds_the_first_pair_back_to_the_clip_start():
    out = mi.rasterize([1.6, 3.6], [9], 4.0)
    assert list(out) == [9, 9, 9, 9]


def test_rasterize_overlap_keeps_the_higher_score():
    # Irregular GOP: two pairs land on second 2.
    out = mi.rasterize([0.0, 2.4, 2.6, 5.0], [10, 30, 20], 5.0)
    assert out[2] == 30


def test_rasterize_without_pairs_is_quiet():
    assert mi.rasterize([0.0], [], 3.0) == bytes(3)


SHOWINFO = """\
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x.mp4':
  Duration: 00:01:02.00, start: 0.000000, bitrate: 4486 kb/s
[Parsed_showinfo_2 @ 0xaaaa] n:   0 pts:    876 pts_time:0.0243667 duration:   3600 fmt:gray
[Parsed_showinfo_2 @ 0xaaaa] n:   1 pts:  72838 pts_time:2.02329 duration:   3600 fmt:gray
[Parsed_showinfo_2 @ 0xaaaa] n:   2 pts: 144782 pts_time:4.02172 duration:   3600 fmt:gray
"""


def test_parse_showinfo():
    times, duration = mi.parse_showinfo(SHOWINFO)
    assert times == {0: 0.0243667, 1: 2.02329, 2: 4.02172}
    assert duration == 62.0


def test_score_frames_end_to_end():
    still, moved = _scene(), _scene()
    moved[40:90, 100:130] = 250
    raw = b"".join(f.tobytes() for f in (still, still, moved))
    out = mi.score_frames(raw, SHOWINFO, 6.0)
    assert len(out) == 6
    assert out[0] == out[1] == 0  # keyframes 0 -> 1: nothing moved
    assert out[2] > 0 and out[3] > 0  # 1 -> 2: the figure appeared
    assert out[4] == out[5] == out[3]  # tail holds the last pair


def test_score_frames_without_timestamps_spreads_keyframes():
    f = _scene()
    out = mi.score_frames(f.tobytes() * 3, "", 6.0)
    assert out == bytes(6)


def test_score_frames_with_no_frames_is_unreadable():
    assert mi.score_frames(b"", SHOWINFO, 62.0) == b""


# ---------------------------------------------------------------------------
# Day array
# ---------------------------------------------------------------------------


def test_day_motion_places_scores_and_marks_the_rest(db):
    cam = _camera(db)
    a = DAY + timedelta(seconds=10)
    _clip(db, cam, a, 4, motion=bytes([0, 7, 50, 0]))
    _clip(db, cam, a + timedelta(seconds=4), 3, motion=None)  # not scored yet
    _clip(db, cam, a + timedelta(seconds=20), 2, motion=b"")  # unreadable
    res = mi.day_motion(db, cam.id, DAY, DAY + timedelta(seconds=40))
    v = res["values"]
    assert len(v) == 40
    assert v[9] == mi.NO_FOOTAGE
    assert list(v[10:14]) == [0, 7, 50, 0]
    assert list(v[14:17]) == [mi.PENDING] * 3
    assert v[17] == mi.NO_FOOTAGE
    assert list(v[30:32]) == [0, 0]
    assert v[39] == mi.NO_FOOTAGE
    assert res["scored"] == 2 and res["pending"] == 1


def test_day_motion_ignores_clips_outside_the_window(db):
    cam = _camera(db)
    _clip(db, cam, DAY - timedelta(seconds=30), 60, motion=bytes([90]) * 60)
    _clip(db, cam, DAY + timedelta(seconds=100), 5, motion=bytes([90]) * 5)
    res = mi.day_motion(db, cam.id, DAY, DAY + timedelta(seconds=50))
    assert set(res["values"]) == {mi.NO_FOOTAGE}
    assert res["scored"] == 0


def test_day_motion_merges_overlapping_boundaries(db):
    cam = _camera(db)
    _clip(db, cam, DAY, 3.4, motion=bytes([5, 5, 5, 60]))
    _clip(db, cam, DAY + timedelta(seconds=3.4), 2, motion=bytes([9, 9]))
    v = mi.day_motion(db, cam.id, DAY, DAY + timedelta(seconds=6))["values"]
    assert list(v[:5]) == [5, 5, 5, 60, 9]


# ---------------------------------------------------------------------------
# Queue order
# ---------------------------------------------------------------------------


def test_next_batch_is_newest_unscored_first(db):
    cam = _camera(db)
    old = _clip(db, cam, DAY, motion=None)
    _clip(db, cam, DAY + timedelta(minutes=1), motion=b"\x00")
    new = _clip(db, cam, DAY + timedelta(minutes=2), motion=None)
    assert [c.id for c in mi.next_batch(db, 10)] == [new.id, old.id]


def test_an_open_day_goes_first_nearest_its_focus(db):
    a, b = _camera(db), _camera(db)
    for m in range(5):
        _clip(db, a, DAY + timedelta(minutes=m))
    newest_elsewhere = _clip(db, b, DAY + timedelta(days=1))
    mi.prioritize(a.id, DAY, DAY + timedelta(days=1),
                  focus=DAY + timedelta(minutes=3, seconds=10))
    batch = mi.next_batch(db, 3)
    starts = [db.get(Recording, c.id).start_time.replace(tzinfo=UTC) for c in batch]
    assert starts == [DAY + timedelta(minutes=m) for m in (3, 4, 2)]
    assert newest_elsewhere.id not in {c.id for c in batch}


def test_open_days_share_a_playhead_and_fill_in_together(db):
    # A camera grid: two days open with the same focus. Clips nearest it
    # come first on BOTH cameras, not one camera's whole day first.
    a, b = _camera(db), _camera(db)
    for m in range(6):
        _clip(db, a, DAY + timedelta(minutes=m))
        _clip(db, b, DAY + timedelta(minutes=m))
    focus = DAY + timedelta(minutes=2, seconds=30)
    mi.prioritize(a.id, DAY, DAY + timedelta(days=1), focus=focus)
    mi.prioritize(b.id, DAY, DAY + timedelta(days=1), focus=focus)
    batch = mi.next_batch(db, 4)
    assert {c.camera_id for c in batch} == {a.id, b.id}
    starts = {db.get(Recording, c.id).start_time.replace(tzinfo=UTC) for c in batch}
    assert starts == {DAY + timedelta(minutes=2), DAY + timedelta(minutes=3)}


def test_a_day_opened_without_focus_goes_newest_first(db):
    cam = _camera(db)
    for m in range(4):
        _clip(db, cam, DAY + timedelta(minutes=m))
    mi.prioritize(cam.id, DAY, DAY + timedelta(minutes=10))
    starts = [db.get(Recording, c.id).start_time.replace(tzinfo=UTC)
              for c in mi.next_batch(db, 2)]
    assert starts == [DAY + timedelta(minutes=3), DAY + timedelta(minutes=2)]


def test_a_finished_or_expired_window_drops_out(db, monkeypatch):
    cam = _camera(db)
    other = _clip(db, cam, DAY + timedelta(days=3))
    mi.prioritize(cam.id, DAY, DAY + timedelta(days=1))
    # Nothing unscored in the window: falls through to the global queue.
    assert [c.id for c in mi.next_batch(db, 5)] == [other.id]
    assert mi._priority == {}

    inside = _clip(db, cam, DAY + timedelta(minutes=1))
    mi.prioritize(cam.id, DAY, DAY + timedelta(days=1))
    real = mi.time.monotonic
    monkeypatch.setattr(mi.time, "monotonic",
                        lambda: real() + mi.PRIORITY_TTL_SECONDS + 1)
    assert [c.id for c in mi.next_batch(db, 1)] == [other.id]
    assert inside.id  # still unscored, just no longer at the front


def test_store_scores_writes_and_tolerates_deleted_clips(db):
    cam = _camera(db)
    row = _clip(db, cam, DAY)
    mi.store_scores(db, [(row.id, b"\x01\x02"), (row.id + 99, b"\x03")])
    db.expire_all()
    assert db.get(Recording, row.id).motion == b"\x01\x02"
    assert mi.next_batch(db, 5) == []


def test_missing_file_with_a_healthy_archive_is_unreadable(tmp_path):
    (tmp_path / "cam-1").mkdir()
    clip = mi._Clip(1, 1, "cam-1/2026-10-18/05/00-00-000000.mp4", 60.0)
    out = asyncio.run(mi._score(asyncio.Semaphore(1), tmp_path, clip))
    assert out == b""


def test_missing_archive_is_retried_later(tmp_path):
    clip = mi._Clip(1, 1, "cam-1/2026-10-18/05/00-00-000000.mp4", 60.0)
    with pytest.raises(mi.ClipUnavailableError):
        asyncio.run(mi._score(asyncio.Semaphore(1), tmp_path / "unmounted", clip))


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


class _Superuser:
    id = 1
    is_superuser = True
    is_active = True


def _call(db, cam, monkeypatch, **params):
    async def _auth(request, session):
        return _Superuser()

    monkeypatch.setattr(rec_router, "_authenticate_request", _auth)
    args = {"date": None, "start": None, "end": None, "tz": None, "focus": None}
    args.update(params)
    return asyncio.run(
        rec_router.get_day_motion(camera_id=cam.id, request=None, db=db, **args)
    )


def test_endpoint_serves_the_window_and_prioritises_it(db, monkeypatch):
    cam = _camera(db)
    _clip(db, cam, DAY, 3, motion=bytes([0, 30, 0]))
    _clip(db, cam, DAY + timedelta(seconds=3), 2)
    end = DAY + timedelta(seconds=10)
    out = _call(db, cam, monkeypatch, start="2026-10-18T05:00:00Z",
                end="2026-10-18T05:00:10Z", focus="2026-10-18T05:00:04Z")
    assert out["start"] == "2026-10-18T05:00:00Z" and out["step"] == 1
    values = base64.b64decode(out["values"])
    assert list(values[:5]) == [0, 30, 0, mi.PENDING, mi.PENDING]
    assert out["pending"] == 1 and out["scored"] == 1
    focus, _ = mi._priority[(cam.id, DAY, end)]
    assert focus == DAY + timedelta(seconds=4)


def test_endpoint_does_not_prioritise_a_fully_scored_day(db, monkeypatch):
    cam = _camera(db)
    _clip(db, cam, DAY, 3, motion=bytes(3))
    out = _call(db, cam, monkeypatch, start="2026-10-18T05:00:00Z",
                end="2026-10-18T05:00:10Z")
    assert out["pending"] == 0 and mi._priority == {}


def test_endpoint_rejects_oversized_or_inverted_windows(db, monkeypatch):
    cam = _camera(db)
    for start, end in (("2026-10-18T00:00:00Z", "2026-10-21T00:00:00Z"),
                       ("2026-10-18T05:00:00Z", "2026-10-18T04:00:00Z")):
        with pytest.raises(HTTPException) as e:
            _call(db, cam, monkeypatch, start=start, end=end)
        assert e.value.status_code == 400


def test_day_window_reads_offsetless_instants_as_utc():
    _, start, end = rec_router._day_window(
        None, "2026-10-18T05:00:00", "2026-10-19T05:00:00", None
    )
    assert start == DAY and end == DAY + timedelta(days=1)


# ---------------------------------------------------------------------------
# Real ffmpeg
# ---------------------------------------------------------------------------


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_analyze_clip_on_a_generated_recording(tmp_path):
    # 6 s at 10 fps, a keyframe every second; the box sits still for 3 s,
    # then slides right.
    clip = tmp_path / "clip.mp4"
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-i",
            "color=c=0x606060:s=320x180:r=10:d=6[bg];"
            "color=c=white:s=40x50:r=10:d=6[box];"
            "[bg][box]overlay=x='if(lt(t,3),40,40+(t-3)*60)':y=60",
            "-c:v", "mpeg4", "-q:v", "3", "-g", "10", "-keyint_min", "10",
            str(clip),
        ],
        check=True,
    )
    out = asyncio.run(mi.analyze_clip(clip, None))
    assert len(out) == 6
    assert list(out[:3]) == [0, 0, 0]
    assert all(v > 20 for v in out[3:])


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_analyze_clip_on_garbage_is_unreadable(tmp_path):
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"not a video" * 100)
    assert asyncio.run(mi.analyze_clip(bad, 60.0)) == b""
