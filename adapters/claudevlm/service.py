# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Claude-backed VLM adapter — contract-compliant ``AdapterService``.

Same two tasks and result keys as the moondream and ollamavlm adapters
(``visual_qa`` → ``answer``, ``scene_caption`` → ``caption``), so it is a
drop-in for the ``CAPTION_ADAPTER`` slot: the camera agent's
describe_camera, core's caption and descriptor enrichment, scene
descriptions, and package-delivery's parcel count all reach it through
KAI-C unchanged. Each frame goes to the Anthropic Messages API.

Design decisions (deliberate, keep them):

* **Cloud, declared.** Frames leave the machine for api.anthropic.com,
  and the adapter says so in ``permissions.network_egress``. KAI-C
  refuses it under AI_SOVEREIGNTY=local_only; ``federated`` (every host
  enumerated, which this is) or ``cloud_allowed`` admit it.
* **Lazy-ready**, like ollamavlm. ``is_ready()`` is True once config
  parses; a missing key or an unreachable API is a per-infer error
  (and a WARN in ``hardware_evaluation()``), not a boot failure.
* **Low effort by default.** A one-sentence caption doesn't repay
  thinking; OPENNVR_CLAUDE_VLM_EFFORT raises it.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import os
import platform
import time
from datetime import datetime, timezone
from typing import Any

import anthropic

from opennvr_adapter_sdk import (
    AdapterService,
    ErrorCategory,
    HardwareEvaluationResponse,
    HardwareVerdict,
    InferResponse,
    ModelInfo,
    ServiceError,
)

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "claude-haiku-5-5"
DEFAULT_EFFORT = "low"
API_HOST = "https://api.anthropic.com"
# The Messages API takes images up to 5 MB each; capping the raw frame at
# 3.75 MB keeps even its base64 form under that.
MAX_IMAGE_BYTES: int = 15 * 1024 * 1024 // 4
_SUPPORTED_TASKS: tuple[str, ...] = ("visual_qa", "scene_caption")
_SYSTEM = ("You describe frames from a home security camera. Answer only "
           "from what is visible, plainly and briefly, with no preamble.")
_CAPTION_PROMPT = "Describe this image in one short sentence."

# Media types the Messages API accepts, by magic bytes. WebP is RIFF....WEBP.
_MEDIA_TYPES: tuple[tuple[bytes, str], ...] = (
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG", "image/png"),
    (b"GIF8", "image/gif"),
)


def _media_type(data: bytes) -> str | None:
    for magic, media_type in _MEDIA_TYPES:
        if data.startswith(magic):
            return media_type
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


class ClaudeVlmService(AdapterService):
    """Contract adapter that sends VQA/captioning to Claude."""

    def __init__(
        self,
        model: str | None = None,
        effort: str | None = None,
        *,
        client: Any | None = None,
    ) -> None:
        self._model = model or os.getenv("OPENNVR_CLAUDE_VLM_MODEL") or DEFAULT_MODEL
        self._effort = effort or os.getenv("OPENNVR_CLAUDE_VLM_EFFORT") or DEFAULT_EFFORT
        self._timeout = float(os.getenv("OPENNVR_CLAUDE_VLM_TIMEOUT_S", "60"))
        self._has_key = client is not None or bool(os.getenv("ANTHROPIC_API_KEY"))
        # ``client`` is injectable for tests; the real one reads ANTHROPIC_API_KEY.
        self._client = client
        self._ready = False
        self._last_error: str | None = None
        self._started_at = datetime.now(timezone.utc)

    # ── AdapterService impl ────────────────────────────────────────

    def load(self) -> None:
        if self._client is None and self._has_key:
            self._client = anthropic.Anthropic(timeout=self._timeout, max_retries=1)
        self._ready = True

    def is_ready(self) -> bool:
        return self._ready

    def fingerprint(self) -> str | None:
        digest = hashlib.sha256(f"anthropic::{self._model}".encode()).hexdigest()
        return f"sha256-id:{digest}"

    def model_info(self) -> ModelInfo:
        return ModelInfo(
            name=self._model,
            version=f"anthropic/{self._model}",
            framework="anthropic",
            modalities_in=["image", "text"],
            modalities_out=["text"],
            fingerprint=self.fingerprint(),
        )

    def hardware_evaluation(self) -> HardwareEvaluationResponse:
        if not self._has_key:
            verdict = HardwareVerdict.WARN
            reasoning = ("ANTHROPIC_API_KEY is not set — every inference will "
                         "fail until it is (set it in .env and restart).")
        elif self._last_error:
            verdict = HardwareVerdict.WARN
            reasoning = f"Last call to the Anthropic API failed: {self._last_error}"
        else:
            verdict = HardwareVerdict.OK
            reasoning = (f"Frames go to {self._model} on the Anthropic API; "
                         "no local compute.")
        uptime_s = int((datetime.now(timezone.utc) - self._started_at).total_seconds())
        return HardwareEvaluationResponse(
            verdict=verdict, reasoning=reasoning,
            checked_at=datetime.now(timezone.utc),
            details={
                "gpu_required": False,
                "runtime": "anthropic-api",
                "endpoint": API_HOST,
                "model": self._model,
                "effort": self._effort,
                "api_key_set": self._has_key,
                "cpu_count": os.cpu_count() or 0,
                "platform": platform.platform(),
                "python_version": platform.python_version(),
                "adapter_uptime_seconds": uptime_s,
            },
        )

    def infer(self, payload: dict[str, Any]) -> InferResponse:
        image_bytes = payload.get("__file__")
        if not image_bytes:
            raise ServiceError(
                ErrorCategory.TRANSPORT_ERROR, code="missing_image",
                message=("claudevlm expects an image in the request body "
                         "(multipart 'frame' field or JSON 'frame_b64')."),
                transient=False, http_status=400,
            )
        media_type = _media_type(image_bytes)
        if media_type is None:
            raise ServiceError(
                ErrorCategory.TRANSPORT_ERROR, code="invalid_image",
                message="request body is not a JPEG/PNG/GIF/WebP image",
                transient=False, http_status=400,
            )

        task = (payload.get("task") or "").strip()
        question = (payload.get("question") or payload.get("prompt") or "").strip()
        if task and task not in _SUPPORTED_TASKS:
            raise ServiceError(
                ErrorCategory.NOT_SUPPORTED, code="unsupported_task",
                message=f"task {task!r} not in {list(_SUPPORTED_TASKS)}",
                transient=False, http_status=400,
            )
        is_vqa = bool(question) and task != "scene_caption"
        prompt = question if is_vqa else _CAPTION_PROMPT

        started = time.monotonic()
        text = self._generate(prompt, image_bytes, media_type)
        elapsed_ms = int((time.monotonic() - started) * 1000)
        try:
            self.metrics.observe("adapter_upstream_latency_seconds", elapsed_ms / 1000.0)
            self.metrics.inc_counter("adapter_generated_chars_total", len(text))
        except Exception:  # pragma: no cover - metrics must never break infer
            pass

        result: dict[str, Any] = {
            "task": "visual_qa" if is_vqa else "scene_caption",
            "endpoint": API_HOST,
        }
        if is_vqa:
            result["answer"] = text
            result["question"] = question
        else:
            result["caption"] = text
        return InferResponse(
            model_name=self._model,
            model_version=f"anthropic/{self._model}",
            inference_ms=elapsed_ms,
            result=result,
        )

    # ── Anthropic plumbing ─────────────────────────────────────────

    def _generate(self, prompt: str, image_bytes: bytes, media_type: str) -> str:
        if self._client is None:
            raise ServiceError(
                ErrorCategory.PROVIDER_ERROR, code="api_key_missing",
                message="ANTHROPIC_API_KEY is not set for the caption adapter",
                transient=False, http_status=503,
            )
        try:
            resp = self._client.messages.create(
                model=self._model,
                # Thinking counts against max_tokens; the answer is a sentence.
                max_tokens=1024,
                output_config={"effort": self._effort},
                system=_SYSTEM,
                messages=[{"role": "user", "content": [
                    {"type": "image", "source": {
                        "type": "base64", "media_type": media_type,
                        "data": base64.standard_b64encode(image_bytes).decode("ascii")}},
                    {"type": "text", "text": prompt},
                ]}],
            )
        except anthropic.RateLimitError as exc:
            raise self._fail(exc, "rate_limited", transient=True, status=503,
                             retry_after_ms=5000) from exc
        except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as exc:
            raise self._fail(exc, "auth_failed", transient=False, status=502) from exc
        except anthropic.InternalServerError as exc:
            raise self._fail(exc, "provider_unavailable", transient=True, status=503,
                             retry_after_ms=2000) from exc
        except anthropic.APIStatusError as exc:
            raise self._fail(exc, "provider_rejected", transient=False, status=502) from exc
        except anthropic.APIConnectionError as exc:
            raise self._fail(exc, "endpoint_unreachable", transient=True, status=503,
                             retry_after_ms=2000) from exc

        text = "".join(b.text for b in resp.content if b.type == "text").strip()
        if not text:
            reason = ("the model declined the request" if resp.stop_reason == "refusal"
                      else f"no text (stop_reason={resp.stop_reason})")
            self._last_error = reason
            raise ServiceError(
                ErrorCategory.PROVIDER_ERROR, code="empty_response",
                message=f"{self._model} returned {reason}",
                transient=False, http_status=502,
            )
        self._last_error = None
        return text

    def _fail(self, exc: Exception, code: str, *, transient: bool, status: int,
              retry_after_ms: int | None = None) -> ServiceError:
        detail = getattr(exc, "message", None) or str(exc)
        http = getattr(exc, "status_code", None)
        message = (f"Anthropic API answered HTTP {http}: {detail}" if http
                   else f"Anthropic API unreachable: {detail}")[:400]
        self._last_error = message
        logger.warning("claudevlm: %s", message)
        return ServiceError(
            ErrorCategory.PROVIDER_ERROR, code=code, message=message,
            transient=transient, http_status=status, retry_after_ms=retry_after_ms,
        )
