# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Claude brain (llm_provider: anthropic): the AnthropicLLMClient's
translation between the turn loop's OpenAI-shaped messages and the
Messages API, and runtime selection."""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import anthropic
import httpx
import pytest

from adapter_clients import AnthropicLLMClient, LLMCallError, OpenAILLMClient
from camera_agent import AppConfig, CameraAgentRuntime, LLMTurnError, _chat_or_explain
from context import CameraSpec


class _Block(SimpleNamespace):
    def model_dump(self, **_kw):
        return {k: v for k, v in vars(self).items() if v is not None}


def _resp(*blocks, stop_reason="end_turn"):
    return SimpleNamespace(content=list(blocks), stop_reason=stop_reason)


class _FakeMessages:
    def __init__(self, responses):
        self.calls: list[dict] = []
        self._responses = list(responses)

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        out = self._responses.pop(0)
        if isinstance(out, Exception):
            raise out
        return out


def _client(*responses, **kw):
    c = AnthropicLLMClient(api_key="sk-test", model="claude-haiku-5-5", **kw)
    fake = _FakeMessages(responses)
    c._sdk = SimpleNamespace(messages=fake)
    return c, fake


TOOLS = [{"type": "function", "function": {
    "name": "detect_objects", "description": "Detect objects on a camera.",
    "parameters": {"type": "object", "properties": {"camera_id": {"type": "string"}}}}}]


def test_request_shape_effort_no_temperature_and_caching():
    c, fake = _client(_resp(_Block(type="text", text="Hi there.")))
    out = asyncio.run(c.chat(
        messages=[{"role": "system", "content": "You are a camera assistant."},
                  {"role": "user", "content": "hello"}],
        tools=TOOLS, temperature=0.3, max_tokens=256))
    req = fake.calls[0]
    assert req["model"] == "claude-haiku-5-5"
    assert req["output_config"] == {"effort": "low"}
    assert "temperature" not in req          # Haiku 5.5 rejects sampling params
    assert req["max_tokens"] == AnthropicLLMClient.MIN_MAX_TOKENS
    assert req["system"] == [{"type": "text", "text": "You are a camera assistant.",
                              "cache_control": {"type": "ephemeral"}}]
    assert req["cache_control"] == {"type": "ephemeral"}
    assert req["tools"] == [{"name": "detect_objects",
                             "description": "Detect objects on a camera.",
                             "input_schema": TOOLS[0]["function"]["parameters"]}]
    assert req["messages"] == [{"role": "user", "content": [{"type": "text", "text": "hello"}]}]
    assert out == {"message": {"role": "assistant", "content": "Hi there."}}


def test_effort_is_configurable():
    c, fake = _client(_resp(_Block(type="text", text="ok")), effort="medium")
    asyncio.run(c.chat(messages=[{"role": "user", "content": "hi"}]))
    assert fake.calls[0]["output_config"] == {"effort": "medium"}


def test_prewarm_sends_max_tokens_zero_without_conversation_breakpoint():
    c, fake = _client(_resp(stop_reason="max_tokens"))
    out = asyncio.run(c.chat(messages=[{"role": "system", "content": "S"},
                                       {"role": "user", "content": "hello"}],
                             tools=TOOLS, max_tokens=1))
    req = fake.calls[0]
    assert req["max_tokens"] == 0
    assert "cache_control" not in req     # would key the cache to the placeholder
    assert req["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert out["message"]["content"] == ""


def test_tool_call_round_trip_replays_thinking_blocks():
    thinking = _Block(type="thinking", thinking="", signature="sig-1")
    use = _Block(type="tool_use", id="toolu_1", name="detect_objects",
                 input={"camera_id": "cam1"})
    c, fake = _client(_resp(thinking, use, stop_reason="tool_use"),
                      _resp(_Block(type="text", text="One person on cam1.")))
    first = asyncio.run(c.chat(messages=[{"role": "user", "content": "anyone at the door?"}],
                               tools=TOOLS))
    call = first["message"]["tool_calls"][0]
    assert call == {"id": "toolu_1", "type": "function",
                    "function": {"name": "detect_objects",
                                 "arguments": json.dumps({"camera_id": "cam1"})}}

    # The loop rebuilds the assistant turn from content + tool_calls only.
    asyncio.run(c.chat(messages=[
        {"role": "user", "content": "anyone at the door?"},
        {"role": "assistant", "content": "", "tool_calls": [call]},
        {"role": "tool", "tool_call_id": "toolu_1", "name": "detect_objects",
         "content": "person x1"},
    ], tools=TOOLS))
    sent = fake.calls[1]["messages"]
    assert sent[1] == {"role": "assistant", "content": [
        {"type": "thinking", "thinking": "", "signature": "sig-1"},
        {"type": "tool_use", "id": "toolu_1", "name": "detect_objects",
         "input": {"camera_id": "cam1"}}]}
    assert sent[2] == {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_1", "content": "person x1"}]}


def test_synthetic_calls_are_flattened_even_with_tools():
    # Forced grounding injects a call Claude never made (no thinking to
    # replay), so it and its results travel as text.
    c, fake = _client(_resp(_Block(type="text", text="ok")))
    asyncio.run(c.chat(messages=[
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "forced-0", "type": "function",
             "function": {"name": "detect_objects", "arguments": {"camera_id": "cam2"}}},
            {"id": "forced-1", "type": "function",
             "function": {"name": "detect_objects", "arguments": '{"camera_id": "cam3"}'}}]},
        {"role": "tool", "tool_call_id": "forced-0", "name": "detect_objects", "content": "a"},
        {"role": "tool", "tool_call_id": "forced-1", "name": "detect_objects", "content": ""},
    ], tools=TOOLS))
    sent = fake.calls[0]["messages"]
    assert "tools" in fake.calls[0]
    assert sent[1]["content"] == [{"type": "text", "text":
        '[I called detect_objects({"camera_id": "cam2"}), '
        'detect_objects({"camera_id": "cam3"})]'}]
    assert sent[2]["content"] == [
        {"type": "text", "text": "[detect_objects result]\na"},
        {"type": "text", "text": "[detect_objects result]\n(no output)"}]


def test_parallel_results_merge_into_one_user_message():
    use1 = _Block(type="tool_use", id="toolu_a", name="detect_objects", input={"camera_id": "c1"})
    use2 = _Block(type="tool_use", id="toolu_b", name="detect_objects", input={"camera_id": "c2"})
    c, fake = _client(_resp(use1, use2, stop_reason="tool_use"),
                      _resp(_Block(type="text", text="done")))
    calls = asyncio.run(c.chat(messages=[{"role": "user", "content": "q"}],
                               tools=TOOLS))["message"]["tool_calls"]
    asyncio.run(c.chat(messages=[
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "", "tool_calls": calls},
        {"role": "tool", "tool_call_id": "toolu_a", "name": "detect_objects", "content": "x"},
        {"role": "tool", "tool_call_id": "toolu_b", "name": "detect_objects", "content": "y"},
    ], tools=TOOLS))
    assert fake.calls[1]["messages"][2]["content"] == [
        {"type": "tool_result", "tool_use_id": "toolu_a", "content": "x"},
        {"type": "tool_result", "tool_use_id": "toolu_b", "content": "y"}]


def test_an_orphan_tool_result_is_text_not_a_dangling_tool_result():
    # The voice context once carried tool results without the call that
    # asked for them; the API 400s on a tool_result with no tool_use.
    c, fake = _client(_resp(_Block(type="text", text="ok")))
    asyncio.run(c.chat(messages=[
        {"role": "system", "content": "S"},
        {"role": "user", "content": "anyone there?"},
        {"role": "tool", "tool_call_id": "toolu_gone", "name": "detect_objects",
         "content": "person x1"},
        {"role": "assistant", "content": "One person."},
        {"role": "user", "content": "and now?"},
    ], tools=TOOLS))
    kinds = [b["type"] for m in fake.calls[0]["messages"] for b in m["content"]]
    assert "tool_result" not in kinds


def test_tool_history_without_tools_is_flattened_to_text():
    # The tier-0 compose call: a routed tool exchange, tools=None.
    c, fake = _client(_resp(_Block(type="text", text="Two cars.")))
    asyncio.run(c.chat(messages=[
        {"role": "system", "content": "Compose."},
        {"role": "user", "content": "how many cars?"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "route-0", "type": "function",
             "function": {"name": "detect_objects", "arguments": {"camera_id": "cam1"}}}]},
        {"role": "tool", "tool_call_id": "route-0", "name": "detect_objects",
         "content": "car x2"},
    ], tools=None))
    req = fake.calls[0]
    assert "tools" not in req
    kinds = [b["type"] for m in req["messages"] for b in m["content"]]
    assert kinds == ["text", "text", "text"]
    assert req["messages"][1]["content"][0]["text"] == \
        '[I called detect_objects({"camera_id": "cam1"})]'
    assert req["messages"][2]["content"][0]["text"] == "[detect_objects result]\ncar x2"


def test_openai_content_parts_and_leading_assistant():
    c, fake = _client(_resp(_Block(type="text", text="ok")))
    asyncio.run(c.chat(messages=[
        {"role": "assistant", "content": "Hello, I'm listening."},
        {"role": "user", "content": [{"type": "text", "text": "what's "},
                                     {"type": "text", "text": "up"}]},
    ]))
    sent = fake.calls[0]["messages"]
    assert sent[0]["role"] == "user"                      # API needs a user turn first
    assert sent[2]["content"] == [{"type": "text", "text": "what's up"}]


def test_sdk_errors_become_llm_call_errors_with_status():
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    err = anthropic.AuthenticationError(
        "invalid x-api-key", response=httpx.Response(401, request=req), body=None)
    c, _ = _client(err)
    with pytest.raises(LLMCallError) as info:
        asyncio.run(c.chat(messages=[{"role": "user", "content": "hi"}]))
    assert info.value.status == 401
    assert "401" in str(info.value)


def test_chat_or_explain_surfaces_provider_errors():
    class _Failing:
        async def chat(self, **_kw):
            raise LLMCallError("answered HTTP 401: invalid x-api-key", status=401)

    runtime = SimpleNamespace(
        cfg=SimpleNamespace(llm_provider="anthropic", llm_base_url=None,
                            ollama_url="http://ollama:11434"),
        ollama=_Failing(), last_llm_error=None)
    with pytest.raises(LLMTurnError) as info:
        asyncio.run(_chat_or_explain(runtime, messages=[]))
    assert str(info.value) == "LLM at the Anthropic API answered HTTP 401: invalid x-api-key"
    assert runtime.last_llm_error == str(info.value)


def test_runtime_selects_anthropic_provider():
    cfg = AppConfig(kaic_url="http://k", kaic_api_key="x", system_prompt="t",
                    cameras=[CameraSpec(camera_id="cam1", frame_url="http://x/1.jpg", role="r")],
                    llm_provider="anthropic", llm_api_key="sk-test",
                    llm_model="claude-haiku-5-5", llm_effort="low")
    rt = CameraAgentRuntime(cfg)
    assert isinstance(rt.ollama, AnthropicLLMClient)
    assert rt.ollama._model == "claude-haiku-5-5"
    assert rt.ollama._effort == "low"


def test_openai_client_serialises_dict_arguments():
    c = OpenAILLMClient(base_url="https://api.x.com/v1", api_key="k", model="m")
    captured = {}

    class _Resp:
        def raise_for_status(self):
            pass
        def json(self):
            return {"choices": [{"message": {"role": "assistant", "content": "ok"}}]}

    class _Http:
        async def post(self, url, json=None, headers=None):
            captured["json"] = json
            return _Resp()
    c._client = lambda: _Http()

    asyncio.run(c.chat(messages=[
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "route-0", "type": "function",
             "function": {"name": "detect_objects", "arguments": {"camera_id": "cam1"}}}]},
    ]))
    args = captured["json"]["messages"][0]["tool_calls"][0]["function"]["arguments"]
    assert json.loads(args) == {"camera_id": "cam1"}
