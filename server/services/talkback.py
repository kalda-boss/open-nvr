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

"""Talk-back — speak through a camera's speaker from the browser.

Uses the ONVIF audio BACKCHANNEL (ONVIF Streaming spec, "Back Channel
Connection"): a DESCRIBE sent with ``Require: www.onvif.org/ver20/backchannel``
returns an SDP with an extra ``a=sendonly`` audio track. OpenNVR SETUPs only
that track, over TCP-interleaved RTP, PLAYs, and sends G.711 µ-law into it.

The RTSP session is core's own, opened straight to the camera. It never goes
through MediaMTX, so starting or dropping a talk session cannot disturb live
view or recording.

A camera can talk only when BOTH hold:

* ONVIF ``GetAudioOutputs`` lists an output. Several cameras advertise a
  backchannel track with no speaker behind it (Uniview turrets do), and a
  talk button that plays into nothing is worse than none;
* its stream's SDP carries the sendonly backchannel track. A camera with a
  speaker but audio disabled on the stream offers no such track.

ONVIF can't tell a LINE OUT from a speaker: Uniview's IP5VD360 fisheye lists
an audio output that is only a connector, and a talk into it reaches nobody.
Where the camera speaks Uniview LAPI, its output mode settles it (0 =
Line_Out, anything else drives a speaker); a line-out reads ``line_out``.

The browser sends 16-bit little-endian PCM, 8 kHz mono; this module does the
µ-law encoding and RTP packetization (20 ms / 160 samples per packet).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import random
import re
import struct
import time
from array import array
from dataclasses import dataclass
from urllib.parse import unquote, urljoin, urlparse

import httpx

from core.logging_config import main_logger
from services import onvif_digest_service as ods
from services.camera_source_resolver import _build_rtsp_auth

BACKCHANNEL_REQUIRE = "www.onvif.org/ver20/backchannel"
SAMPLE_RATE = 8000
SAMPLES_PER_PACKET = 160  # 20 ms at 8 kHz
PT_PCMU = 0

#: Capability answers are cached this long; a probe costs an ONVIF call and an
#: RTSP DESCRIBE, and a camera's speaker doesn't come and go.
CAPABILITY_TTL_S = 600.0

_TIMEOUT = 6.0


# --- G.711 µ-law ------------------------------------------------------------


def _ulaw_encode_sample(sample: int) -> int:
    bias, clip = 0x84, 32635
    sign = 0x80 if sample < 0 else 0
    if sample < 0:
        sample = -sample
    sample = min(sample, clip) + bias
    exponent = 7
    mask = 0x4000
    while exponent > 0 and not sample & mask:
        exponent -= 1
        mask >>= 1
    mantissa = (sample >> (exponent + 3)) & 0x0F
    return ~(sign | (exponent << 4) | mantissa) & 0xFF


#: Every int16 value's µ-law byte, indexed by ``sample + 32768``.
_ULAW = bytes(_ulaw_encode_sample(s) for s in range(-32768, 32768))


def pcm16_to_ulaw(pcm: bytes) -> bytes:
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) & ~1])
    return bytes(_ULAW[s + 32768] for s in samples)


# --- capability ---------------------------------------------------------------


@dataclass
class StreamTarget:
    host: str
    port: int
    url: str  # rtsp URL without userinfo
    username: str
    password: str


def stream_target(camera) -> StreamTarget | None:
    """Where to open the backchannel: the camera's sub (else main) stream.

    Credentials come from the stream URL when it carries them (they are what
    MediaMTX authenticates with), else from the camera's stored login.
    """
    raw = camera.substream_url or camera.rtsp_url
    if not raw:
        return None
    try:
        p = urlparse(raw)
        port = p.port or 554
    except ValueError:
        return None
    if p.scheme.lower() != "rtsp" or not p.hostname:
        return None
    user = unquote(p.username) if p.username else (camera.username or "")
    pw = unquote(p.password) if p.password is not None else (camera.password or "")
    path = p.path or "/"
    if p.query:
        path += f"?{p.query}"
    return StreamTarget(p.hostname, port, f"rtsp://{p.hostname}:{port}{path}", user, pw)


@dataclass
class Backchannel:
    control: str  # absolute URL of the sendonly track
    base: str  # aggregate URL for PLAY / TEARDOWN


def parse_backchannel(sdp: str, base: str) -> Backchannel | None:
    """The sendonly PCMU audio track of a backchannel SDP, or None."""
    content_base = base
    sections = re.split(r"\r?\n(?=m=)", sdp)
    for section in sections[1:]:
        lines = section.splitlines()
        if not lines[0].startswith("m=audio") or "a=sendonly" not in lines:
            continue
        formats = lines[0].split()[3:]
        pcmu = str(PT_PCMU) in formats or any(
            re.match(r"a=rtpmap:0 PCMU/8000", line, re.I) for line in lines
        )
        control = next((line[len("a=control:"):] for line in lines
                        if line.startswith("a=control:")), None)
        if not pcmu or not control:
            continue
        if not control.lower().startswith("rtsp://"):
            control = urljoin(content_base.rstrip("/") + "/", control)
        return Backchannel(control=control, base=content_base)
    return None


async def _has_audio_output(camera) -> bool | None:
    """True/False from ONVIF GetAudioOutputs; None if ONVIF didn't answer."""
    from services.camera_drivers.registry import resolve_endpoint

    try:
        scheme, port = await resolve_endpoint(
            camera.id, camera.ip_address,
            getattr(camera, "onvif_port", None), getattr(camera, "control_scheme", None),
        )
        services = await ods.get_services(
            camera.ip_address, camera.username, camera.password, port, scheme
        )
        media = services.get("media") or f"{scheme}://{camera.ip_address}:{port}/onvif/Media"
        st, xml = await ods._onvif_request(
            media, "<trt:GetAudioOutputs/>", camera.username, camera.password
        )
    except Exception as e:  # noqa: BLE001 - a probe failure is an answer
        main_logger.info("talkback: GetAudioOutputs failed for camera %s: %s", camera.id, e)
        return None
    if st != 200:
        return False
    return bool(re.search(r"AudioOutputs\b[^>]*token=", xml))


async def _uniview_line_out(camera) -> bool:
    """True when a Uniview (LAPI) camera's audio output is a bare Line_Out.

    False for a speaker, and for any camera that doesn't answer LAPI at all:
    this only ever narrows what ONVIF already said.
    """
    url = f"http://{camera.ip_address}/LAPI/V1.0/Channels/0/Media/Audio/Output"
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            r = await client.get(url, auth=httpx.DigestAuth(camera.username or "",
                                                            camera.password or ""))
        data = json.loads(r.text)["Response"]
        if data.get("ResponseCode") != 0:
            return False
        return data["Data"].get("Type") == 0
    except Exception:  # noqa: BLE001 - not a LAPI camera, or not reachable
        return False


_capability_cache: dict[int, tuple[float, dict]] = {}


async def talk_capability(camera, *, force: bool = False) -> dict:
    """``{"supported", "reason", "codec"}`` for this camera (cached).

    ``reason`` when unsupported: ``no_stream`` (no usable rtsp URL),
    ``no_speaker``, ``line_out`` (an audio jack, no speaker), ``no_backchannel`` (speaker present but the stream offers
    no talk track, usually audio disabled on the camera) or ``unreachable``.
    """
    now = time.monotonic()
    hit = _capability_cache.get(camera.id)
    if hit and not force and now - hit[0] < CAPABILITY_TTL_S:
        return hit[1]
    result = await _probe_capability(camera)
    _capability_cache[camera.id] = (now, result)
    return result


async def _probe_capability(camera) -> dict:
    target = stream_target(camera)
    if target is None:
        return {"supported": False, "reason": "no_stream", "codec": None}
    speaker = await _has_audio_output(camera)
    if speaker is False:
        return {"supported": False, "reason": "no_speaker", "codec": None}
    if await _uniview_line_out(camera):
        return {"supported": False, "reason": "line_out", "codec": None}
    conn = RtspConnection(target)
    try:
        await conn.connect()
        channel = await conn.describe_backchannel()
    except (OSError, TimeoutError, RtspError) as e:
        main_logger.info("talkback: DESCRIBE failed for camera %s: %s", camera.id, e)
        return {"supported": False, "reason": "unreachable", "codec": None}
    finally:
        await conn.close()
    if channel is None:
        return {"supported": False, "reason": "no_backchannel", "codec": None}
    if speaker is None:
        # ONVIF was silent but the stream offers a talk track: offer it.
        main_logger.info("talkback: camera %s speaker unknown, backchannel present", camera.id)
    return {"supported": True, "reason": None, "codec": "PCMU"}


# --- RTSP ---------------------------------------------------------------------


class RtspError(Exception):
    pass


class RtspConnection:
    """A minimal RTSP client: one TCP connection, digest auth, interleaved RTP.

    Before PLAY, requests are answered in order (``request``). After PLAY the
    camera may send RTCP on the interleaved channel and answers keepalives,
    so a reader task drains everything and nothing waits on a reply.
    """

    def __init__(self, target: StreamTarget):
        self.t = target
        self.reader: asyncio.StreamReader | None = None
        self.writer: asyncio.StreamWriter | None = None
        self.cseq = 0
        self.www: str | None = None
        self.session: str | None = None
        self.session_timeout = 60
        self._drain_task: asyncio.Task | None = None

    async def connect(self) -> None:
        self.reader, self.writer = await asyncio.wait_for(
            asyncio.open_connection(self.t.host, self.t.port), _TIMEOUT
        )

    def _head(self, method: str, uri: str, headers: dict[str, str]) -> bytes:
        self.cseq += 1
        lines = [f"{method} {uri} RTSP/1.0", f"CSeq: {self.cseq}", "User-Agent: OpenNVR"]
        if self.www and self.t.username:
            auth = _build_rtsp_auth(method, uri, self.t.username, self.t.password, self.www)
            if auth:
                lines.append(f"Authorization: {auth}")
        if self.session:
            lines.append(f"Session: {self.session}")
        lines += [f"{k}: {v}" for k, v in headers.items()]
        return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1")

    async def _read_response(self) -> tuple[int, dict[str, str], str]:
        assert self.reader is not None
        while True:
            first = await asyncio.wait_for(self.reader.readexactly(1), _TIMEOUT)
            if first == b"$":  # an interleaved frame arriving early: skip it
                hdr = await asyncio.wait_for(self.reader.readexactly(3), _TIMEOUT)
                await asyncio.wait_for(self.reader.readexactly(struct.unpack(">H", hdr[1:])[0]), _TIMEOUT)
                continue
            status = first + await asyncio.wait_for(self.reader.readline(), _TIMEOUT)
            break
        parts = status.decode("latin-1", "replace").split()
        if len(parts) < 2 or not parts[1].isdigit():
            raise RtspError(f"bad status line {status!r}")
        headers: dict[str, str] = {}
        while True:
            line = await asyncio.wait_for(self.reader.readline(), _TIMEOUT)
            if not line or line in (b"\r\n", b"\n"):
                break
            k, _, v = line.decode("latin-1", "replace").partition(":")
            headers[k.strip().lower()] = v.strip()
        body = b""
        n = int(headers.get("content-length", "0") or 0)
        if n:
            body = await asyncio.wait_for(self.reader.readexactly(n), _TIMEOUT)
        return int(parts[1]), headers, body.decode("utf-8", "replace")

    async def request(self, method: str, uri: str, headers: dict[str, str] | None = None):
        assert self.writer is not None
        headers = headers or {}
        for _ in range(2):
            self.writer.write(self._head(method, uri, headers))
            await asyncio.wait_for(self.writer.drain(), _TIMEOUT)
            code, h, body = await self._read_response()
            if code == 401 and "www-authenticate" in h and self.www != h["www-authenticate"]:
                self.www = h["www-authenticate"]
                continue
            return code, h, body
        return code, h, body

    async def describe_backchannel(self) -> Backchannel | None:
        code, h, body = await self.request(
            "DESCRIBE", self.t.url,
            {"Accept": "application/sdp", "Require": BACKCHANNEL_REQUIRE},
        )
        if code == 551:  # Option not supported: no backchannel at all
            return None
        if code != 200:
            raise RtspError(f"DESCRIBE answered {code}")
        base = h.get("content-base") or h.get("content-location") or self.t.url
        return parse_backchannel(body, base)

    async def start(self, channel: Backchannel) -> None:
        code, h, _ = await self.request(
            "SETUP", channel.control,
            {"Transport": "RTP/AVP/TCP;unicast;interleaved=0-1",
             "Require": BACKCHANNEL_REQUIRE},
        )
        if code != 200 or "session" not in h:
            raise RtspError(f"SETUP answered {code}")
        sess, _, params = h["session"].partition(";")
        self.session = sess.strip()
        m = re.search(r"timeout=(\d+)", params)
        if m:
            self.session_timeout = max(int(m.group(1)), 10)
        code, _, _ = await self.request(
            "PLAY", channel.base, {"Range": "npt=0.000-", "Require": BACKCHANNEL_REQUIRE}
        )
        if code != 200:
            raise RtspError(f"PLAY answered {code}")
        self._drain_task = asyncio.create_task(self._drain())

    async def _drain(self) -> None:
        with contextlib.suppress(Exception):
            assert self.reader is not None
            while await self.reader.read(65536):
                pass

    def send_interleaved(self, channel: int, payload: bytes) -> None:
        assert self.writer is not None
        self.writer.write(b"$" + bytes([channel]) + struct.pack(">H", len(payload)) + payload)

    def keepalive(self, uri: str) -> None:
        assert self.writer is not None
        self.writer.write(self._head("GET_PARAMETER", uri, {}))

    async def close(self, teardown_uri: str | None = None) -> None:
        if self.writer is None:
            return
        with contextlib.suppress(Exception):
            if teardown_uri and self.session:
                self.writer.write(self._head("TEARDOWN", teardown_uri, {}))
                await asyncio.wait_for(self.writer.drain(), 2)
        if self._drain_task:
            self._drain_task.cancel()
        self.writer.close()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self.writer.wait_closed(), 2)
        self.writer = None


class TalkSession:
    """One open talk channel: feed it PCM, it sends RTP µ-law to the camera."""

    def __init__(self, target: StreamTarget):
        self.conn = RtspConnection(target)
        self.channel: Backchannel | None = None
        self.seq = random.randint(0, 0xFFFF)
        self.ts = random.randint(0, 0xFFFFFFFF)
        self.ssrc = random.randint(1, 0xFFFFFFFF)
        self.first = True
        self.pending = b""
        self.last_keepalive = time.monotonic()

    async def open(self) -> None:
        await self.conn.connect()
        self.channel = await self.conn.describe_backchannel()
        if self.channel is None:
            raise RtspError("camera offers no backchannel")
        await self.conn.start(self.channel)

    async def send_pcm(self, pcm: bytes) -> None:
        """Queue 16-bit LE 8 kHz mono PCM; whole 20 ms packets go out now."""
        assert self.channel is not None
        self.pending += pcm
        step = SAMPLES_PER_PACKET * 2
        while len(self.pending) >= step:
            chunk, self.pending = self.pending[:step], self.pending[step:]
            header = struct.pack(
                ">BBHII", 0x80, (0x80 if self.first else 0) | PT_PCMU,
                self.seq, self.ts, self.ssrc,
            )
            self.conn.send_interleaved(0, header + pcm16_to_ulaw(chunk))
            self.first = False
            self.seq = (self.seq + 1) & 0xFFFF
            self.ts = (self.ts + SAMPLES_PER_PACKET) & 0xFFFFFFFF
        if time.monotonic() - self.last_keepalive > self.conn.session_timeout / 2:
            self.conn.keepalive(self.channel.base)
            self.last_keepalive = time.monotonic()
        assert self.conn.writer is not None
        await asyncio.wait_for(self.conn.writer.drain(), _TIMEOUT)

    async def close(self) -> None:
        await self.conn.close(self.channel.base if self.channel else None)


#: Camera id -> username of whoever holds its speaker. One talker per camera:
#: two people speaking at once into one RTP stream would just be noise.
_active: dict[int, str] = {}


def claim(camera_id: int, username: str) -> bool:
    if camera_id in _active:
        return False
    _active[camera_id] = username
    return True


def release(camera_id: int) -> None:
    _active.pop(camera_id, None)


def current_talker(camera_id: int) -> str | None:
    return _active.get(camera_id)
