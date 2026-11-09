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

"""Open a recording for reading: through the host reader when one is set up,
else straight from the mount.

On Docker Desktop for macOS the recordings mount is served by a file-sharing
layer that reads an external drive at a few MB/s with ~10 ms per small read,
far too slow for fast playback. ``scripts/recording-reader`` runs on the host
and serves the same files over HTTP at 100+ MB/s. When
``RECORDING_READER_URL`` and ``RECORDING_READER_TOKEN`` are set,
:func:`open_recording` returns a seekable file object backed by HTTP Range
requests to it.

Any failure falls back to the mount, so a stopped reader only costs speed:
opening falls back at once, and a read that fails mid-file finishes from the
mount at the same offset. After a failure the reader is skipped for
:data:`RETRY_AFTER_SECONDS`.
"""

from __future__ import annotations

import http.client
import io
import logging
import os
import re
import threading
import time
from typing import BinaryIO, NamedTuple
from urllib.parse import quote, urlsplit

logger = logging.getLogger("opennvr.recording")

RETRY_AFTER_SECONDS = 30.0
_TIMEOUT = 10.0
_MAX_IDLE = 16
_CONTENT_RANGE = re.compile(r"bytes (\d+)-(\d+)/(\d+)")

_pool: list[http.client.HTTPConnection] = []
_pool_lock = threading.Lock()
_down_until = 0.0


class _ReaderError(Exception):
    """The reader could not serve the request (any cause): use the mount."""


def _config() -> tuple[str, int, str, str] | None:
    url = os.getenv("RECORDING_READER_URL", "").strip()
    token = os.getenv("RECORDING_READER_TOKEN", "").strip()
    if not url or not token:
        return None
    u = urlsplit(url)
    if u.scheme != "http" or not u.hostname:
        return None
    base = os.getenv("RECORDINGS_BASE_PATH", "/app/recordings").rstrip("/")
    return u.hostname, u.port or 80, token, base


def reader_available() -> bool:
    """True when a reader is configured and not in its post-failure back-off."""
    return _config() is not None and time.monotonic() >= _down_until


def _mark_down(why: str) -> None:
    global _down_until
    first = time.monotonic() >= _down_until
    _down_until = time.monotonic() + RETRY_AFTER_SECONDS
    if first:
        logger.warning(
            "recording reader unavailable (%s); reading from the mount for %.0fs",
            why, RETRY_AFTER_SECONDS,
        )


def _get_conn(host: str, port: int) -> http.client.HTTPConnection:
    with _pool_lock:
        while _pool:
            c = _pool.pop()
            if (c.host, c.port) == (host, port):
                return c
            c.close()
    return http.client.HTTPConnection(host, port, timeout=_TIMEOUT)


def _put_conn(c: http.client.HTTPConnection) -> None:
    with _pool_lock:
        if len(_pool) < _MAX_IDLE:
            _pool.append(c)
            return
    c.close()


def _fetch(cfg, rel: str, start: int, end: int) -> tuple[bytes, int]:
    """Bytes [start, end] (inclusive, clipped to EOF) and the file's size.

    Retries once on a fresh connection, since the reader closes idle
    keep-alive connections. Past EOF returns (b"", size)."""
    host, port, token, _base = cfg
    headers = {"Authorization": f"Bearer {token}", "Range": f"bytes={start}-{end}"}
    last: Exception | None = None
    for _attempt in range(2):
        c = _get_conn(host, port)
        try:
            c.request("GET", "/f/" + quote(rel), headers=headers)
            r = c.getresponse()
            body = r.read()
        except (OSError, http.client.HTTPException) as e:
            c.close()
            last = e
            continue
        if r.will_close:
            c.close()
        else:
            _put_conn(c)
        if r.status == 206:
            m = _CONTENT_RANGE.match(r.getheader("Content-Range", ""))
            if not m or int(m.group(1)) != start:
                raise _ReaderError("bad Content-Range")
            return body, int(m.group(3))
        if r.status == 416:
            m = re.search(r"/(\d+)$", r.getheader("Content-Range", ""))
            return b"", int(m.group(1)) if m else start
        if r.status == 404:
            raise FileNotFoundError(rel)
        raise _ReaderError(f"HTTP {r.status}")
    raise _ReaderError(str(last))


def _head(cfg, rel: str) -> tuple[int, int]:
    """(size, mtime) of a file from the reader, without reading it."""
    host, port, token, _base = cfg
    last: Exception | None = None
    for _attempt in range(2):
        c = _get_conn(host, port)
        try:
            c.request("HEAD", "/f/" + quote(rel),
                      headers={"Authorization": f"Bearer {token}"})
            r = c.getresponse()
            r.read()
        except (OSError, http.client.HTTPException) as e:
            c.close()
            last = e
            continue
        if r.will_close:
            c.close()
        else:
            _put_conn(c)
        if r.status == 200:
            try:
                return int(r.getheader("Content-Length")), int(r.getheader("X-Mtime"))
            except (TypeError, ValueError):
                raise _ReaderError("bad HEAD reply") from None
        if r.status == 404:
            raise FileNotFoundError(rel)
        raise _ReaderError(f"HTTP {r.status}")
    raise _ReaderError(str(last))


class RecordingStat(NamedTuple):
    st_size: int
    st_mtime: float


def stat_recording(path: str | os.PathLike) -> RecordingStat:
    """Size and mtime of a recording, from the reader when available (one
    round trip) else :func:`os.stat` on the mount (~10-40 ms each on Docker
    Desktop's file sharing). Raises ``FileNotFoundError`` like ``os.stat``."""
    path = os.fspath(path)
    target = _reader_target(path)
    if target is not None:
        cfg, _full, rel = target
        try:
            size, mtime = _head(cfg, rel)
            return RecordingStat(size, float(mtime))
        except FileNotFoundError:
            pass  # the mount decides
        except _ReaderError as e:
            _mark_down(str(e))
    st = os.stat(path)
    return RecordingStat(st.st_size, st.st_mtime)


def _reader_target(path: str):
    """(cfg, absolute path, path relative to the reader root), or None when the
    reader is off, backing off, or doesn't serve this path."""
    cfg = _config()
    if cfg is None or time.monotonic() < _down_until:
        return None
    full = os.path.abspath(path)
    if not full.startswith(cfg[3] + "/"):
        return None
    return cfg, full, full[len(cfg[3]) + 1:]


class ReaderFile(io.RawIOBase):
    """Read-only, seekable view of one recording served by the host reader.

    Each miss fetches ``block`` bytes from the position, so header walks
    (``block`` small) cost one round trip per fragment and streaming
    (``block`` large) one per MB. ``size`` is the file's size when first
    read; a file still being written is seen as of then, like a snapshot.
    """

    def __init__(self, cfg, path: str, rel: str, block: int, offset: int = 0):
        super().__init__()
        self._cfg = cfg
        self.name = path
        self._rel = rel
        self._block = block
        self._pos = offset
        self._buf = b""
        self._buf_start = 0
        self._size: int | None = None
        self._local: BinaryIO | None = None
        # Fetch the first block now: confirms the reader can serve this file
        # (so open_recording can fall back before anyone reads) and learns
        # the size.
        self._fill(offset, 0)

    # -- io.RawIOBase ---------------------------------------------------------

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, pos: int, whence: int = io.SEEK_SET) -> int:
        if whence == io.SEEK_CUR:
            pos += self._pos
        elif whence == io.SEEK_END:
            pos += self.size
        if pos < 0:
            raise ValueError("negative seek position")
        self._pos = pos
        return pos

    @property
    def size(self) -> int:
        assert self._size is not None
        return self._size

    def read(self, n: int = -1) -> bytes:
        if n is None or n < 0:
            n = max(0, self.size - self._pos)
        out = bytearray()
        while len(out) < n and self._pos < self.size:
            off = self._pos - self._buf_start
            if not (0 <= off < len(self._buf)):
                if not self._fill(self._pos, n - len(out)):
                    break
                off = 0
            take = self._buf[off:off + (n - len(out))]
            out += take
            self._pos += len(take)
        return bytes(out)

    def readinto(self, b) -> int:
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)

    def close(self) -> None:
        if self._local is not None:
            self._local.close()
        self._buf = b""
        super().close()

    # -- internals ------------------------------------------------------------

    def _fill(self, pos: int, want: int) -> bool:
        """Load the block at ``pos`` into the buffer. False at EOF."""
        if self._local is None:
            try:
                data, size = _fetch(
                    self._cfg, self._rel, pos, pos + max(want, self._block) - 1
                )
                self._size = size
                self._buf, self._buf_start = data, pos
                return bool(data)
            except FileNotFoundError:
                if self._size is None:
                    raise
                return False  # deleted mid-read (retention): ends short
            except _ReaderError as e:
                if self._size is None:
                    raise  # still opening: open_recording falls back
                _mark_down(str(e))
                self._local = open(self.name, "rb")  # noqa: SIM115
        # The reader failed mid-file: finish from the mount at this offset.
        self._local.seek(pos)
        data = self._local.read(max(want, self._block))
        self._buf, self._buf_start = data, pos
        return bool(data)


def open_recording(
    path: str | os.PathLike, block: int = 64 * 1024, offset: int = 0
) -> BinaryIO:
    """Open a recording read-only, through the host reader when available.

    ``block`` is the reader's fetch size: small for header walks, ~1 MB for
    streaming. ``offset`` is where reading will start (the file is positioned
    there). Raises ``FileNotFoundError`` like :func:`open`.
    """
    path = os.fspath(path)
    target = _reader_target(path)
    if target is not None:
        cfg, full, rel = target
        try:
            return ReaderFile(cfg, full, rel, block, offset)
        except FileNotFoundError:
            pass  # the mount decides (and raises if it's really gone)
        except _ReaderError as e:
            _mark_down(str(e))
    f = open(path, "rb")  # noqa: SIM115
    f.seek(offset)
    return f


def file_size(f: BinaryIO) -> int:
    """Size of a file from :func:`open_recording` (either kind)."""
    if isinstance(f, ReaderFile):
        return f.size
    return os.fstat(f.fileno()).st_size
