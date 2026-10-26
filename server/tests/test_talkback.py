# Copyright (c) 2026 OpenNVR
# Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0)
"""Talk-back tests — no hardware. The RTSP side runs against a fake camera
on loopback that speaks just enough of the ONVIF backchannel exchange.

The SDPs are verbatim from the cameras this was built for (Illumivue/Uniview
IP8TDL dual-lens turret and IP5VD360 fisheye): note the turret's m-line
names only payload 104 while its rtpmaps also offer PCMU, which the parser
has to accept.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import secrets
import struct
import sys
from array import array
from pathlib import Path
from types import SimpleNamespace

from cryptography.fernet import Fernet

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("DATABASE_URL", "postgresql://u:p@localhost/x")
os.environ.setdefault("SECRET_KEY", secrets.token_urlsafe(48))
os.environ.setdefault("MEDIAMTX_SECRET", secrets.token_hex(32))
os.environ.setdefault("INTERNAL_API_KEY", secrets.token_urlsafe(48))
os.environ.setdefault("CREDENTIAL_ENCRYPTION_KEY", Fernet.generate_key().decode())

from services import talkback  # noqa: E402

TURRET_SDP = """v=0
o=- 1 1 IN IP4 192.168.1.15
s=Media Presentation
t=0 0
a=control:rtsp://192.168.1.15/media/video2
m=video 0 RTP/AVP 108
a=control:rtsp://192.168.1.15/media/video2/video
a=rtpmap:108 H265/90000
a=recvonly
m=audio 0 RTP/AVP 104
a=rtpmap:104 mpeg4-generic/16000/1
a=control:rtsp://192.168.1.15/media/video2/audio1
a=recvonly
m=audio 0 RTP/AVP 104
a=control:rtsp://192.168.1.15/media/video2/backchannel
a=rtpmap:8 PCMA/8000
a=rtpmap:0 PCMU/8000
a=rtpmap:104 mpeg4-generic/8000/1
a=sendonly
m=application 0 RTP/AVP 107
a=control:rtsp://192.168.1.15/media/video2/metadata
a=rtpmap:107 vnd.onvif.metadata/90000
a=recvonly
""".replace("\n", "\r\n")

#: Storage Dome 2 with audio disabled on the stream: speaker, but no track.
NO_AUDIO_SDP = """v=0
s=Media Presentation
m=video 0 RTP/AVP 108
a=control:rtsp://192.168.1.21/media/video2/video
a=rtpmap:108 H265/90000
a=recvonly
m=application 0 RTP/AVP 107
a=control:rtsp://192.168.1.21/media/video2/metadata
a=recvonly
""".replace("\n", "\r\n")


# --- µ-law ---------------------------------------------------------------------


def test_ulaw_reference_values():
    # G.711 µ-law: silence is 0xFF (and 0x7F for -0), full scale 0x80 / 0x00.
    pcm = array("h", [0, 32767, -32768, 1000, -1000]).tobytes()
    out = talkback.pcm16_to_ulaw(pcm)
    assert out[0] == 0xFF
    assert out[1] == 0x80
    assert out[2] == 0x00
    assert out[3] == 0xCE
    assert out[4] == 0x4E


def test_ulaw_ignores_a_trailing_odd_byte():
    assert len(talkback.pcm16_to_ulaw(b"\x00\x00\x00")) == 1


# --- SDP / stream target --------------------------------------------------------


def test_parses_backchannel_when_m_line_omits_pcmu():
    ch = talkback.parse_backchannel(TURRET_SDP, "rtsp://192.168.1.15/media/video2/")
    assert ch is not None
    assert ch.control == "rtsp://192.168.1.15/media/video2/backchannel"


def test_no_sendonly_track_means_no_backchannel():
    assert talkback.parse_backchannel(NO_AUDIO_SDP, "rtsp://192.168.1.21/media/video2/") is None


def test_relative_control_joins_content_base():
    sdp = "v=0\r\nm=audio 0 RTP/AVP 0\r\na=control:track3\r\na=sendonly\r\n"
    ch = talkback.parse_backchannel(sdp, "rtsp://cam/live/")
    assert ch.control == "rtsp://cam/live/track3"


def _camera(**kw):
    base = dict(id=5, ip_address="10.9.9.9", rtsp_url=None, substream_url=None, username="admin", password="pw")
    return SimpleNamespace(**{**base, **kw})


def test_stream_target_prefers_substream_and_url_credentials():
    t = talkback.stream_target(_camera(
        rtsp_url="rtsp://a:b@10.0.0.5:554/media/video1",
        substream_url="rtsp://u%40x:p%3Aw@10.0.0.5:8554/media/video2",
    ))
    assert (t.host, t.port, t.username, t.password) == ("10.0.0.5", 8554, "u@x", "p:w")
    assert t.url == "rtsp://10.0.0.5:8554/media/video2"  # no userinfo on the wire


def test_stream_target_falls_back_to_stored_login():
    t = talkback.stream_target(_camera(rtsp_url="rtsp://10.0.0.5/media/video1"))
    assert (t.port, t.username, t.password) == (554, "admin", "pw")


def test_stream_target_needs_an_rtsp_url():
    assert talkback.stream_target(_camera()) is None
    assert talkback.stream_target(_camera(rtsp_url="http://10.0.0.5/x")) is None


# --- end to end against a fake camera -------------------------------------------


class FakeCamera:
    """Digest-protected RTSP server offering the turret's backchannel."""

    realm, nonce, user, pw = "e4f14c9a82cd", "abc123", "admin", "pw"

    def __init__(self, sdp: str = TURRET_SDP):
        self.sdp = sdp
        self.methods: list[str] = []
        self.packets: list[bytes] = []
        self.setup_headers: dict[str, str] = {}
        self.authorized = 0

    def _auth_ok(self, method: str, uri: str, header: str) -> bool:
        p = dict(re.findall(r'(\w+)="([^"]*)"', header))
        ha1 = hashlib.md5(f"{self.user}:{self.realm}:{self.pw}".encode()).hexdigest()
        ha2 = hashlib.md5(f"{method}:{uri}".encode()).hexdigest()
        return p.get("response") == hashlib.md5(f"{ha1}:{self.nonce}:{ha2}".encode()).hexdigest()

    async def handle(self, reader, writer):
        try:
            while True:
                first = await reader.readexactly(1)
                if first == b"$":
                    hdr = await reader.readexactly(3)
                    self.packets.append(await reader.readexactly(struct.unpack(">H", hdr[1:])[0]))
                    continue
                head = first + await reader.readuntil(b"\r\n\r\n")
                lines = head.decode().split("\r\n")
                method, uri, _ = lines[0].split(" ")
                h = {k.lower(): v.strip() for k, _, v in
                     (line.partition(":") for line in lines[1:] if line)}
                self.methods.append(method)
                cseq = h["cseq"]
                if not self._auth_ok(method, uri, h.get("authorization", "")):
                    writer.write((f"RTSP/1.0 401 Unauthorized\r\nCSeq: {cseq}\r\n"
                                  f'WWW-Authenticate: Digest realm="{self.realm}",'
                                  f'nonce="{self.nonce}", stale="FALSE"\r\n\r\n').encode())
                    continue
                self.authorized += 1
                if method == "DESCRIBE":
                    assert h.get("require") == talkback.BACKCHANNEL_REQUIRE
                    body = self.sdp.encode()
                    writer.write((f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\n"
                                  "Content-Type: application/sdp\r\n"
                                  "Content-Base: rtsp://192.168.1.15/media/video2/\r\n"
                                  f"Content-Length: {len(body)}\r\n\r\n").encode() + body)
                elif method == "SETUP":
                    self.setup_headers = {"uri": uri, **h}
                    writer.write((f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\n"
                                  "Session: 7777;timeout=60\r\n"
                                  "Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n").encode())
                elif method == "PLAY":
                    assert h.get("session") == "7777"
                    writer.write(f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\n\r\n".encode())
                    # A camera may talk RTCP at us mid-session; must be drained.
                    writer.write(b"$\x01\x00\x04abcd")
                elif method == "TEARDOWN":
                    writer.write(f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\n\r\n".encode())
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()


async def _with_camera(cam: FakeCamera, fn):
    server = await asyncio.start_server(cam.handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    target = talkback.StreamTarget("127.0.0.1", port, f"rtsp://127.0.0.1:{port}/media/video2",
                                   cam.user, cam.pw)
    try:
        return await fn(target)
    finally:
        server.close()
        await server.wait_closed()


def test_talk_session_sends_rtp_pcmu_over_the_backchannel():
    cam = FakeCamera()

    async def run(target):
        s = talkback.TalkSession(target)
        await s.open()
        await s.send_pcm(array("h", [0] * 400).tobytes())  # 2 packets + 80 left over
        await s.send_pcm(array("h", [0] * 80).tobytes())  # completes the third
        await s.close()
        await asyncio.sleep(0.05)

    asyncio.run(_with_camera(cam, run))

    assert cam.methods.count("DESCRIBE") == 2  # challenge, then authorized
    assert cam.methods[-4:] == ["DESCRIBE", "SETUP", "PLAY", "TEARDOWN"]
    assert cam.setup_headers["uri"] == "rtsp://192.168.1.15/media/video2/backchannel"
    assert "interleaved=0-1" in cam.setup_headers["transport"]
    assert cam.setup_headers["require"] == talkback.BACKCHANNEL_REQUIRE

    assert len(cam.packets) == 3
    heads = [struct.unpack(">BBHII", p[:12]) for p in cam.packets]
    assert all(v == 0x80 for v, *_ in heads)
    assert [m & 0x7F for _, m, *_ in heads] == [0, 0, 0]  # PCMU
    assert [m >> 7 for _, m, *_ in heads] == [1, 0, 0]  # marker on the first only
    seqs = [h[2] for h in heads]
    tss = [h[3] for h in heads]
    assert [(b - a) & 0xFFFF for a, b in zip(seqs, seqs[1:])] == [1, 1]
    assert [(b - a) & 0xFFFFFFFF for a, b in zip(tss, tss[1:])] == [160, 160]
    assert len({h[4] for h in heads}) == 1
    assert all(p[12:] == b"\xff" * 160 for p in cam.packets)


async def _no(_camera):
    return False


def test_capability_line_out_is_not_a_speaker(monkeypatch):
    async def speaker(_camera):
        return True

    async def line_out(_camera):
        return True

    monkeypatch.setattr(talkback, "_has_audio_output", speaker)
    monkeypatch.setattr(talkback, "_uniview_line_out", line_out)
    got = asyncio.run(talkback._probe_capability(_camera(rtsp_url="rtsp://10.9.9.9/x")))
    assert got["reason"] == "line_out"


def test_capability_reports_missing_backchannel(monkeypatch):
    cam = FakeCamera(sdp=NO_AUDIO_SDP)

    async def speaker(_camera):
        return True

    monkeypatch.setattr(talkback, "_has_audio_output", speaker)
    monkeypatch.setattr(talkback, "_uniview_line_out", _no)

    async def run(target):
        monkeypatch.setattr(talkback, "stream_target", lambda _c: target)
        return await talkback._probe_capability(_camera())

    assert asyncio.run(_with_camera(cam, run)) == {
        "supported": False, "reason": "no_backchannel", "codec": None}


def test_capability_without_speaker_skips_rtsp(monkeypatch):
    async def no_speaker(_camera):
        return False

    monkeypatch.setattr(talkback, "_has_audio_output", no_speaker)
    got = asyncio.run(talkback._probe_capability(_camera(rtsp_url="rtsp://10.9.9.9/x")))
    assert got["reason"] == "no_speaker"


def test_capability_supported(monkeypatch):
    cam = FakeCamera()

    async def speaker(_camera):
        return True

    monkeypatch.setattr(talkback, "_has_audio_output", speaker)
    monkeypatch.setattr(talkback, "_uniview_line_out", _no)

    async def run(target):
        monkeypatch.setattr(talkback, "stream_target", lambda _c: target)
        return await talkback._probe_capability(_camera())

    assert asyncio.run(_with_camera(cam, run)) == {
        "supported": True, "reason": None, "codec": "PCMU"}


def test_one_talker_per_camera():
    assert talkback.claim(99, "alice")
    assert not talkback.claim(99, "bob")
    assert talkback.current_talker(99) == "alice"
    talkback.release(99)
    assert talkback.claim(99, "bob")
    talkback.release(99)
