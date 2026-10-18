# syntax=docker/dockerfile:1.7
# OpenNVR identity issuer for Anthropic Workload Identity Federation.
#
# Signs the short-lived JWTs the Claude workloads exchange for access
# tokens, so no static ANTHROPIC_API_KEY is needed (see issuer.py and
# docs/ANTHROPIC_WIF.md). Runs with no network.
#
# Build (from the repo root):
#   docker build -f scripts/anthropic-issuer/Dockerfile -t opennvr/anthropic-issuer:local .

FROM python:3.12-alpine

# Pre-owned mount points: a fresh named volume copies this ownership,
# so the unprivileged user can write its key and tokens.
RUN pip install --no-cache-dir cryptography==50.0.2 \
 && adduser -D -H -u 10002 issuer \
 && mkdir -p /keys /tokens \
 && chown issuer:issuer /keys /tokens \
 && chmod 700 /keys && chmod 755 /tokens
WORKDIR /app
COPY scripts/anthropic-issuer/issuer.py ./issuer.py
USER issuer
ENV PYTHONUNBUFFERED=1

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python issuer.py check

ENTRYPOINT ["python", "issuer.py"]
CMD ["serve"]
