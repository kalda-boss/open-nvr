# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for the Claude VLM service — no network: a fake client
plays the Messages API, covering the contract mapping, the request
shape, and how each API failure is reported."""
from __future__ import annotations

import base64
from types import SimpleNamespace

import anthropic
import httpx
import pytest

from adapters.claudevlm.service import ClaudeVlmService
from opennvr_adapter_sdk import ErrorCategory, HardwareVerdict, ServiceError

JPEG = b"\xff\xd8\xff" + b"x" * 32
WEBP = b"RIFF\x00\x00\x00\x00WEBP" + b"x" * 16


class _Fake:
    def __init__(self, text="A person at the front door.", exc=None,
                 stop_reason="end_turn"):
        self.calls: list[dict] = []
        self._text, self._exc, self._stop = text, exc, stop_reason
        self.messages = self

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self._exc is not None:
            raise self._exc
        blocks = [SimpleNamespace(type="thinking", thinking="")]
        if self._text:
            blocks.append(SimpleNamespace(type="text", text=self._text))
        return SimpleNamespace(content=blocks, stop_reason=self._stop)


def _svc(fake=None, **kw):
    svc = ClaudeVlmService(client=fake or _Fake(), **kw)
    svc.load()
    return svc


def _api_error(cls, status):
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls("boom", response=httpx.Response(status, request=req), body=None)


def test_caption_request_shape_and_result():
    fake = _Fake()
    out = _svc(fake).infer({"__file__": JPEG})
    req = fake.calls[0]
    assert req["model"] == "claude-haiku-5-5"
    assert req["output_config"] == {"effort": "low"}
    assert "temperature" not in req
    image, text = req["messages"][0]["content"]
    assert image["source"] == {"type": "base64", "media_type": "image/jpeg",
                               "data": base64.standard_b64encode(JPEG).decode()}
    assert text == {"type": "text", "text": "Describe this image in one short sentence."}
    assert out.result == {"task": "scene_caption", "endpoint": "https://api.anthropic.com",
                          "caption": "A person at the front door."}
    assert out.model_name == "claude-haiku-5-5"


def test_vqa_uses_the_question_and_answers_under_answer():
    fake = _Fake(text="Two parcels.")
    out = _svc(fake).infer({"__file__": WEBP, "task": "visual_qa",
                            "question": "How many parcels are on the porch?"})
    assert fake.calls[0]["messages"][0]["content"][0]["source"]["media_type"] == "image/webp"
    assert fake.calls[0]["messages"][0]["content"][1]["text"] == \
        "How many parcels are on the porch?"
    assert out.result["answer"] == "Two parcels."
    assert out.result["task"] == "visual_qa"


def test_model_and_effort_are_configurable(monkeypatch):
    monkeypatch.setenv("OPENNVR_CLAUDE_VLM_MODEL", "claude-sonnet-5-5")
    monkeypatch.setenv("OPENNVR_CLAUDE_VLM_EFFORT", "medium")
    fake = _Fake()
    _svc(fake).infer({"__file__": JPEG})
    assert fake.calls[0]["model"] == "claude-sonnet-5-5"
    assert fake.calls[0]["output_config"] == {"effort": "medium"}


@pytest.mark.parametrize("payload,code", [
    ({}, "missing_image"),
    ({"__file__": b"BM" + b"x" * 32}, "invalid_image"),   # BMP: API won't take it
    ({"__file__": JPEG, "task": "detect"}, "unsupported_task"),
])
def test_bad_requests_are_400s(payload, code):
    with pytest.raises(ServiceError) as info:
        _svc().infer(payload)
    assert (info.value.code, info.value.http_status, info.value.transient) == (code, 400, False)


@pytest.mark.parametrize("exc,code,transient", [
    (_api_error(anthropic.RateLimitError, 429), "rate_limited", True),
    (_api_error(anthropic.AuthenticationError, 401), "auth_failed", False),
    (_api_error(anthropic.InternalServerError, 529), "provider_unavailable", True),
    (_api_error(anthropic.BadRequestError, 400), "provider_rejected", False),
    (anthropic.APIConnectionError(request=httpx.Request("POST", "https://x")),
     "endpoint_unreachable", True),
])
def test_api_failures_map_to_provider_errors(exc, code, transient):
    svc = _svc(_Fake(exc=exc))
    with pytest.raises(ServiceError) as info:
        svc.infer({"__file__": JPEG})
    assert info.value.category == ErrorCategory.PROVIDER_ERROR
    assert (info.value.code, info.value.transient) == (code, transient)
    # The failure is visible on the AI models page until a call succeeds.
    assert svc.hardware_evaluation().verdict == HardwareVerdict.WARN


def test_a_refusal_is_reported_not_returned_as_a_caption():
    svc = _svc(_Fake(text="", stop_reason="refusal"))
    with pytest.raises(ServiceError) as info:
        svc.infer({"__file__": JPEG})
    assert info.value.code == "empty_response"
    assert "declined" in info.value.message


def test_ready_without_a_key_but_says_why_it_cannot_answer(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    svc = ClaudeVlmService()
    svc.load()
    assert svc.is_ready(), "a missing key must not fail the healthcheck"
    hw = svc.hardware_evaluation()
    assert hw.verdict == HardwareVerdict.WARN
    assert "ANTHROPIC_API_KEY" in hw.reasoning
    with pytest.raises(ServiceError) as info:
        svc.infer({"__file__": JPEG})
    assert info.value.code == "api_key_missing"


def test_capabilities_declare_the_api_as_egress(monkeypatch):
    monkeypatch.setenv("OPENNVR_ADAPTER_TOKEN", "t")
    from fastapi.testclient import TestClient

    from adapters.claudevlm.main import app

    with TestClient(app) as client:
        resp = client.get("/capabilities", headers={"Authorization": "Bearer t"})
    assert resp.status_code == 200
    caps = resp.json()
    assert caps["adapter"]["name"] == "claudevlm"
    assert caps["permissions"]["network_egress"] == ["https://api.anthropic.com"]
    assert caps["tasks_advertised"] == ["visual_qa", "scene_caption"]
