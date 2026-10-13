# syntax=docker/dockerfile:1.7
# Claude-backed VLM adapter — AI Adapter Contract v1, built from this repo.
#
# No weights, no torch: this adapter sends visual_qa / scene_caption to the
# Anthropic API, so the image is small and arch-independent. It serves the
# CAPTION_ADAPTER slot when LLM_PROVIDER=anthropic (docker-compose.anthropic.yml).
#
# Build (from the repo root):
#   docker build -f adapters/claudevlm/Dockerfile -t opennvr/claudevlm-adapter:local .

FROM python:3.11-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --no-cache-dir \
        fastapi==0.127.0 \
        "uvicorn==0.40.0" \
        pydantic==2.12.5 \
        httpx==0.28.1 \
        python-multipart==0.0.20 \
        opennvr-adapter-sdk==1.3.0 \
        anthropic==1.13.0

COPY adapters/claudevlm/ ./adapters/claudevlm/

ENV PYTHONPATH=/app \
    OPENNVR_ADAPTER_TOKEN="" \
    OPENNVR_CLAUDE_VLM_MODEL=claude-haiku-5-5 \
    OPENNVR_CLAUDE_VLM_EFFORT=low

EXPOSE 9006
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD python -c "import httpx, sys; sys.exit(0 if httpx.get('http://127.0.0.1:9006/health', timeout=2).status_code == 200 else 1)"
CMD ["uvicorn", "adapters.claudevlm.main:app", "--host", "0.0.0.0", "--port", "9006"]
