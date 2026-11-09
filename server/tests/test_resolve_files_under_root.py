"""resolve_files_under_root: the batched V-005 path check used to build
playback sessions. Same verdicts as resolve_under_root, one listing per
directory."""

from __future__ import annotations

import os

import pytest

from services import storage_service as ss


@pytest.fixture(autouse=True)
def _fresh_cache():
    ss._dir_listings.clear()
    yield
    ss._dir_listings.clear()


@pytest.fixture
def root(tmp_path):
    r = tmp_path / "recordings"
    (r / "cam-1" / "2026-10-01" / "10").mkdir(parents=True)
    (r / "cam-1" / "2026-10-01" / "11").mkdir(parents=True)
    for h in ("10", "11"):
        for m in ("00", "01"):
            (r / "cam-1" / "2026-10-01" / h / f"{m}.mp4").write_bytes(b"x")
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"secret")
    d = r / "cam-1" / "2026-10-01" / "10"
    (d / "escape.mp4").symlink_to(outside)
    (d / "inside-link.mp4").symlink_to(d / "00.mp4")
    (d / "subdir.mp4").mkdir()
    (r / "cam-2").symlink_to(tmp_path)  # a directory symlink out of the root
    return r


def test_accepts_regular_files_and_rejects_the_rest(root):
    base = "cam-1/2026-10-01/10/"
    rels = [
        base + "00.mp4", base + "01.mp4", "cam-1/2026-10-01/11/00.mp4",
        base + "missing.mp4", base + "escape.mp4", base + "subdir.mp4",
        base + "../10/00.mp4", "/etc/passwd", "", "cam-2/outside.mp4",
        base + "inside-link.mp4",
    ]
    got = ss.resolve_files_under_root(root, rels)
    real = os.path.realpath(root)
    assert got == {
        base + "00.mp4": ss.Path(real, base, "00.mp4"),
        base + "01.mp4": ss.Path(real, base, "01.mp4"),
        "cam-1/2026-10-01/11/00.mp4": ss.Path(real, "cam-1/2026-10-01/11/00.mp4"),
        base + "inside-link.mp4": ss.Path(real, base, "00.mp4"),
    }
    # Each verdict matches the per-file check.
    for rel in rels:
        try:
            one = ss.resolve_under_root(root, rel)
            ok = one.is_file()
        except (ss.RecordingPathError, OSError):
            ok = False
        assert (rel in got) is ok, rel


def test_a_directory_is_listed_once_and_new_files_are_still_found(root, monkeypatch):
    calls = []
    real_scandir = os.scandir

    def counting(path):
        calls.append(str(path))
        return real_scandir(path)

    monkeypatch.setattr(ss.os, "scandir", counting)
    base = "cam-1/2026-10-01/10/"
    ss.resolve_files_under_root(root, [base + "00.mp4", base + "01.mp4"])
    ss.resolve_files_under_root(root, [base + "00.mp4"])
    assert len(calls) == 1  # second call reused the listing

    (root / base / "02.mp4").write_bytes(b"x")  # a clip lands
    got = ss.resolve_files_under_root(root, [base + "00.mp4", base + "02.mp4"])
    assert base + "02.mp4" in got
    assert len(calls) == 2  # one fresh listing for the unknown name
