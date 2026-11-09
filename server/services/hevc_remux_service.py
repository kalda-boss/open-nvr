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

"""
Pure-Python HEVC recording remux — make H.265 recordings play in the browser
WITHOUT ffmpeg, without transcoding, and without a disk cache.

Browsers decode HEVC in MSE/WebCodecs, but reject the container OpenNVR records:
MediaMTX writes an ``hev1`` (in-band params) video track plus a raw-PCM (``ipcm``)
audio track. MSE needs ``hvc1`` (out-of-band params, which the ``hvcC`` box
already carries) and can't decode PCM at all — so it stalls (black screen).

The browser-playable file is a deterministic rearrangement of the source: a
small synthesized header (``ftyp`` + flat ``moov`` + ``mdat`` header) followed
by the video sample runs copied verbatim, in order. So instead of materializing
a second copy on disk, this service serves it as a VIRTUAL file:

  * ``build_remux_index()`` scans only the fragment headers (never the sample
    payloads) and produces a ``RemuxIndex``: the header bytes (a few MB, kept
    in RAM) plus a table mapping output offsets to source-file runs;
  * ``iter_index_range()`` answers any HTTP Range request by slicing the header
    from RAM and streaming the mapped runs straight from the original file.

The browser receives byte-for-byte what a materialized remux would contain,
but nothing is ever written to disk. Indexes live in a small in-process LRU
and are rebuilt (sub-second) whenever the source file changes — which also
makes still-recording files just work: the playable tail grows with the file.

``remux_to_browser_mp4()`` still materializes a real file from the same index;
it is kept as the reference implementation (test oracle) and for tooling.

Sound rides alongside as a second virtual file. The same header scan notes
where the ``ipcm`` audio sits (it costs no extra reads: the run tables are in
the fragment headers already being parsed), and ``iter_audio_range()`` serves
it as a plain 16-bit WAV aligned to the remuxed video's t=0, byte-swapped from
the recording's big-endian PCM on the way out. Nothing reads audio from disk
until a player asks for it, which the web app does only while someone has the
sound on at 1x.
"""

from __future__ import annotations

import asyncio
import os
import struct
import threading
from array import array
from bisect import bisect_right
from collections import OrderedDict
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from core.logging_config import recording_logger
from services.recording_source import (
    file_size as _file_size,
    open_recording,
    stat_recording,
)

# ---------------------------------------------------------------------------
# ISO-BMFF helpers (seek-based; never loads mdat payloads into memory)
# ---------------------------------------------------------------------------

_CONTAINER = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"mvex", b"edts"}


def _read_box_header(f: BinaryIO, pos: int) -> tuple[bytes, int, int] | None:
    """Return (type, header_size, box_size) at file position ``pos``, or None."""
    f.seek(pos)
    head = f.read(8)
    if len(head) < 8:
        return None
    size = struct.unpack(">I", head[:4])[0]
    typ = head[4:8]
    hdr = 8
    if size == 1:
        ext = f.read(8)
        if len(ext) < 8:
            return None
        size = struct.unpack(">Q", ext)[0]
        hdr = 16
    elif size == 0:
        size = _file_size(f) - pos
    if size < hdr:
        return None
    return typ, hdr, size


def _iter_top_level(f: BinaryIO):
    """Yield (type, box_start, header_size, box_size) for each top-level box.

    A box that runs past EOF is NOT yielded: while MediaMTX is still writing a
    recording, the final fragment is half-flushed (its header already claims a
    size the file doesn't hold yet). Indexing it would map samples past the end
    of the file and truncate playback, so the scan stops at the last COMPLETE
    box — which is exactly the "everything finished so far" boundary.
    """
    size_total = _file_size(f)
    pos = 0
    while pos + 8 <= size_total:
        info = _read_box_header(f, pos)
        if info is None:
            break
        typ, hdr, size = info
        if pos + size > size_total:
            break  # still being written — treat as not there yet
        yield typ, pos, hdr, size
        pos += size


def _find(buf: bytes, start: int, end: int, path: tuple[bytes, ...]):
    """Find first nested box by path inside an in-memory buffer."""
    want = path[0]
    o = start
    while o + 8 <= end:
        size = struct.unpack(">I", buf[o:o + 4])[0]
        typ = buf[o + 4:o + 8]
        hdr = 8
        if size == 1:
            size = struct.unpack(">Q", buf[o + 8:o + 16])[0]
            hdr = 16
        elif size == 0:
            size = end - o
        if size < hdr or o + size > end:
            break
        if typ == want:
            if len(path) == 1:
                return o, hdr, size
            r = _find(buf, o + hdr, o + size, path[1:])
            if r:
                return r
        o += size
    return None


def _find_all(buf: bytes, start: int, end: int, want: bytes):
    out = []
    o = start
    while o + 8 <= end:
        size = struct.unpack(">I", buf[o:o + 4])[0]
        typ = buf[o + 4:o + 8]
        hdr = 8
        if size == 1:
            size = struct.unpack(">Q", buf[o + 8:o + 16])[0]
            hdr = 16
        elif size == 0:
            size = end - o
        if size < hdr or o + size > end:
            break
        if typ == want:
            out.append((o, hdr, size))
        o += size
    return out


# ---------------------------------------------------------------------------
# Codec probe
# ---------------------------------------------------------------------------


def _probe_codec(path: str | Path, handler: bytes) -> str | None:
    """Sample-entry fourcc (lowercased) of the first ``handler`` track, or None.
    Cheap: reads only the moov box."""
    try:
        with open_recording(path, block=16 * 1024) as f:
            for typ, pos, hdr, size in _iter_top_level(f):
                if typ != b"moov":
                    continue
                f.seek(pos)
                moov = f.read(size)
                for to, th, ts in _find_all(moov, hdr, size, b"trak"):
                    hd = _find(moov, to + th, to + ts, (b"mdia", b"hdlr"))
                    if not hd:
                        continue
                    ho, hh, _hs = hd
                    if moov[ho + hh + 8:ho + hh + 12] != handler:
                        continue
                    stsd = _find(moov, to + th, to + ts,
                                 (b"mdia", b"minf", b"stbl", b"stsd"))
                    if not stsd:
                        return None
                    so, sh, _ss = stsd
                    e = so + sh + 8
                    return moov[e + 4:e + 8].decode("latin-1", "replace").lower()
                return None
    except Exception as e:
        recording_logger.warning(
            "probe %s codec(%s) failed: %s", handler.decode(), path, e
        )
    return None


def probe_video_codec(path: str | Path) -> str | None:
    """Return the video sample-entry fourcc lowercased (``hev1``/``hvc1``/``avc1``
    …) or None. Cheap: reads only the moov box."""
    return _probe_codec(path, b"vide")


def probe_audio_codec(path: str | Path) -> str | None:
    """Return the audio sample-entry fourcc lowercased (``mp4a``/``opus``/``ipcm``
    …) or None when the recording has no audio track."""
    return _probe_codec(path, b"soun")


# Audio the browser MSE pipeline decodes. MediaMTX writes G.711 (and any other
# PCM) as ``ipcm``, which no browser decodes; one undecodable track makes MSE
# reject the whole clip, video included.
_BROWSER_AUDIO = ("mp4a", "opus")


def is_browser_incompatible_video(codec: str | None) -> bool:
    """True for video codecs the browser MSE pipeline can't play as recorded.

    All HEVC flavors are remuxed: ``hev1`` needs the ``hvc1`` retag, and even an
    ``hvc1`` recording still carries the raw-PCM audio track MSE can't decode.
    ``avc1`` (H.264) video plays as recorded; see ``needs_browser_remux`` for
    the audio side.
    """
    return (codec or "") in ("hev1", "hvc1", "hevc")


def is_browser_incompatible_audio(codec: str | None) -> bool:
    """True for an audio track MSE can't decode (no audio track -> False)."""
    return bool(codec) and codec not in _BROWSER_AUDIO


def needs_browser_remux(video_codec: str | None, audio_codec: str | None) -> bool:
    """Whether a recording must go through the video-only remux to play.

    H.264 with G.711 audio is the common case here: the video is fine, but the
    ``ipcm`` track stalls MSE, so the remux drops it.
    """
    return is_browser_incompatible_video(video_codec) or is_browser_incompatible_audio(
        audio_codec
    )


# ---------------------------------------------------------------------------
# The remux index: header bytes + output-offset -> source-run mapping
# ---------------------------------------------------------------------------


def _box(typ: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", 8 + len(payload)) + typ + payload


def _fullbox(typ: bytes, ver: int, flags: int, payload: bytes) -> bytes:
    return _box(typ, bytes([ver]) + struct.pack(">I", flags)[1:] + payload)


@dataclass(frozen=True)
class RemuxIndex:
    """The complete recipe for the browser-playable MP4 of one recording.

    ``header`` is the synthesized ``ftyp + moov + mdat-header`` prefix; output
    bytes beyond it are the source file's video sample runs, in order.
    ``run_out_starts[i]`` is the absolute OUTPUT offset where ``runs[i]``
    begins (first entry == len(header)), enabling O(log n) range mapping.
    """

    src_path: str
    src_size: int
    src_mtime: int
    header: bytes
    runs: tuple[tuple[int, int], ...]  # (source_offset, length)
    run_out_starts: tuple[int, ...]
    total_size: int
    # -- the sound, as a second virtual file (empty when there is none we can
    # serve). A 44-byte WAV header, then 16-bit little-endian PCM whose first
    # frame plays at the video's t=0. ``audio_segments`` are (data_offset,
    # source_offset, length); source_offset -1 is silence filling a gap.
    audio_header: bytes = b""
    audio_segments: tuple[tuple[int, int, int], ...] = ()
    audio_data_starts: tuple[int, ...] = ()
    audio_data_size: int = 0
    audio_swap: bool = False  # source PCM is big-endian (the ISO default)
    audio_sample_rate: int = 0
    audio_channels: int = 0

    @property
    def has_audio(self) -> bool:
        return self.audio_data_size > 0

    @property
    def audio_total_size(self) -> int:
        return len(self.audio_header) + self.audio_data_size


def build_remux_index(src_path: str | Path) -> RemuxIndex:
    """Scan ``src_path`` (headers only — sample payloads are never read) and
    build the :class:`RemuxIndex` for its flat, video-only remux
    (``hev1`` retagged to ``hvc1``, any other sample entry kept).

    Raises on structural failure (caller treats the file as unplayable).
    """
    src_path = str(src_path)
    st = stat_recording(src_path)
    with open_recording(src_path, block=16 * 1024) as f:
        # -- locate moov, extract video track metadata + retagged sample entry --
        moov = None
        for typ, pos, hdr, size in _iter_top_level(f):
            if typ == b"moov":
                f.seek(pos)
                moov = f.read(size)
                moov_hdr = hdr
                break
        if moov is None:
            raise ValueError("no moov box")

        video_track_id = timescale = None
        stsd_entry = None
        for to, th, ts in _find_all(moov, moov_hdr, len(moov), b"trak"):
            hd = _find(moov, to + th, to + ts, (b"mdia", b"hdlr"))
            if not hd or moov[hd[0] + hd[1] + 8:hd[0] + hd[1] + 12] != b"vide":
                continue
            tk = _find(moov, to + th, to + ts, (b"tkhd",))
            tver = moov[tk[0] + tk[1]]
            tid_off = tk[0] + tk[1] + (20 if tver == 1 else 12)
            video_track_id = struct.unpack(">I", moov[tid_off:tid_off + 4])[0]
            md = _find(moov, to + th, to + ts, (b"mdia", b"mdhd"))
            mver = moov[md[0] + md[1]]
            tsc_off = md[0] + md[1] + (20 if mver == 1 else 12)
            timescale = struct.unpack(">I", moov[tsc_off:tsc_off + 4])[0]
            stsd = _find(moov, to + th, to + ts,
                         (b"mdia", b"minf", b"stbl", b"stsd"))
            e = stsd[0] + stsd[1] + 8
            esize = struct.unpack(">I", moov[e:e + 4])[0]
            stsd_entry = bytearray(moov[e:e + esize])
            if stsd_entry[4:8] == b"hev1":
                stsd_entry[4:8] = b"hvc1"  # retag (params already in hvcC)
            break
        if video_track_id is None or stsd_entry is None:
            raise ValueError("no video track / sample entry")

        audio = _pcm_audio_track(moov, moov_hdr)  # None: no sound we can serve
        audio_track_id = audio["track_id"] if audio else None

        # trex defaults per track
        trex: dict[int, tuple[int, int, int]] = {}
        mvex = _find(moov, moov_hdr, len(moov), (b"mvex",))
        if mvex:
            for xo, xh, _xs in _find_all(moov, mvex[0] + mvex[1],
                                         mvex[0] + mvex[2], b"trex"):
                tid = struct.unpack(">I", moov[xo + xh + 4:xo + xh + 8])[0]
                trex[tid] = (
                    struct.unpack(">I", moov[xo + xh + 12:xo + xh + 16])[0],
                    struct.unpack(">I", moov[xo + xh + 16:xo + xh + 20])[0],
                    struct.unpack(">I", moov[xo + xh + 20:xo + xh + 24])[0],
                )

        # -- index all fragments: per-sample (size,dur,sync) + contiguous runs --
        sample_sizes: list[int] = []
        sample_durs: list[int] = []
        sync_samples: list[int] = []  # 1-based indices
        runs: list[tuple[int, int]] = []  # (file_offset, run_length) video-only
        # first video decode time (video timescale): what the remux's t=0 is
        video_t0: int | None = None
        # sound: (decode time in audio timescale or None, file_offset, length)
        audio_frags: list[tuple[int | None, int, int]] = []
        file_size = _file_size(f)
        for typ, pos, hdr, size in _iter_top_level(f):
            if typ != b"moof":
                continue
            f.seek(pos)
            moof = f.read(size)
            # Buffer this fragment and commit it only once its sample data is
            # verified present. A moof is written before its mdat, so a
            # still-recording file ends with a COMPLETE header describing bytes
            # that have not landed yet; committing those would map samples past
            # EOF and truncate playback mid-stream.
            frag_sizes: list[int] = []
            frag_durs: list[int] = []
            frag_sync: list[int] = []
            frag_runs: list[tuple[int, int]] = []
            frag_audio: list[tuple[int | None, int, int]] = []
            frag_video_t0: int | None = None
            for tro, trh, trs in _find_all(moof, hdr, size, b"traf"):
                tfhd = _find(moof, tro + trh, tro + trs, (b"tfhd",))
                to2, th2, _ts2 = tfhd
                tf_flags = struct.unpack(">I", moof[to2 + th2:to2 + th2 + 4])[0] & 0xFFFFFF
                p = to2 + th2 + 4
                track_id = struct.unpack(">I", moof[p:p + 4])[0]
                p += 4
                base = pos  # default-base-is-moof
                if tf_flags & 0x01:
                    base = struct.unpack(">Q", moof[p:p + 8])[0]
                    p += 8
                if tf_flags & 0x02:
                    p += 4
                if track_id not in (video_track_id, audio_track_id):
                    continue
                td, tsz, tfl = trex.get(track_id, (0, 0, 0))
                if tf_flags & 0x08:
                    td = struct.unpack(">I", moof[p:p + 4])[0]
                    p += 4
                if tf_flags & 0x10:
                    tsz = struct.unpack(">I", moof[p:p + 4])[0]
                    p += 4
                if tf_flags & 0x20:
                    tfl = struct.unpack(">I", moof[p:p + 4])[0]
                    p += 4
                tfdt = _find(moof, tro + trh, tro + trs, (b"tfdt",))
                decode_time = None
                if tfdt:
                    fo = tfdt[0] + tfdt[1]
                    decode_time = (struct.unpack(">Q", moof[fo + 4:fo + 12])[0]
                                   if moof[fo] == 1
                                   else struct.unpack(">I", moof[fo + 4:fo + 8])[0])
                trun = _find(moof, tro + trh, tro + trs, (b"trun",))
                if not trun:
                    continue
                uo, uh, _us = trun
                tr_flags = struct.unpack(">I", moof[uo + uh:uo + uh + 4])[0] & 0xFFFFFF
                q = uo + uh + 4
                count = struct.unpack(">I", moof[q:q + 4])[0]
                q += 4
                data_off = 0
                if tr_flags & 0x01:
                    data_off = struct.unpack(">i", moof[q:q + 4])[0]
                    q += 4
                first_flags = None
                if tr_flags & 0x04:
                    first_flags = struct.unpack(">I", moof[q:q + 4])[0]
                    q += 4
                run_start = base + data_off
                if track_id == audio_track_id:
                    # PCM: only the byte run matters; its length IS its duration
                    if tr_flags & 0x200:
                        per = 4 * (bin(tr_flags & 0xF00).count("1"))
                        alen = 0
                        sz_at = 4 * (bin(tr_flags & 0x100).count("1"))
                        for i in range(count):
                            o = q + i * per + sz_at
                            alen += struct.unpack(">I", moof[o:o + 4])[0]
                    else:
                        alen = tsz * count
                    if alen:
                        frag_audio.append((decode_time, run_start, alen))
                    continue
                if frag_video_t0 is None:
                    frag_video_t0 = decode_time
                run_len = 0
                for idx in range(count):
                    sdur, ssz, sfl = td, tsz, tfl
                    if tr_flags & 0x100:
                        sdur = struct.unpack(">I", moof[q:q + 4])[0]
                        q += 4
                    if tr_flags & 0x200:
                        ssz = struct.unpack(">I", moof[q:q + 4])[0]
                        q += 4
                    if tr_flags & 0x400:
                        sfl = struct.unpack(">I", moof[q:q + 4])[0]
                        q += 4
                    if tr_flags & 0x800:
                        q += 4
                    if idx == 0 and first_flags is not None:
                        sfl = first_flags
                    frag_sizes.append(ssz)
                    frag_durs.append(sdur)
                    if (sfl & 0x10000) == 0:  # sync (not non-sync)
                        # 1-based index once this fragment is committed
                        frag_sync.append(len(sample_sizes) + len(frag_sizes))
                    run_len += ssz
                if run_len:
                    frag_runs.append((run_start, run_len))

            # Commit the fragment only if every byte it describes is on disk.
            # Otherwise the recording is still being written here: stop, and the
            # index covers exactly the footage that has finished.
            if any(rs + rl > file_size for rs, rl in frag_runs) or any(
                rs + rl > file_size for _t, rs, rl in frag_audio
            ):
                break
            if not sample_sizes and frag_sizes:
                video_t0 = frag_video_t0
            audio_frags.extend(frag_audio)
            sample_sizes.extend(frag_sizes)
            sample_durs.extend(frag_durs)
            sync_samples.extend(frag_sync)
            runs.extend(frag_runs)

        if not sample_sizes:
            raise ValueError("no video samples")

    total_dur = sum(sample_durs)

    # -- build moov (video-only) --
    stsd = _fullbox(b"stsd", 0, 0, struct.pack(">I", 1) + bytes(stsd_entry))
    stts_runs: list[list[int]] = []
    for dur in sample_durs:
        if stts_runs and stts_runs[-1][1] == dur:
            stts_runs[-1][0] += 1
        else:
            stts_runs.append([1, dur])
    stts = _fullbox(b"stts", 0, 0, struct.pack(">I", len(stts_runs))
                    + b"".join(struct.pack(">II", c, d) for c, d in stts_runs))
    stss = _fullbox(b"stss", 0, 0, struct.pack(">I", len(sync_samples))
                    + b"".join(struct.pack(">I", n) for n in sync_samples))
    stsz = _fullbox(b"stsz", 0, 0, struct.pack(">II", 0, len(sample_sizes))
                    + b"".join(struct.pack(">I", s) for s in sample_sizes))
    # all samples in one chunk (mdat is a single contiguous run of them)
    stsc = _fullbox(b"stsc", 0, 0, struct.pack(">I", 1)
                    + struct.pack(">III", 1, len(sample_sizes), 1))
    stco = _fullbox(b"stco", 0, 0, struct.pack(">II", 1, 0))  # patched below
    stbl = _box(b"stbl", stsd + stts + stss + stsc + stsz + stco)
    vmhd = _fullbox(b"vmhd", 0, 1, struct.pack(">HHHH", 0, 0, 0, 0))
    dref = _fullbox(b"dref", 0, 0, struct.pack(">I", 1)
                    + _fullbox(b"url ", 0, 1, b""))
    minf = _box(b"minf", vmhd + _box(b"dinf", dref) + stbl)
    hdlr = _fullbox(b"hdlr", 0, 0, struct.pack(">I", 0) + b"vide"
                    + struct.pack(">III", 0, 0, 0) + b"VideoHandler\x00")
    mdhd = _fullbox(b"mdhd", 0, 0, struct.pack(">IIII", 0, 0, timescale, total_dur)
                    + struct.pack(">HH", 0x55C4, 0))
    mdia = _box(b"mdia", mdhd + hdlr + minf)
    # Display size, 16.16 fixed point, from the visual sample entry (width and
    # height sit 24 bytes into its body). Firefox rejects a 0x0 video track
    # with NS_ERROR_DOM_MEDIA_METADATA_ERR; Chromium ignores the field.
    width, height = struct.unpack(">HH", bytes(stsd_entry[32:36]))
    tkhd = _fullbox(b"tkhd", 0, 7, struct.pack(">IIIII", 0, 0, 1, 0, total_dur)
                    + b"\x00" * 8 + struct.pack(">hhhh", 0, 0, 0, 0)
                    + struct.pack(">IIIIIIIII", 0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000)
                    + struct.pack(">II", width << 16, height << 16))
    trak = _box(b"trak", tkhd + mdia)
    mvhd = _fullbox(b"mvhd", 0, 0, struct.pack(">IIII", 0, 0, timescale, total_dur)
                    + struct.pack(">IH", 0x10000, 0x0100) + b"\x00" * 10
                    + struct.pack(">IIIIIIIII", 0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000)
                    + b"\x00" * 24 + struct.pack(">I", 2))
    moov_out = _box(b"moov", mvhd + trak)
    ftyp = _box(b"ftyp", b"isom" + struct.pack(">I", 0x200)
                + b"isomiso2mp41" + bytes(stsd_entry[4:8]))

    mdat_size = sum(rl for _, rl in runs)
    # 64-bit mdat if needed
    if mdat_size + 8 > 0xFFFFFFFF:
        mdat_header = struct.pack(">I", 1) + b"mdat" + struct.pack(">Q", mdat_size + 16)
    else:
        mdat_header = struct.pack(">I", mdat_size + 8) + b"mdat"
    mdat_data_offset = len(ftyp) + len(moov_out) + len(mdat_header)

    # patch stco -> absolute offset of the first sample byte
    idx = moov_out.find(b"stco")
    moov_out = (moov_out[:idx + 8 + 4]
                + struct.pack(">I", mdat_data_offset)
                + moov_out[idx + 8 + 8:])

    header = ftyp + moov_out + mdat_header

    run_out_starts: list[int] = []
    out = len(header)
    for _, rl in runs:
        run_out_starts.append(out)
        out += rl

    audio_fields: dict = {}
    if audio and audio_frags:
        audio_fields = _audio_layout(
            audio, audio_frags,
            video_t0_sec=(video_t0 / timescale) if (video_t0 is not None and timescale) else 0.0,
            video_dur_sec=total_dur / timescale if timescale else 0.0,
        )

    return RemuxIndex(
        src_path=os.path.abspath(src_path),
        src_size=st.st_size,
        src_mtime=int(st.st_mtime),
        header=header,
        runs=tuple(runs),
        run_out_starts=tuple(run_out_starts),
        total_size=out,
        **audio_fields,
    )


# ---------------------------------------------------------------------------
# Sound: the recording's PCM track as a WAV aligned to the remuxed video
# ---------------------------------------------------------------------------

# Corrections smaller than this are ignored, so ordinary timestamp jitter
# between fragments never turns into clicks; a real gap (a dropped packet run)
# becomes silence and an overlap is trimmed, keeping sound on the picture.
_AUDIO_RESYNC_SEC = 0.04


def _pcm_audio_track(moov: bytes, moov_hdr: int) -> dict | None:
    """The first sound track, if it is 16-bit PCM (``ipcm``/``sowt``/``twos``),
    which is how MediaMTX stores G.711. Anything else (AAC, Opus) -> None."""
    for to, th, ts in _find_all(moov, moov_hdr, len(moov), b"trak"):
        hd = _find(moov, to + th, to + ts, (b"mdia", b"hdlr"))
        if not hd or moov[hd[0] + hd[1] + 8:hd[0] + hd[1] + 12] != b"soun":
            continue
        stsd = _find(moov, to + th, to + ts, (b"mdia", b"minf", b"stbl", b"stsd"))
        tk = _find(moov, to + th, to + ts, (b"tkhd",))
        md = _find(moov, to + th, to + ts, (b"mdia", b"mdhd"))
        if not (stsd and tk and md):
            return None
        e = stsd[0] + stsd[1] + 8
        esize = struct.unpack(">I", moov[e:e + 4])[0]
        fourcc = moov[e + 4:e + 8]
        if fourcc not in (b"ipcm", b"sowt", b"twos") or esize < 36:
            return None
        channels, bits = struct.unpack(">HH", moov[e + 24:e + 28])
        rate = struct.unpack(">I", moov[e + 32:e + 36])[0] >> 16
        big_endian = fourcc != b"sowt"
        if fourcc == b"ipcm":
            pc = _find(moov, e + 36, e + esize, (b"pcmC",))
            if pc:
                fmt_flags, bits = moov[pc[0] + pc[1] + 4], moov[pc[0] + pc[1] + 5]
                big_endian = not (fmt_flags & 0x01)
        tver = moov[tk[0] + tk[1]]
        tid_off = tk[0] + tk[1] + (20 if tver == 1 else 12)
        mver = moov[md[0] + md[1]]
        tsc_off = md[0] + md[1] + (20 if mver == 1 else 12)
        if bits != 16 or not (1 <= channels <= 2) or not rate:
            return None
        return {
            "track_id": struct.unpack(">I", moov[tid_off:tid_off + 4])[0],
            "timescale": struct.unpack(">I", moov[tsc_off:tsc_off + 4])[0] or rate,
            "rate": rate,
            "channels": channels,
            "big_endian": big_endian,
        }
    return None


def _wav_header(rate: int, channels: int, data_size: int) -> bytes:
    block = channels * 2
    return (b"RIFF" + struct.pack("<I", 36 + data_size) + b"WAVE"
            + b"fmt " + struct.pack("<IHHIIHH", 16, 1, channels, rate, rate * block, block, 16)
            + b"data" + struct.pack("<I", data_size))


def _audio_layout(audio: dict, frags: list[tuple[int | None, int, int]],
                  video_t0_sec: float, video_dur_sec: float) -> dict:
    """Lay the PCM fragments out on the video's timeline (data byte 0 = video
    t=0), using each fragment's decode time when the file has them."""
    rate, frame = audio["rate"], 2 * audio["channels"]
    tol = int(_AUDIO_RESYNC_SEC * rate) * frame
    segments: list[tuple[int, int, int]] = []
    pos = 0  # data bytes laid out so far
    clock = 0  # source bytes seen so far (time base when there is no tfdt)
    for decode_time, src, length in frags:
        length -= length % frame
        if decode_time is not None:
            t = decode_time / audio["timescale"]
        else:
            t = (clock // frame) / rate
        clock += length
        want = round((t - video_t0_sec) * rate) * frame
        # The first fragment is placed exactly (that IS the sync with the
        # picture); later ones only when they drift past the tolerance.
        t_ok = tol if segments else 0
        if want - pos > t_ok:  # a hole in the sound: fill with silence
            segments.append((pos, -1, want - pos))
            pos = want
        elif pos - want > t_ok:  # overlap, or sound before the picture starts
            cut = min(length, pos - want)
            src, length = src + cut, length - cut
        if length > 0:
            segments.append((pos, src, length))
            pos += length
    # Don't run past the picture (a trailing silence would just play on).
    limit = int(video_dur_sec * rate) * frame + rate // 2 * frame
    if video_dur_sec and pos > limit:
        clipped: list[tuple[int, int, int]] = []
        for d, s, n in segments:
            if d >= limit:
                break
            clipped.append((d, s, min(n, limit - d)))
        segments, pos = clipped, limit
    if not segments or pos <= 0:
        return {}
    return {
        "audio_header": _wav_header(rate, audio["channels"], pos),
        "audio_segments": tuple(segments),
        "audio_data_starts": tuple(d for d, _s, _n in segments),
        "audio_data_size": pos,
        "audio_swap": audio["big_endian"],
        "audio_sample_rate": rate,
        "audio_channels": audio["channels"],
    }


def _iter_audio_data(index: RemuxIndex, start: int, end: int,
                     chunk: int) -> Iterator[bytes]:
    """Raw source PCM for data bytes [start, end] (inclusive), as stored."""
    src: BinaryIO | None = None
    pos = start
    try:
        i = bisect_right(index.audio_data_starts, pos) - 1
        while pos <= end and i < len(index.audio_segments):
            d0, s0, n = index.audio_segments[i]
            within = pos - d0
            need = min(n - within, end - pos + 1)
            if need <= 0:
                i += 1
                continue
            if s0 < 0:
                while need > 0:
                    k = min(chunk, need)
                    yield bytes(k)
                    need -= k
                    pos += k
            else:
                if src is None:
                    # Through the host reader when there is one. The sound sits
                    # in ~1 s pieces between the video, so fetch just each
                    # piece (small block), not the video around it.
                    src = open_recording(
                        index.src_path, block=16 * 1024, offset=s0 + within
                    )
                src.seek(s0 + within)
                while need > 0:
                    data = src.read(min(chunk, need))
                    if not data:
                        recording_logger.warning(
                            "virtual audio: source truncated mid-read: %s", index.src_path
                        )
                        return
                    yield data
                    need -= len(data)
                    pos += len(data)
            i += 1
    finally:
        if src is not None:
            src.close()


def iter_audio_range(
    index: RemuxIndex, start: int, end: int, chunk: int = 64 * 1024
) -> Iterator[bytes]:
    """Yield the virtual WAV's bytes for the INCLUSIVE range [start, end]."""
    total = index.audio_total_size
    if not index.has_audio or start < 0 or end >= total or start > end:
        return
    hlen = len(index.audio_header)
    if start < hlen:
        upto = min(end, hlen - 1)
        yield index.audio_header[start:upto + 1]
        start = upto + 1
        if start > end:
            return
    d0, d1 = start - hlen, end - hlen
    swap = index.audio_swap
    # Swapping works on whole 16-bit samples: read from the even byte at or
    # before d0, and carry an odd byte over between source reads.
    a0 = d0 - (d0 % 2) if swap else d0
    skip = d0 - a0
    left = d1 - d0 + 1
    carry = b""
    # with swapping, also read through the end of the last sample touched
    a1 = min(d1 + (1 - d1 % 2), index.audio_data_size - 1) if swap else d1
    for data in _iter_audio_data(index, a0, a1, chunk - chunk % 2):
        if swap:
            data = carry + data
            even = len(data) - len(data) % 2
            carry = data[even:]
            arr = array("h", data[:even])
            arr.byteswap()  # a byte operation: BE pairs -> LE, on any host
            data = arr.tobytes()
        if skip:
            data, skip = data[skip:], max(0, skip - len(data))
        if not data:
            continue
        if len(data) >= left:
            yield data[:left]
            return
        yield data
        left -= len(data)


def iter_index_range(
    index: RemuxIndex, start: int, end: int, chunk: int = 64 * 1024
) -> Iterator[bytes]:
    """Yield the virtual file's bytes for the INCLUSIVE range [start, end].

    Header bytes come from RAM; everything else is seek+read from the source
    recording. A source truncated mid-stream (rotated/deleted) ends the body
    short — the client re-requests and gets a clean error then.
    """
    if start < 0 or end >= index.total_size or start > end:
        return
    hlen = len(index.header)
    pos = start
    src: BinaryIO | None = None
    try:
        while pos <= end:
            if pos < hlen:
                upto = min(end, hlen - 1)
                yield index.header[pos:upto + 1]
                pos = upto + 1
                continue
            # locate the run containing `pos`
            i = bisect_right(index.run_out_starts, pos) - 1
            src_off, run_len = index.runs[i]
            within = pos - index.run_out_starts[i]
            need = min(run_len - within, end - pos + 1)
            if src is None:
                # opened lazily (header-only ranges never touch the source);
                # closed in the finally below — the generator outlives a `with`
                src = open_recording(
                    index.src_path, block=1 << 20, offset=src_off + within
                )
            src.seek(src_off + within)
            while need > 0:
                data = src.read(min(chunk, need))
                if not data:
                    recording_logger.warning(
                        "virtual remux: source truncated mid-read: %s",
                        index.src_path,
                    )
                    return
                yield data
                need -= len(data)
                pos += len(data)
    finally:
        if src is not None:
            src.close()


def remux_to_browser_mp4(src_path: str | Path, dst_path: str | Path) -> None:
    """Materialize the browser-playable MP4 to ``dst_path``.

    Reference implementation of what the virtual endpoint serves (used by
    tests as the byte-equivalence oracle, and handy for tooling/export).
    """
    index = build_remux_index(src_path)
    tmp = str(dst_path) + ".partial"
    with open(tmp, "wb") as out:
        for data in iter_index_range(index, 0, index.total_size - 1, chunk=1 << 20):
            out.write(data)
    os.replace(tmp, dst_path)


# ---------------------------------------------------------------------------
# In-RAM index LRU (a few MB per open recording; rebuilt when the file changes)
# ---------------------------------------------------------------------------

MAX_CACHED_INDEXES = 8

# Thread-safe LRU for indexes built while creating a playback session (that
# runs in a worker thread) and by the read-ahead that warms the files a viewer
# reaches next. Sized for a few tiles each holding a file plus read-ahead.
MAX_SESSION_INDEXES = 48
_session_indexes: OrderedDict[str, RemuxIndex] = OrderedDict()
_session_indexes_lock = threading.Lock()


def remux_index_cached(src_path: str | Path) -> RemuxIndex:
    """:func:`build_remux_index`, reusing a cached index while the file is
    unchanged (same size and mtime). Blocking — call from a worker thread.
    Raises like :func:`build_remux_index`."""
    src_path = os.path.abspath(src_path)
    st = stat_recording(src_path)
    with _session_indexes_lock:
        idx = _session_indexes.get(src_path)
        if _index_current(idx, st):
            _session_indexes.move_to_end(src_path)
            return idx
    idx = build_remux_index(src_path)
    with _session_indexes_lock:
        _session_indexes[src_path] = idx
        _session_indexes.move_to_end(src_path)
        while len(_session_indexes) > MAX_SESSION_INDEXES:
            _session_indexes.popitem(last=False)
    return idx

_indexes: OrderedDict[str, RemuxIndex] = OrderedDict()
_locks: dict[str, asyncio.Lock] = {}


def _index_current(idx: RemuxIndex | None, st) -> bool:
    return (
        idx is not None
        and idx.src_size == st.st_size
        and idx.src_mtime == int(st.st_mtime)
    )


async def get_remux_index(src_path: str) -> RemuxIndex | None:
    """Return the (cached or freshly built) :class:`RemuxIndex` for a recording.

    Builds off the event loop, serializes concurrent builds per file, and keeps
    at most ``MAX_CACHED_INDEXES`` recipes in RAM. A source that changed on
    disk (a recording still being written) is transparently re-indexed — the
    scan touches only box headers, so this is sub-second even for hour files.
    Returns None on failure so the caller can report the file unplayable.
    """
    src_path = os.path.abspath(src_path)
    try:
        st = stat_recording(src_path)
    except FileNotFoundError:
        _indexes.pop(src_path, None)
        return None

    idx = _indexes.get(src_path)
    if _index_current(idx, st):
        _indexes.move_to_end(src_path)
        return idx

    if len(_locks) > 512:  # drop idle locks so the dict can't grow unbounded
        for k in [k for k, v in _locks.items() if not v.locked()]:
            _locks.pop(k, None)
    lock = _locks.setdefault(src_path, asyncio.Lock())
    async with lock:
        try:
            st = stat_recording(src_path)
        except FileNotFoundError:
            _indexes.pop(src_path, None)
            return None
        idx = _indexes.get(src_path)
        if _index_current(idx, st):
            _indexes.move_to_end(src_path)
            return idx
        try:
            idx = await asyncio.to_thread(build_remux_index, src_path)
        except Exception as e:
            recording_logger.error("remux index build failed for %s: %s", src_path, e)
            _indexes.pop(src_path, None)
            return None
        _indexes[src_path] = idx
        _indexes.move_to_end(src_path)
        while len(_indexes) > MAX_CACHED_INDEXES:
            _indexes.popitem(last=False)
        recording_logger.info(
            "remux index built: %s (%d runs, header %.1f KB, virtual size %.1f MB)",
            os.path.basename(src_path), len(idx.runs),
            len(idx.header) / 1024, idx.total_size / 1e6,
        )
        return idx
