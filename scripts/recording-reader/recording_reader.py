#!/usr/bin/env python3
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

"""Serve the recordings folder read-only over HTTP, from the host.

Why: Docker Desktop on macOS shares host folders into containers through a
file-sharing layer that reads an external drive at a few MB/s, with ~10 ms per
small read. Playback (above all at 8x) needs far more. This process runs on the
Mac itself, where the same drive reads at 100+ MB/s, and core fetches byte
ranges from it through ``host.docker.internal`` instead of reading the mount.

What it allows, and nothing else:

* ``GET``/``HEAD /f/<path>``: bytes of one regular file under ``--root``, with
  single-range ``Range`` support. Paths that resolve outside the root (``..``,
  symlinks) are refused.
* ``GET /health``: ``ok``. No token needed; reveals nothing.

Every ``/f/`` request must carry ``Authorization: Bearer <token>``; the token is
read from ``--token-file`` (mode 600). It binds to loopback only, so nothing
else on the network can reach it; Docker Desktop forwards
``host.docker.internal`` to the host loopback.

Standard library only, Python 3.9+ (macOS's /usr/bin/python3).
"""

from __future__ import annotations

import argparse
import hmac
import os
import re
import stat
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")
_CHUNK = 1 << 20


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive: core reuses connections
    server_version = "OpenNVRRecordingReader/1"
    sys_version = ""
    timeout = 60  # drop idle keep-alive connections
    disable_nagle_algorithm = True  # small range replies go out at once

    root: str = ""
    token: bytes = b""

    def log_message(self, fmt, *args):  # quiet: one line per error only
        pass

    def _reply(self, code: int, body: bytes = b"", extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Type", "text/plain")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _authorized(self) -> bool:
        got = self.headers.get("Authorization", "")
        if not got.startswith("Bearer "):
            return False
        return hmac.compare_digest(got[7:].strip().encode(), self.token)

    def _resolve(self) -> str | None:
        rel = unquote(self.path[3:].split("?", 1)[0])
        if not rel or "\x00" in rel:
            return None
        full = os.path.realpath(os.path.join(self.root, rel.lstrip("/")))
        if not full.startswith(self.root + os.sep):
            return None
        return full

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if self.path == "/health":
            self._reply(200, b"ok")
            return
        if not self.path.startswith("/f/"):
            self._reply(404, b"not found")
            return
        if not self._authorized():
            self._reply(401, b"unauthorized")
            return
        full = self._resolve()
        if full is None:
            self._reply(403, b"forbidden")
            return
        try:
            fd = os.open(full, os.O_RDONLY)
        except FileNotFoundError:
            self._reply(404, b"not found")
            return
        except OSError as e:
            self._reply(503, f"open failed: {e.strerror}".encode())
            return
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                self._reply(403, b"forbidden")
                return
            self._send_file(fd, st)
        finally:
            os.close(fd)

    def _send_file(self, fd: int, st: os.stat_result) -> None:
        total = st.st_size
        start, end = 0, total - 1
        rng = self.headers.get("Range")
        partial = False
        if rng:
            m = _RANGE.match(rng.strip())
            if not m or (not m.group(1) and not m.group(2)):
                self._reply(400, b"bad range")
                return
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), total - 1) if m.group(2) else total - 1
            else:  # suffix range: the last N bytes
                start = max(0, total - int(m.group(2)))
            if start >= total or start > end:
                self._reply(416, b"", {"Content-Range": f"bytes */{total}"})
                return
            partial = True
        length = end - start + 1 if total else 0
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("X-Mtime", str(int(st.st_mtime)))
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        self.end_headers()
        if self.command == "HEAD" or length == 0:
            return
        pos, left = start, length
        while left > 0:
            data = os.pread(fd, min(_CHUNK, left), pos)
            if not data:  # file shrank under us: end short, client retries
                self.close_connection = True
                return
            self.wfile.write(data)
            pos += len(data)
            left -= len(data)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--root", required=True, help="recordings folder to serve")
    ap.add_argument("--token-file", required=True)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8790)
    a = ap.parse_args()

    with open(a.token_file, "rb") as f:
        token = f.read().strip()
    if len(token) < 32:
        print("token file must hold at least 32 characters", file=sys.stderr)
        return 2
    Handler.root = os.path.realpath(a.root)
    Handler.token = token

    # The drive may mount after login: wait for it rather than serving an
    # empty mount point (core falls back to its own reads meanwhile).
    while not os.path.isdir(Handler.root):
        time.sleep(5)

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        allow_reuse_address = True
        request_queue_size = 64

    srv = Server((a.bind, a.port), Handler)
    print(f"serving {Handler.root} on {a.bind}:{a.port}", flush=True)
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
