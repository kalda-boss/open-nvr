# Copyright (c) 2026 OpenNVR
# Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0)
"""Storage cap, implausible disk readings, and file_size indexing. Run with:

    cd server && pytest tests/test_storage_cap.py -v

Coverage:
* disk_reading_problem: the 32-bit-wrapped reading a >16 TiB macOS volume
  gives through Docker Desktop is rejected; a sane one passes.
* Storage cap: purges oldest-first down to cap - hysteresis, never footage
  newer than 24 h, never flagged footage; rows with no size stop it.
* Regression: a free-space floor bigger than the reported disk no longer
  wipes recordings.
* segment-complete stores file_size when MediaMTX's recordPath is relative
  to a different working dir than core's.
* The reconciler fills in a missing file_size.
* The system monitor withholds an implausible disk reading.
"""

from __future__ import annotations

import asyncio
import os
import secrets
import sys
import time
from collections import namedtuple
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from cryptography.fernet import Fernet

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

import services.camera_identity as ci  # noqa: E402
import services.retention_service as rs  # noqa: E402
import services.storage_service as ss  # noqa: E402
import services.system_monitor_service as sms  # noqa: E402
from core.database import Base  # noqa: E402
from models import Camera, Recording, Role, User  # noqa: E402
from services.recording_reconciler import reconcile_camera  # noqa: E402
from services.retention_service import RetentionService  # noqa: E402
from services.storage_service import disk_reading_problem  # noqa: E402

GB = 1024**3
# What the container saw on the 18 TB drive: 32-bit-wrapped block counts.
Usage = namedtuple("Usage", "total used free")
WRAPPED = Usage(total=int(407.8 * GB), used=int(30 * GB), free=int(377.8 * GB))


@pytest.fixture(autouse=True)
def _utc_tz(monkeypatch):
    import services.recording_paths as rp

    monkeypatch.setattr(rp, "get_recording_tz", lambda: UTC)
    ci.reset_ingest_cache()


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


@pytest.fixture
def no_events(monkeypatch):
    """Keep the edge/event writers away from the global SessionLocal."""
    calls: list[tuple] = []
    monkeypatch.setattr(
        RetentionService,
        "_set_cap_exhausted",
        staticmethod(lambda *a, **k: calls.append((a, k))),
    )
    monkeypatch.setattr(
        RetentionService, "_set_purge_exhausted", staticmethod(lambda *a, **k: None)
    )
    monkeypatch.setattr(
        RetentionService, "_record_purge_event", staticmethod(lambda *a, **k: None)
    )
    return calls


def _add_camera(db, created_at=None):
    import uuid as _uuid

    cam = Camera(
        name="Cam",
        ip_address="10.0.0.9",
        owner_id=db.info["owner_id"],
        uuid=str(_uuid.uuid4()),
    )
    db.add(cam)
    db.commit()
    if created_at is not None:
        cam.created_at = created_at
        db.commit()
    db.refresh(cam)
    return cam


def _rows(db, n, *, age=timedelta(days=2), size=GB, flagged=False, start=0):
    """n one-minute recordings, oldest first, the newest `age` old."""
    now = datetime.now(UTC)
    for i in range(n):
        db.add(
            Recording(
                camera_id=1,
                filename=f"{start + i}.mp4",
                file_path=f"cam-1/{start + i}.mp4",
                file_size=size,
                start_time=now - age - timedelta(minutes=n - i),
                is_flagged=flagged,
            )
        )
    db.commit()


def _names(db):
    return sorted(int(r.filename.split(".")[0]) for r in db.query(Recording).all())


# ------------------------------------------------------------ plausibility


def test_wrapped_reading_rejected_by_cap():
    problem = disk_reading_problem(WRAPPED.total, WRAPPED.used, 0, 16000)
    assert problem and "16000 GB storage cap" in problem


def test_wrapped_reading_rejected_by_free_space_floor():
    problem = disk_reading_problem(WRAPPED.total, WRAPPED.used, 0, None, 500)
    assert problem and "500 GB minimum-free-space floor" in problem


def test_reading_smaller_than_index_rejected():
    assert disk_reading_problem(WRAPPED.total, WRAPPED.used, 500 * GB, None)


def test_negative_used_rejected():
    assert disk_reading_problem(WRAPPED.total, -5 * GB, 0, None)


def test_sane_reading_passes():
    assert disk_reading_problem(18000 * GB, 1000 * GB, 900 * GB, 16000, 500) is None


# --------------------------------------------------------------- size cap


def test_cap_noop_when_under(db, tmp_path, no_events):
    _rows(db, 5)
    assert RetentionService._cleanup_by_size_cap(db, tmp_path, 10, True) is None
    assert db.query(Recording).count() == 5


def test_cap_purges_oldest_down_to_hysteresis(db, tmp_path, no_events):
    _rows(db, 12)  # 12 GB indexed, cap 10 GB, target 10 - 5 = 5 GB
    stats = RetentionService._cleanup_by_size_cap(db, tmp_path, 10, True)
    assert stats["deleted_records"] == 7
    assert _names(db) == [7, 8, 9, 10, 11]
    assert stats["indexed_gb_after"] == 5.0
    assert not stats.get("exhausted")
    # Recovered edge written, not an exhausted one.
    assert no_events[-1][0][0] is False


def test_cap_deletes_matching_files(db, tmp_path, no_events):
    _rows(db, 12)
    for i in range(12):
        (tmp_path / "cam-1").mkdir(exist_ok=True)
        (tmp_path / "cam-1" / f"{i}.mp4").write_bytes(b"x")
    RetentionService._cleanup_by_size_cap(db, tmp_path, 10, True)
    assert sorted(p.name for p in (tmp_path / "cam-1").iterdir()) == [
        f"{i}.mp4" for i in (10, 11, 7, 8, 9)
    ]


def test_cap_never_deletes_last_24h(db, tmp_path, no_events):
    _rows(db, 3, start=0)  # 2 days old
    _rows(db, 12, age=timedelta(hours=1), start=100)  # recent
    stats = RetentionService._cleanup_by_size_cap(db, tmp_path, 10, True)
    assert _names(db) == list(range(100, 112))
    assert stats["exhausted"] is True
    assert no_events[-1][0][0] is True
    assert "24 h" in no_events[-1][1]["description"]


def test_cap_skips_flagged(db, tmp_path, no_events):
    _rows(db, 4, flagged=True, start=0)
    _rows(db, 8, age=timedelta(days=1, hours=1), start=100)
    RetentionService._cleanup_by_size_cap(db, tmp_path, 10, True)
    remaining = _names(db)
    assert remaining[:4] == [0, 1, 2, 3]
    assert len(remaining) == 5


def test_cap_stops_on_sizeless_rows(db, tmp_path, no_events):
    _rows(db, 3, size=None, start=0)
    _rows(db, 12, age=timedelta(days=1, hours=1), start=100)
    # Batch of 3 sizeless + 12 sized: the sized ones still bring it down.
    RetentionService._cleanup_by_size_cap(db, tmp_path, 10, True)
    assert len(_names(db)) == 5

    db.query(Recording).delete()
    db.commit()
    _rows(db, 600, size=None, start=0)
    _rows(db, 12, age=timedelta(days=1, hours=1), start=1000)
    # A whole batch with no sizes: stop instead of deleting blind.
    stats = RetentionService._cleanup_by_size_cap(db, tmp_path, 10, True)
    assert stats["exhausted"] is True
    assert db.query(Recording).count() == 612


# ------------------------------------------------------- pressure loop


def _settings(monkeypatch, **kw):
    base = {
        "retention_days": 50,
        "protect_flagged": True,
        "min_free_space_gb": None,
        "max_storage_gb": None,
        "purge_orphaned_under_pressure": False,
    }
    base.update(kw)
    monkeypatch.setattr(
        RetentionService, "_get_retention_settings", staticmethod(lambda _db: base)
    )


def test_wrapped_disk_no_longer_wipes_recordings(db, tmp_path, monkeypatch, no_events):
    """2026-10-17: min_free_space_gb=500 against a drive reading 407.8 GB
    deleted every clip once a minute."""
    _rows(db, 20)
    _settings(monkeypatch, min_free_space_gb=500)
    monkeypatch.setattr(rs, "get_effective_recordings_base_path", lambda _db: str(tmp_path))
    monkeypatch.setattr(rs.shutil, "disk_usage", lambda _p: WRAPPED)

    assert RetentionService.check_disk_pressure(db) is None
    assert db.query(Recording).count() == 20


def test_pressure_loop_runs_cap(db, tmp_path, monkeypatch, no_events):
    _rows(db, 12)
    _settings(monkeypatch, max_storage_gb=10)
    monkeypatch.setattr(rs, "get_effective_recordings_base_path", lambda _db: str(tmp_path))

    stats = RetentionService.check_disk_pressure(db)
    assert stats["deleted_records"] == 7
    assert db.query(Recording).count() == 5


def test_daily_sweep_runs_cap_with_zero_retention(db, tmp_path, monkeypatch, no_events):
    _rows(db, 12)
    _settings(monkeypatch, retention_days=0, max_storage_gb=10)
    monkeypatch.setattr(rs, "get_effective_recordings_base_path", lambda _db: str(tmp_path))
    monkeypatch.setattr(
        RetentionService, "cleanup_auxiliary", staticmethod(lambda *a, **k: {})
    )
    monkeypatch.setattr(RetentionService, "cleanup_evidence", staticmethod(lambda *a: 0))

    stats = RetentionService.cleanup_old_recordings(db)
    assert stats["deleted_records"] == 7


# ------------------------------------------------------- file_size indexing


def test_segment_complete_stores_size_across_working_dirs(db, tmp_path, monkeypatch):
    """MediaMTX sends recordPath relative to ITS cwd ("./app/recordings/...");
    core's cwd differs, so the size must be read via the recordings root."""
    from fastapi import BackgroundTasks
    from starlette.requests import Request

    import routers.mediamtx_hooks as hooks
    from core.config import settings

    cam = _add_camera(db)
    root = tmp_path / "recordings"
    rel = f"cam-{cam.id}/2026-10-17/12/48-00-000000.mp4"
    (root / rel).parent.mkdir(parents=True)
    (root / rel).write_bytes(b"x" * 4321)
    core_cwd = tmp_path / "core"
    core_cwd.mkdir()
    monkeypatch.chdir(core_cwd)
    monkeypatch.setattr(ss, "get_effective_recordings_base_path", lambda _db: str(root))
    monkeypatch.setattr(ci, "verify_segment_identity", lambda *a: True)

    req = Request({
        "type": "http",
        "method": "GET",
        "path": "/",
        "query_string": b"",
        "headers": [(b"x-mtx-secret", settings.mediamtx_secret.encode())],
    })
    out = asyncio.run(
        hooks.hook_segment_complete(
            req,
            BackgroundTasks(),
            path=f"cam-{cam.id}",
            segment_path=f"./app/recordings/{rel}",
            segment_duration="60s",
            db=db,
        )
    )
    assert out["recording_id"] is not None
    row = db.query(Recording).one()
    assert row.file_path == rel
    assert row.file_size == 4321


def test_reconciler_fills_missing_size(db, tmp_path):
    cam = _add_camera(db, created_at=datetime(2026, 8, 1, tzinfo=UTC))
    rel = f"cam-{cam.id}/2026-08-10/12/00-00-000000.mp4"
    p = tmp_path / rel
    p.parent.mkdir(parents=True)
    p.write_bytes(b"x" * 77)
    old = time.time() - 600
    os.utime(p, (old, old))
    db.add(
        Recording(
            camera_id=cam.id,
            filename=p.name,
            file_path=rel,
            file_size=None,
            start_time=datetime(2026, 8, 10, 12, 0, tzinfo=UTC),
        )
    )
    db.commit()

    assert reconcile_camera(db, cam.id, tmp_path, None) == (0, 0)
    assert db.query(Recording).one().file_size == 77


# ------------------------------------------------------- system monitor


def test_monitor_withholds_wrapped_reading(db, monkeypatch):
    _settings(monkeypatch, max_storage_gb=16000)
    monkeypatch.setattr(sms, "get_effective_recordings_base_path", lambda _db: "/rec")
    monkeypatch.setattr(sms.shutil, "disk_usage", lambda _p: WRAPPED)
    m = sms.SystemMonitorService()
    m._active = {sms.ALERT_DISK_LOW: True}

    sample = m.sample(db)
    assert sample["disk"] is None
    assert "16000 GB storage cap" in sample["disk_unreliable"]

    settings = sms.SystemMonitoringSettings(
        cpu_percent_threshold=None,
        memory_percent_threshold=None,
        disk_used_percent_threshold=90,
    )
    m.evaluate(sample, settings)
    later = {**sample, "ts": sample["ts"] + sms.SAMPLE_INTERVAL_SECONDS}
    out = m.evaluate(later, settings)
    # A disk_low latched from bad numbers resolves; no stat-error alert.
    assert [(t["event_type"], t["state"]) for t in out] == [
        (sms.ALERT_DISK_LOW, "inactive")
    ]


def test_monitor_keeps_sane_reading(db, monkeypatch):
    _settings(monkeypatch, max_storage_gb=100)
    monkeypatch.setattr(sms, "get_effective_recordings_base_path", lambda _db: "/rec")
    sane = Usage(total=18000 * GB, used=1000 * GB, free=17000 * GB)
    monkeypatch.setattr(sms.shutil, "disk_usage", lambda _p: sane)
    sample = sms.SystemMonitorService().sample(db)
    assert sample["disk"]["total"] == sane.total
    assert sample["disk_unreliable"] is None
