# Copyright (c) 2026 OpenNVR
# Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0)
"""Chained remux: several consecutive 1-minute recordings served as ONE video,
so the player crosses minutes of footage without reloading (it used to stop at
every file boundary — at 8x, every 7.5 s)."""

from __future__ import annotations

import struct
from datetime import UTC, datetime, timedelta

import pytest

from services import hevc_remux_service as hrs
from services.hls_playback_service import HlsPlaybackService
from tests.test_hevc_remux import _fragment, _full, _init_segment
from tests.test_hls_remux_decision import _session

TS = 90000  # fixture video timescale
DUR = 3000  # per-sample duration (30 fps)


def _clip(path, frags, vcodec: bytes = b"hev1") -> None:
    """fMP4 with real per-sample durations (the shared fixture's are 0)."""
    init = _init_segment(vcodec, b"ipcm").replace(
        _full(b"trex", 0, 0, struct.pack(">IIIII", 1, 1, 0, 0, 0)),
        _full(b"trex", 0, 0, struct.pack(">IIIII", 1, 1, DUR, 0, 0)),
    )
    body = b"".join(_fragment(i, vid, [b"AUD"]) for i, vid in enumerate(frags, start=1))
    path.write_bytes(init + body)


def _table(index, box: bytes) -> bytes:
    off, hdr, size = hrs._find(
        index.header, 0, len(index.header),
        (b"moov", b"trak", b"mdia", b"minf", b"stbl", box),
    )
    return index.header[off + hdr + 4:off + size]  # past version+flags


def _stts_total(index) -> int:
    t = _table(index, b"stts")
    n = struct.unpack(">I", t[:4])[0]
    return sum(c * d for c, d in (struct.unpack(">II", t[4 + 8 * i:12 + 8 * i]) for i in range(n)))


@pytest.fixture(autouse=True)
def _fresh_scan_cache():
    hrs._scans.clear()
    hrs._scan_inflight.clear()
    yield
    hrs._scans.clear()


def test_chain_plays_files_back_to_back(tmp_path):
    a, b = tmp_path / "a.mp4", tmp_path / "b.mp4"
    _clip(a, [[b"KEY_A0", b"pa1"], [b"KEY_A2"]])
    _clip(b, [[b"KEY_B0", b"pb1"]])
    # File a holds 3 samples (9000 ticks) but b starts 9000+4500 ticks later:
    # a 0.05 s recording gap, bridged by holding a's last frame.
    index = hrs.build_chain_index([str(a), str(b)], [(3 * DUR + 4500) / TS])

    assert index.src_paths == (str(a.resolve()), str(b.resolve()))
    data = b"".join(hrs.iter_index_range(index, 0, index.total_size - 1))
    assert data[len(index.header):] == b"KEY_A0pa1KEY_A2KEY_B0pb1"

    # The fixture marks every sample sync; b's sync numbers continue after a's.
    stss = _table(index, b"stss")
    n_sync = struct.unpack(">I", stss[:4])[0]
    assert [struct.unpack(">I", stss[4 + 4 * i:8 + 4 * i])[0] for i in range(n_sync)] == [1, 2, 3, 4, 5]
    assert struct.unpack(">I", _table(index, b"stsz")[4:8])[0] == 5
    assert _stts_total(index) == 5 * DUR + 4500
    assert index.duration == pytest.approx((5 * DUR + 4500) / TS)

    # Every range across the file boundary reads the right source.
    total = index.total_size
    for start in range(0, total, 5):
        for end in range(start, total, 7):
            got = b"".join(hrs.iter_index_range(index, start, end, chunk=4))
            assert got == data[start:end + 1]


def test_a_long_gap_is_not_bridged(tmp_path):
    a, b = tmp_path / "a.mp4", tmp_path / "b.mp4"
    _clip(a, [[b"KEY_A0"]])
    _clip(b, [[b"KEY_B0"]])
    index = hrs.build_chain_index([str(a), str(b)], [DUR / TS + 10.0])
    assert _stts_total(index) == 2 * DUR


def test_chain_stops_where_the_video_format_changes(tmp_path):
    a, b = tmp_path / "a.mp4", tmp_path / "b.mp4"
    _clip(a, [[b"KEY_A0"]], vcodec=b"hev1")
    _clip(b, [[b"KEY_B0"]], vcodec=b"avc1")  # camera reconfigured
    index = hrs.build_chain_index([str(a), str(b)])
    assert index.src_paths == (str(a.resolve()),)


def test_chain_stops_at_a_missing_file_but_not_the_first(tmp_path):
    a = tmp_path / "a.mp4"
    _clip(a, [[b"KEY_A0"]])
    index = hrs.build_chain_index([str(a), str(tmp_path / "gone.mp4")])
    assert index.src_paths == (str(a.resolve()),)
    with pytest.raises(FileNotFoundError):
        hrs.build_chain_index([str(tmp_path / "gone.mp4"), str(a)])


def test_scans_are_cached_and_read_ahead_is_reused(tmp_path, monkeypatch):
    paths = []
    for n in range(3):
        p = tmp_path / f"{n}.mp4"
        _clip(p, [[b"KEY%d" % n]])
        paths.append(str(p))
    calls: list[str] = []
    real = hrs._scan_video
    monkeypatch.setattr(hrs, "_scan_video", lambda p: calls.append(p) or real(p))

    hrs.warm_scans(paths[1:], background=True)
    hrs.build_chain_index(paths)
    hrs.build_chain_index(paths)
    assert sorted(calls) == sorted(str(tmp_path / f"{n}.mp4") for n in range(3))

    # A file that grew (still recording) is scanned again.
    _clip(tmp_path / "2.mp4", [[b"KEY2"], [b"KEY2b"]])
    hrs.build_chain_index(paths)
    assert len(calls) == 4


def test_a_remux_session_chains_contiguous_files_and_reads_ahead(tmp_path, monkeypatch):
    start = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)
    rows = []
    for n in range(4):
        p = tmp_path / f"{n}.mp4"
        _clip(p, [[b"KEY%d" % n, b"p"]])
        rows.append((p, start + timedelta(seconds=60 * n), 60.0))
    monkeypatch.setattr(
        HlsPlaybackService, "_resolve_recording_rows", classmethod(lambda cls, *a: rows)
    )
    monkeypatch.setattr(HlsPlaybackService, "_stored_codec", classmethod(lambda cls, *a: None))
    monkeypatch.setattr(HlsPlaybackService, "REMUX_CHAIN_FILES", 2)
    warmed: list[tuple[list[str], bool]] = []
    real_warm = hrs.warm_scans
    monkeypatch.setattr(
        hrs, "warm_scans", lambda ps, background=False: warmed.append((ps, background)) or real_warm(ps, background)
    )

    session = _session(start + timedelta(seconds=30))
    HlsPlaybackService._attach_byte_index(session, 7, object(), 0.0)

    assert session.needs_remux is True
    assert session.remux_index.src_paths == (str(rows[0][0].resolve()), str(rows[1][0].resolve()))
    assert session.file_offset_seconds == 30.0
    # The two files after the chain are scanned in the background.
    assert ([str(rows[2][0]), str(rows[3][0])], True) in warmed


def test_a_remux_session_does_not_chain_across_a_gap(tmp_path, monkeypatch):
    start = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)
    a, b = tmp_path / "a.mp4", tmp_path / "b.mp4"
    _clip(a, [[b"KEY_A"]])
    _clip(b, [[b"KEY_B"]])
    rows = [(a, start, 60.0), (b, start + timedelta(minutes=5), 60.0)]
    monkeypatch.setattr(
        HlsPlaybackService, "_resolve_recording_rows", classmethod(lambda cls, *a: rows)
    )
    monkeypatch.setattr(HlsPlaybackService, "_stored_codec", classmethod(lambda cls, *a: None))

    session = _session(start)
    HlsPlaybackService._attach_byte_index(session, 7, object(), 0.0)
    assert session.remux_index.src_paths == (str(a.resolve()),)
