# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The Claude query parser (llm_provider: anthropic): request shape,
mapping the JSON answer onto a QueryFilter, the heuristic fallback, and
config selection."""
from __future__ import annotations

import datetime as _dt
from types import SimpleNamespace

from footage_search import load_config
from query import parse_heuristic, parse_with_anthropic

NOW = _dt.datetime(2026, 6, 14, 12, 0, 0, tzinfo=_dt.timezone.utc)


class _Client:
    def __init__(self, text=None, exc=None):
        self.calls = []
        self._text, self._exc = text, exc
        self.messages = self

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self._exc:
            raise self._exc
        return SimpleNamespace(content=[
            SimpleNamespace(type="thinking", thinking=""),
            SimpleNamespace(type="text", text=self._text)])


def test_parses_claude_json_into_a_filter():
    client = _Client('```json\n{"labels": ["People", "truck"], "keywords": ["Red"], '
                     '"relative_time": "yesterday", "camera": "Dock"}\n```')
    qf = parse_with_anthropic("red truck at the dock yesterday", now=NOW,
                              model="claude-haiku-5-5", effort="low",
                              camera_aliases={"dock": "Dock"}, client=client)
    req = client.calls[0]
    assert req["model"] == "claude-haiku-5-5"
    assert req["output_config"] == {"effort": "low"}
    assert "temperature" not in req
    assert "Dock" in req["system"]
    assert req["messages"] == [{"role": "user", "content": "red truck at the dock yesterday"}]
    assert qf.labels == ["person", "truck"]
    assert qf.keywords == ["red"]
    assert qf.camera_id == "Dock"
    start = _dt.datetime(2026, 6, 13, tzinfo=_dt.timezone.utc).timestamp()
    assert qf.since == start


def test_any_failure_falls_back_to_the_heuristic_parser():
    q = "red truck today"
    expected = parse_heuristic(q, now=NOW)
    for client in (_Client(exc=RuntimeError("no key")), _Client("not json"),
                   _Client('["a list"]')):
        assert parse_with_anthropic(q, now=NOW, model="m", client=client) == expected


def test_config_selects_anthropic_with_defaults_for_blank_values(tmp_path):
    p = tmp_path / "c.yml"
    p.write_text('opennvr_url: "http://core"\nllm_provider: "anthropic"\n'
                 'anthropic:\n  model: ""\n  effort: ""\n')
    cfg = load_config(str(p))
    assert cfg.llm_provider == "anthropic"
    assert (cfg.anthropic.model, cfg.anthropic.effort) == ("claude-haiku-5-5", "low")


def test_shipped_docker_template_carries_the_provider_placeholders():
    from pathlib import Path

    text = (Path(__file__).resolve().parent.parent / "config.docker.yml").read_text()
    for var in ("LLM_PROVIDER", "LLM_MODEL", "LLM_EFFORT"):
        assert "${" + var + "}" in text


def test_reuses_one_sdk_client_across_queries(monkeypatch):
    # Under workload identity federation every new client re-exchanges
    # its identity token; one per process keeps the access token.
    import sys
    import query

    built = []

    class _FakeAnthropic:
        def __init__(self, **kwargs):
            built.append(kwargs)
            self.messages = _Client('{"labels": ["person"]}')

    monkeypatch.setitem(sys.modules, "anthropic", SimpleNamespace(Anthropic=_FakeAnthropic))
    monkeypatch.setattr(query, "_ANTHROPIC_CLIENTS", {})
    for q in ("people", "people again"):
        parse_with_anthropic(q, now=NOW, model="claude-haiku-5-5")
    assert len(built) == 1
