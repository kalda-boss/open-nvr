# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Natural-language → structured filter for footage-search.

Turns "show me every red truck at the dock yesterday" into a
``QueryFilter`` the ``FootageStore`` can run:

    labels   = ["truck"]            # known object classes named
    keywords = ["red"]              # descriptors → matched in captions
    since/until = yesterday 00:00 .. 23:59
    camera_id = "cam-dock"          # if "dock" maps to a known camera

Two parsers, same output type:

* ``parse_heuristic`` — no dependencies, no LLM. Time phrases, a label
  vocabulary, camera aliases, and leftover significant words → keywords.
  Always available; deterministic; what the tests exercise.
* ``parse_with_ollama`` — optional. Sends the query to a local Ollama
  model and asks for the same structured JSON. Better at messy phrasing
  ("someone in a hoodie loitering by the gate after dark"). Falls back
  to the heuristic parser on any error, so enabling it never makes
  search worse.
* ``parse_with_anthropic`` — the same, on Claude through the Anthropic
  SDK (``llm_provider: anthropic``). Same prompt, same fallback.

Time is resolved relative to an injected ``now`` so parsing is testable.
"""
from __future__ import annotations

import datetime as _dt
import re
from dataclasses import dataclass, field
from typing import Iterable


@dataclass
class QueryFilter:
    labels: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    since: float | None = None
    until: float | None = None
    camera_id: str | None = None


# A compact default object vocabulary (COCO-ish). Operators can extend
# it via config; anything not here that's still meaningful falls through
# to ``keywords`` and is matched against captions.
DEFAULT_LABELS = {
    "person", "people", "bicycle", "car", "motorcycle", "motorbike",
    "airplane", "bus", "train", "truck", "boat", "backpack", "umbrella",
    "handbag", "suitcase", "bag", "luggage", "bottle", "laptop", "cell",
    "phone", "dog", "cat", "bird", "horse", "cow", "sheep",
}

# Map a few natural plurals/synonyms onto the canonical detector label.
_LABEL_ALIASES = {
    "people": "person",
    "motorbike": "motorcycle",
    "bag": "handbag",
    "luggage": "suitcase",
    "phone": "cell phone",
}

_STOPWORDS = {
    "show", "me", "find", "get", "all", "every", "any", "the", "a", "an",
    "of", "at", "in", "on", "near", "by", "with", "and", "or", "to",
    "was", "were", "is", "are", "there", "that", "who", "what", "when",
    "did", "do", "see", "seen", "footage", "clip", "clips", "video",
    "camera", "cameras", "from", "between",
}


def parse_heuristic(
    query: str,
    *,
    now: _dt.datetime,
    label_vocab: Iterable[str] | None = None,
    camera_aliases: dict[str, str] | None = None,
) -> QueryFilter:
    """Parse a query string into a QueryFilter without any LLM.

    ``camera_aliases`` maps lowercase words an operator might say
    ("dock", "lobby") to a configured camera_id ("cam-dock")."""
    vocab = {s.lower() for s in (label_vocab or DEFAULT_LABELS)}
    aliases = {k.lower(): v for k, v in (camera_aliases or {}).items()}
    q = query.lower().strip()

    since, until, q_wo_time = _extract_time(q, now=now)

    # Tokenize remaining text into word tokens.
    tokens = re.findall(r"[a-z0-9']+", q_wo_time)

    camera_id: str | None = None
    labels: list[str] = []
    keywords: list[str] = []
    for tok in tokens:
        if tok in aliases and camera_id is None:
            camera_id = aliases[tok]
            continue
        if tok in vocab:
            labels.append(_LABEL_ALIASES.get(tok, tok))
            continue
        if tok in _STOPWORDS or len(tok) <= 1:
            continue
        keywords.append(tok)

    # Dedupe, preserve order.
    labels = list(dict.fromkeys(labels))
    keywords = list(dict.fromkeys(keywords))
    return QueryFilter(
        labels=labels, keywords=keywords,
        since=since, until=until, camera_id=camera_id,
    )


def _extract_time(
    q: str, *, now: _dt.datetime
) -> tuple[float | None, float | None, str]:
    """Pull a time window out of the query. Returns
    (since, until, query_with_time_phrase_removed)."""

    def _day_bounds(day: _dt.date) -> tuple[float, float]:
        start = _dt.datetime.combine(day, _dt.time.min, tzinfo=now.tzinfo)
        end = _dt.datetime.combine(day, _dt.time.max, tzinfo=now.tzinfo)
        return start.timestamp(), end.timestamp()

    # "last/past N minutes/hours/days"
    m = re.search(r"(?:last|past)\s+(\d+)\s*(minute|min|hour|hr|day)s?", q)
    if m:
        n = int(m.group(1))
        unit = m.group(2)
        seconds = {
            "minute": 60, "min": 60, "hour": 3600, "hr": 3600, "day": 86400,
        }[unit] * n
        since = (now - _dt.timedelta(seconds=seconds)).timestamp()
        return since, now.timestamp(), q[: m.start()] + q[m.end():]

    # "last hour" / "past hour"
    m = re.search(r"(?:last|past)\s+(hour|day|week)", q)
    if m:
        unit = m.group(1)
        delta = {"hour": 3600, "day": 86400, "week": 604800}[unit]
        since = (now - _dt.timedelta(seconds=delta)).timestamp()
        return since, now.timestamp(), q[: m.start()] + q[m.end():]

    if "yesterday" in q:
        since, until = _day_bounds((now - _dt.timedelta(days=1)).date())
        return since, until, q.replace("yesterday", "")

    if "today" in q:
        since, until = _day_bounds(now.date())
        return since, until, q.replace("today", "")

    if "this morning" in q:
        start = _dt.datetime.combine(now.date(), _dt.time(0), tzinfo=now.tzinfo)
        end = _dt.datetime.combine(now.date(), _dt.time(12), tzinfo=now.tzinfo)
        return start.timestamp(), end.timestamp(), q.replace("this morning", "")

    if "tonight" in q or "this evening" in q:
        start = _dt.datetime.combine(now.date(), _dt.time(18), tzinfo=now.tzinfo)
        end = _dt.datetime.combine(now.date(), _dt.time.max, tzinfo=now.tzinfo)
        phrase = "tonight" if "tonight" in q else "this evening"
        return start.timestamp(), end.timestamp(), q.replace(phrase, "")

    return None, None, q


def _llm_system_prompt(label_vocab: Iterable[str] | None,
                       camera_aliases: dict[str, str] | None) -> str:
    vocab = sorted({s.lower() for s in (label_vocab or DEFAULT_LABELS)})
    cameras = sorted({v for v in (camera_aliases or {}).values()})
    return (
        "You convert a surveillance footage-search request into JSON. "
        "Return ONLY a JSON object with keys: labels (array of object "
        f"classes from this list: {vocab}), keywords (array of other "
        "descriptive words like colors or clothing, matched against scene "
        "captions), relative_time (one of: null, 'today', 'yesterday', "
        "'this_morning', 'tonight', or an integer number of minutes for a "
        "rolling window), camera (one of "
        f"{cameras or ['null']} or null). No prose."
    )


def _filter_from_llm(data: dict, *, now: _dt.datetime) -> QueryFilter:
    labels = [str(s).lower() for s in (data.get("labels") or []) if s]
    labels = [_LABEL_ALIASES.get(s, s) for s in labels]
    keywords = [str(s).lower() for s in (data.get("keywords") or []) if s]
    camera_id = data.get("camera") or None
    if camera_id in (None, "null"):
        camera_id = None

    since, until = _resolve_relative_time(data.get("relative_time"), now=now)
    return QueryFilter(
        labels=list(dict.fromkeys(labels)),
        keywords=list(dict.fromkeys(keywords)),
        since=since, until=until,
        camera_id=str(camera_id) if camera_id else None,
    )


def parse_with_ollama(
    query: str,
    *,
    now: _dt.datetime,
    ollama_url: str,
    model: str,
    label_vocab: Iterable[str] | None = None,
    camera_aliases: dict[str, str] | None = None,
    timeout_seconds: float = 20.0,
) -> QueryFilter:
    """LLM-backed parse. Asks a local Ollama model to extract the same
    structured fields. Falls back to ``parse_heuristic`` on ANY error so
    enabling the LLM never makes search worse than the deterministic
    path."""
    import json

    import httpx

    system = _llm_system_prompt(label_vocab, camera_aliases)
    try:
        resp = httpx.post(
            ollama_url.rstrip("/") + "/api/chat",
            json={
                "model": model,
                "stream": False,
                "format": "json",
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": query},
                ],
            },
            timeout=timeout_seconds,
            trust_env=False,
        )
        resp.raise_for_status()
        content = resp.json()["message"]["content"]
        data = json.loads(content)
    except Exception:
        return parse_heuristic(
            query, now=now, label_vocab=label_vocab, camera_aliases=camera_aliases,
        )
    return _filter_from_llm(data, now=now)


def parse_with_anthropic(
    query: str,
    *,
    now: _dt.datetime,
    model: str,
    effort: str = "low",
    label_vocab: Iterable[str] | None = None,
    camera_aliases: dict[str, str] | None = None,
    timeout_seconds: float = 20.0,
    client: object | None = None,
) -> QueryFilter:
    """``parse_with_ollama`` on Claude. The key comes from the
    ANTHROPIC_API_KEY env var; the SDK honours HTTPS_PROXY, which is how
    a compose install reaches the API through the apps egress proxy.
    Falls back to ``parse_heuristic`` on any error, logged — a missing
    key or a denied egress should be findable, not just quietly worse."""
    import json
    import logging

    system = _llm_system_prompt(label_vocab, camera_aliases)
    try:
        if client is None:
            import anthropic

            client = anthropic.Anthropic(timeout=timeout_seconds, max_retries=1)
        resp = client.messages.create(
            model=model,
            max_tokens=1024,
            output_config={"effort": effort},
            system=system,
            messages=[{"role": "user", "content": query}],
        )
        text = "".join(b.text for b in resp.content if b.type == "text").strip()
        # Tolerate a ```json fence around the object.
        text = text.removeprefix("```json").removeprefix("```").removesuffix("```")
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError(f"expected a JSON object, got {type(data).__name__}")
    except Exception as exc:
        logging.getLogger(__name__).warning(
            "anthropic query parse failed (%s: %s); using the heuristic parser",
            type(exc).__name__, str(exc)[:200])
        return parse_heuristic(
            query, now=now, label_vocab=label_vocab, camera_aliases=camera_aliases,
        )
    return _filter_from_llm(data, now=now)


def _resolve_relative_time(value: object, *, now: _dt.datetime):
    def _day(day):
        start = _dt.datetime.combine(day, _dt.time.min, tzinfo=now.tzinfo)
        end = _dt.datetime.combine(day, _dt.time.max, tzinfo=now.tzinfo)
        return start.timestamp(), end.timestamp()

    if value in (None, "null"):
        return None, None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return (now - _dt.timedelta(minutes=float(value))).timestamp(), now.timestamp()
    s = str(value).lower()
    if s == "today":
        return _day(now.date())
    if s == "yesterday":
        return _day((now - _dt.timedelta(days=1)).date())
    if s == "this_morning":
        start = _dt.datetime.combine(now.date(), _dt.time(0), tzinfo=now.tzinfo)
        end = _dt.datetime.combine(now.date(), _dt.time(12), tzinfo=now.tzinfo)
        return start.timestamp(), end.timestamp()
    if s == "tonight":
        start = _dt.datetime.combine(now.date(), _dt.time(18), tzinfo=now.tzinfo)
        end = _dt.datetime.combine(now.date(), _dt.time.max, tzinfo=now.tzinfo)
        return start.timestamp(), end.timestamp()
    return None, None
