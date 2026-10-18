# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Identity issuer for Anthropic Workload Identity Federation.

Signs short-lived ES256 JWTs that the Anthropic SDK in each Claude
workload (camera agent, caption adapter, footage search) exchanges for an
access token, so no static API key lives in .env. Anthropic verifies the
signature against the public key registered INLINE on the federation
issuer in the Claude Console, so nothing here is reachable from, or
fetched by, the internet: this container has no network at all.

    issuer.py serve   # default: keep one fresh token per workload on disk
    issuer.py jwks    # print the public key set to paste into the Console
    issuer.py check   # healthcheck: every token file is fresh

Files:
    /keys/signing-key.pem   EC P-256 private key, generated on first start,
                            never leaves this container's volume.
    /tokens/<workload>.jwt  the current assertion, rewritten every
                            ANTHROPIC_WIF_REFRESH_S; readable by the
                            workloads that mount the volume read-only.

Assertions carry no ``jti``: the SDK re-reads the file on every exchange,
and a restarted workload must be able to exchange the token already on
disk rather than wait for the next rewrite.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import time
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

KEY_PATH = Path(os.getenv("ANTHROPIC_WIF_KEY_PATH", "/keys/signing-key.pem"))
TOKEN_DIR = Path(os.getenv("ANTHROPIC_WIF_TOKEN_DIR", "/tokens"))
ISSUER = os.getenv("ANTHROPIC_WIF_ISSUER") or "https://opennvr.local/anthropic-wif"
AUDIENCE = os.getenv("ANTHROPIC_WIF_AUDIENCE") or "https://api.anthropic.com"
SUBJECT_PREFIX = "opennvr:"
WORKLOADS = [w.strip() for w in (os.getenv("ANTHROPIC_WIF_WORKLOADS")
             or "camera-agent,caption-adapter,footage-search").split(",") if w.strip()]
# Anthropic rejects assertions living longer than the issuer's maximum
# (1 h by default). The SDK only exchanges about once an hour, so a token
# needs to be valid at that moment, not for long.
LIFETIME_S = int(os.getenv("ANTHROPIC_WIF_TOKEN_LIFETIME_S", "600"))
REFRESH_S = int(os.getenv("ANTHROPIC_WIF_REFRESH_S", "120"))


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def load_or_create_key() -> ec.EllipticCurvePrivateKey:
    if KEY_PATH.exists():
        key = serialization.load_pem_private_key(KEY_PATH.read_bytes(), password=None)
        if not isinstance(key, ec.EllipticCurvePrivateKey):
            raise SystemExit(f"{KEY_PATH} is not an EC private key")
        return key
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(serialization.Encoding.PEM,
                            serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption())
    KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(KEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(pem)
    print(f"generated a new signing key at {KEY_PATH}; register its public "
          "key in the Claude Console (issuer.py jwks)", flush=True)
    return key


def public_jwk(key: ec.EllipticCurvePrivateKey) -> dict[str, str]:
    numbers = key.public_key().public_numbers()
    jwk = {
        "crv": "P-256",
        "kty": "EC",
        "x": _b64url(numbers.x.to_bytes(32, "big")),
        "y": _b64url(numbers.y.to_bytes(32, "big")),
    }
    # RFC 7638 thumbprint: required members only, sorted, no whitespace.
    thumbprint = hashlib.sha256(
        json.dumps(jwk, sort_keys=True, separators=(",", ":")).encode()).digest()
    return {**jwk, "kid": _b64url(thumbprint), "use": "sig", "alg": "ES256"}


def sign(key: ec.EllipticCurvePrivateKey, kid: str, claims: dict) -> str:
    header = {"alg": "ES256", "typ": "JWT", "kid": kid}
    signing_input = ".".join(
        _b64url(json.dumps(part, separators=(",", ":")).encode())
        for part in (header, claims))
    der = key.sign(signing_input.encode(), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    return f"{signing_input}.{_b64url(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


def mint(key: ec.EllipticCurvePrivateKey, kid: str, workload: str, now: int) -> str:
    return sign(key, kid, {
        "iss": ISSUER,
        "sub": SUBJECT_PREFIX + workload,
        "aud": AUDIENCE,
        "iat": now,
        "nbf": now,
        "exp": now + LIFETIME_S,
    })


def write_tokens(key: ec.EllipticCurvePrivateKey, kid: str) -> None:
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    now = int(time.time())
    for workload in WORKLOADS:
        target = TOKEN_DIR / f"{workload}.jwt"
        tmp = target.with_suffix(".jwt.tmp")
        tmp.write_text(mint(key, kid, workload, now))
        # World-readable on purpose: the workloads run as other users, and
        # only they mount this volume. A token is good for LIFETIME_S.
        tmp.chmod(0o644)
        tmp.replace(target)  # atomic: a reader never sees half a token


def serve() -> None:
    key = load_or_create_key()
    kid = public_jwk(key)["kid"]
    print(f"issuer {ISSUER}, key {kid}, workloads {', '.join(WORKLOADS)}; "
          f"{LIFETIME_S}s tokens rewritten every {REFRESH_S}s", flush=True)
    while True:
        write_tokens(key, kid)
        time.sleep(REFRESH_S)


def check() -> int:
    deadline = time.time() - 2 * REFRESH_S
    for workload in WORKLOADS:
        path = TOKEN_DIR / f"{workload}.jwt"
        if not path.exists() or path.stat().st_mtime < deadline:
            print(f"stale or missing: {path}", file=sys.stderr)
            return 1
    return 0


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else "serve"
    if command == "serve":
        serve()
    elif command == "jwks":
        print(json.dumps({"keys": [public_jwk(load_or_create_key())]}, indent=2))
    elif command == "check":
        return check()
    else:
        print(__doc__, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
