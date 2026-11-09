"""The host recording reader (scripts/recording-reader) and core's client for it
(services/recording_source.py): same bytes as the mount, confined to the root,
token-gated, and any reader failure falls back to the mount."""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from services import recording_source as rs

READER = Path(__file__).resolve().parents[2] / "scripts" / "recording-reader" / "recording_reader.py"
TOKEN = "t" * 40


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def tree(tmp_path):
    root = tmp_path / "recordings"
    (root / "cam-1").mkdir(parents=True)
    data = os.urandom(3_000_000)
    (root / "cam-1" / "a.mp4").write_bytes(data)
    (tmp_path / "secret.txt").write_text("outside the root")
    (root / "cam-1" / "link.mp4").symlink_to(tmp_path / "secret.txt")
    return root, data


@pytest.fixture
def reader(tree, tmp_path, monkeypatch):
    root, _data = tree
    tok = tmp_path / "token"
    tok.write_text(TOKEN)
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, str(READER), "--root", str(root), "--token-file", str(tok),
         "--port", str(port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    url = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(url + "/health", timeout=1).read()
            break
        except OSError:
            time.sleep(0.05)
    monkeypatch.setenv("RECORDING_READER_URL", url)
    monkeypatch.setenv("RECORDING_READER_TOKEN", TOKEN)
    monkeypatch.setenv("RECORDINGS_BASE_PATH", str(root))
    monkeypatch.setattr(rs, "_down_until", 0.0)
    with rs._pool_lock:
        rs._pool.clear()
    yield url, proc
    proc.kill()
    proc.wait()


def _get(url, path, token=TOKEN, rng=None):
    h = {"Authorization": f"Bearer {token}"} if token else {}
    if rng:
        h["Range"] = rng
    try:
        r = urllib.request.urlopen(urllib.request.Request(url + path, headers=h), timeout=5)
        return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""


def test_reader_serves_ranges_and_refuses_everything_else(reader, tree):
    url, _ = reader
    _root, data = tree
    assert _get(url, "/f/cam-1/a.mp4") == (200, data)
    assert _get(url, "/f/cam-1/a.mp4", rng="bytes=10-19") == (206, data[10:20])
    assert _get(url, "/f/cam-1/a.mp4", rng="bytes=-5") == (206, data[-5:])
    assert _get(url, "/f/cam-1/a.mp4", rng=f"bytes={len(data)}-")[0] == 416
    assert _get(url, "/f/cam-1/a.mp4", token=None)[0] == 401
    assert _get(url, "/f/cam-1/a.mp4", token="x" * 40)[0] == 401
    assert _get(url, "/f/../secret.txt")[0] in (403, 404)
    assert _get(url, "/f/cam-1/%2e%2e/%2e%2e/secret.txt")[0] == 403
    assert _get(url, "/f/cam-1/link.mp4")[0] == 403  # symlink out of the root
    assert _get(url, "/f/cam-1")[0] == 403  # not a regular file
    assert _get(url, "/f/cam-1/missing.mp4")[0] == 404


def test_reader_file_reads_like_the_mount(reader, tree):
    root, data = tree
    path = root / "cam-1" / "a.mp4"
    with rs.open_recording(path, block=4096) as f:
        assert isinstance(f, rs.ReaderFile)
        assert rs.file_size(f) == len(data)
        assert f.read(8) == data[:8]
        f.seek(1_000_000)
        assert f.read(100_000) == data[1_000_000:1_100_000]  # spans many blocks
        f.seek(-10, os.SEEK_END)
        assert f.read() == data[-10:]
        assert f.read(5) == b""
    with rs.open_recording(path, block=1 << 20, offset=2_500_000) as f:
        assert f.tell() == 2_500_000
        assert f.read() == data[2_500_000:]


def test_without_a_reader_it_opens_the_mount(tree, monkeypatch):
    root, data = tree
    monkeypatch.delenv("RECORDING_READER_URL", raising=False)
    with rs.open_recording(root / "cam-1" / "a.mp4", offset=7) as f:
        assert not isinstance(f, rs.ReaderFile)
        assert f.read(3) == data[7:10]
        assert rs.file_size(f) == len(data)


def test_a_stopped_reader_falls_back_and_backs_off(tree, monkeypatch):
    root, data = tree
    monkeypatch.setenv("RECORDING_READER_URL", f"http://127.0.0.1:{_free_port()}")
    monkeypatch.setenv("RECORDING_READER_TOKEN", TOKEN)
    monkeypatch.setenv("RECORDINGS_BASE_PATH", str(root))
    monkeypatch.setattr(rs, "_down_until", 0.0)
    with rs.open_recording(root / "cam-1" / "a.mp4") as f:
        assert not isinstance(f, rs.ReaderFile)
        assert f.read(4) == data[:4]
    assert not rs.reader_available()  # skipped until the back-off ends


def test_a_reader_dying_mid_read_finishes_from_the_mount(reader, tree):
    root, data = tree
    _url, proc = reader
    with rs.open_recording(root / "cam-1" / "a.mp4", block=1 << 20) as f:
        assert isinstance(f, rs.ReaderFile)
        first = f.read(1 << 20)
        proc.kill()
        proc.wait()
        rest = f.read()
    assert first + rest == data
    assert not rs.reader_available()


def test_a_wrong_token_falls_back_to_the_mount(reader, tree, monkeypatch):
    root, data = tree
    monkeypatch.setenv("RECORDING_READER_TOKEN", "x" * 40)
    with rs.open_recording(root / "cam-1" / "a.mp4") as f:
        assert not isinstance(f, rs.ReaderFile)
        assert f.read(4) == data[:4]


def test_paths_outside_the_recordings_root_use_the_mount(reader, tmp_path):
    other = tmp_path / "elsewhere.bin"
    other.write_bytes(b"hello")
    with rs.open_recording(other) as f:
        assert not isinstance(f, rs.ReaderFile)
        assert f.read() == b"hello"


def test_a_missing_file_raises_like_open(reader, tree):
    root, _ = tree
    with pytest.raises(FileNotFoundError):
        rs.open_recording(root / "cam-1" / "nope.mp4")
    assert rs.reader_available()  # a missing file is not a reader failure


def test_playback_through_the_reader_matches_the_mount(reader, tree, monkeypatch):
    """Scan, remux index and streamed bytes are identical either way."""
    from services import hevc_remux_service as hrs
    from services.hls_playback_service import HlsPlaybackService
    from tests.test_hevc_remux import _build_fmp4_multi

    root, _ = tree
    src = root / "cam-1" / "clip.mp4"
    src.write_bytes(_build_fmp4_multi(
        ([b"KEY0" * 3000, b"p1" * 5000], [b"a" * 700]),
        ([b"KEY1" * 4000, b"p2" * 9000], [b"b" * 900]),
        ([b"KEY2" * 2000], [b"c" * 300]),
    ))

    def everything():
        idx = hrs.build_remux_index(src)
        return (
            hrs.probe_video_codec(src),
            HlsPlaybackService._scan_fmp4(src),
            idx.header, idx.runs, idx.total_size,
            b"".join(hrs.iter_index_range(idx, 0, idx.total_size - 1)),
            b"".join(hrs.iter_index_range(idx, len(idx.header) + 5, idx.total_size - 9)),
        )

    opened = []
    real = rs.ReaderFile.__init__

    def spy(self, *a, **k):
        opened.append(a[1])
        real(self, *a, **k)

    monkeypatch.setattr(rs.ReaderFile, "__init__", spy)
    via_reader = everything()
    assert opened and rs.reader_available()
    monkeypatch.delenv("RECORDING_READER_URL")
    assert everything() == via_reader


def test_stat_comes_from_the_reader_and_matches_the_mount(reader, tree, monkeypatch):
    root, data = tree
    path = root / "cam-1" / "a.mp4"
    st = rs.stat_recording(path)
    assert (st.st_size, int(st.st_mtime)) == (len(data), int(os.stat(path).st_mtime))

    def no_mount_stat(*a, **k):
        raise AssertionError("stat went to the mount")

    monkeypatch.setattr(rs.os, "stat", no_mount_stat)
    assert rs.stat_recording(path).st_size == len(data)
    with pytest.raises(AssertionError):  # a missing file is the mount's call
        rs.stat_recording(root / "cam-1" / "nope.mp4")
    monkeypatch.undo()
    with pytest.raises(FileNotFoundError):
        rs.stat_recording(root / "cam-1" / "nope.mp4")
