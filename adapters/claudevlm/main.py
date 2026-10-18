# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Claude-backed VLM adapter — contract-compliant FastAPI service.

Drop-in for the ``CAPTION_ADAPTER`` slot (same tasks and result keys as
moondream/ollamavlm); inference is Claude on the Anthropic API. See
adapters/claudevlm/service.py for the design decisions.

Run locally (from the repo root):
    OPENNVR_ADAPTER_TOKEN=secret ANTHROPIC_API_KEY=sk-ant-... \\
    python -m uvicorn adapters.claudevlm.main:app --host 0.0.0.0 --port 9006
"""
from __future__ import annotations

from adapters.claudevlm.service import API_HOST, MAX_IMAGE_BYTES, ClaudeVlmService
from opennvr_adapter_sdk import (
    AdapterApp,
    BodyShape,
    Cost,
    FairQueuing,
    Permissions,
    Scheduling,
)

_adapter_app = AdapterApp(
    service_factory=ClaudeVlmService,
    name="claudevlm",
    version="1.0.0",
    vendor="kalda-boss",
    license="AGPL-3.0",
    model_card_url="https://docs.claude.com/en/docs/about-claude/models/overview",
    tasks_advertised=["visual_qa", "scene_caption"],
    body_shape=BodyShape.IMAGE,
    max_body_bytes=MAX_IMAGE_BYTES,
    permissions=Permissions(
        gpu=False,
        # DECLARED egress: every inference sends the frame to the
        # Anthropic API. One enumerated host, so AI_SOVEREIGNTY=federated
        # admits it; local_only refuses it, as it should.
        network_egress=[API_HOST],
        host_filesystem=[],
        shared_memory_paths=[],
        host_metadata=False,
    ),
    scheduling=Scheduling(
        # The API, not this box, does the work — a few frames at once is
        # fine, and FIFO is the cloud-adapter default.
        max_inflight=4,
        preferred_batch_size=1,
        fair_queuing=FairQueuing.NONE,
    ),
    cost=Cost(currency="USD"),
    supports_stream=False,
)

app = _adapter_app.fastapi_app


def __getattr__(name: str):
    if name == "_service":
        return _adapter_app.service
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
