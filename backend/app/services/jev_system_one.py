from __future__ import annotations

"""Jev — TypeSafe "System One" decision layer.

A faithful implementation of the Jev System One pattern:

  * Jev returns *typed, probabilistic decisions* (choice / score / bool), not text.
  * One call = typed questions in, a normalised plain value out, with latency,
    input tokens, cost (input only, output free) and a `simulated` flag attached.
  * With no TYPESAFE_API_KEY the offline heuristic answers instead, badged
    `simulated`, with a realistic ~70-200 ms System One latency.

"Jev makes the decision. An LLM writes the words. Your code owns the control flow."
"""

import asyncio
import json
import random
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

import httpx

from ..config import TYPESAFE_API_KEY, has_jev_key, jev_cost_usd

# Below this Jev confidence, callers may choose to escalate / double-check:
# a wrong cheap decision usually costs more than a wasted safe one.
MIN_CONFIDENCE = 0.6


# ── Typed question builders (mirror @typesafe-ai/sdk choice/score/noul) ───────
def choice(question: str, options: dict[str, str]) -> dict[str, Any]:
    """A single pick from labelled options."""
    return {"type": "choice", "question": question, "options": options}


def score(question: str, labels: list[str]) -> dict[str, Any]:
    """A graded score across ordered labels (0..len-1)."""
    return {"type": "score", "question": question, "labels": labels}


def boolean(question: str) -> dict[str, Any]:
    """A yes/no probability (the SDK's `noul`)."""
    return {"type": "bool", "question": question}


@dataclass
class Timed:
    value: Any
    latency_ms: float
    input_tokens: int
    cost_usd: float
    simulated: bool
    raw: dict[str, Any] = field(default_factory=dict)


async def _typesafe_system_one(state: Any, questions: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Best-effort call to the real TypeSafe System One API.

    The official client is a Node SDK (`@typesafe-ai/sdk`). Here we POST the
    equivalent payload; any failure bubbles up so the caller falls back to the
    simulated heuristic (exactly how the reference behaves without a key).
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            "https://api.typesafe.ai/v1/system-one",
            headers={"Authorization": f"Bearer {TYPESAFE_API_KEY}", "Content-Type": "application/json"},
            json={"state": state, "questions": questions},
        )
    if response.status_code >= 400:
        raise RuntimeError(f"TypeSafe API error: {response.text[:300]}")
    data = response.json()
    return data.get("answers", {}), data.get("usage", {})


async def jev_call(
    state: Any,
    questions: dict[str, Any],
    normalize: Callable[[dict[str, Any]], Any],
    mock: Callable[[], Any],
) -> Timed:
    """One Jev call. Typed questions in, a normalised value out, timed and costed."""
    started = time.perf_counter()
    text = state if isinstance(state, str) else json.dumps(state)

    if not has_jev_key():
        input_tokens = (len(text) // 4) + 60 * len(questions)
        # System One is fast: ~70-200 ms. Simulate that so the demo feels real.
        await asyncio.sleep(0.07 + random.random() * 0.13)
        return Timed(
            value=mock(),
            latency_ms=round((time.perf_counter() - started) * 1000, 1),
            input_tokens=input_tokens,
            cost_usd=jev_cost_usd(input_tokens),
            simulated=True,
        )

    try:
        answers, usage = await _typesafe_system_one(state, questions)
        input_tokens = int(usage.get("input_tokens") or (len(text) // 4))
        return Timed(
            value=normalize(answers),
            latency_ms=round((time.perf_counter() - started) * 1000, 1),
            input_tokens=input_tokens,
            cost_usd=jev_cost_usd(input_tokens),
            simulated=False,
            raw=answers,
        )
    except Exception:
        # Account/API problem — degrade to the simulated heuristic rather than fail.
        input_tokens = (len(text) // 4) + 60 * len(questions)
        return Timed(
            value=mock(),
            latency_ms=round((time.perf_counter() - started) * 1000, 1),
            input_tokens=input_tokens,
            cost_usd=jev_cost_usd(input_tokens),
            simulated=True,
        )


# ── The tool-routing "policy", expressed as typed Jev questions ───────────────
TOOL_OPTIONS: dict[str, str] = {
    "web_search": "Search the public web for current information or facts",
    "fetch_webpage": "Retrieve a specific page by its URL",
    "weather": "Get current or forecast weather for a location",
    "calculator": "Perform arithmetic or numeric calculations",
    "database_search": "Query a structured internal database or records",
    "file_search": "Search local files, documents, or a knowledge base",
    "no_tool": "No tool is needed; the request is conversational or trivial",
}

_ROUTING_QUESTIONS = {
    "tool": choice("Which single tool best satisfies this user query?", TOOL_OPTIONS),
    "clarity": score(
        "How clearly does the query point to one tool?",
        ["Ambiguous", "Somewhat clear", "Clear", "Unmistakable"],
    ),
}


@dataclass
class ToolRoute:
    tool: str
    confidence: float
    probabilities: dict[str, float]
    clarity: float
    latency_ms: float
    input_tokens: int
    cost_usd: float
    simulated: bool
    low_confidence: bool


def _heuristic_route(query: str) -> dict[str, Any]:
    from .heuristics import get_local_fallback_tool

    tool = get_local_fallback_tool(query)
    top = 0.88
    rest = (1 - top) / (len(TOOL_OPTIONS) - 1)
    probabilities = {name: (top if name == tool else rest) for name in TOOL_OPTIONS}
    return {"tool": tool, "confidence": top, "probabilities": probabilities, "clarity": 2.4}


def _normalize_route(answers: dict[str, Any]) -> dict[str, Any]:
    tool_answer = answers.get("tool", {})
    return {
        "tool": tool_answer.get("choice"),
        "confidence": float(tool_answer.get("confidence", 0.0)),
        "probabilities": tool_answer.get("probabilities", {}),
        "clarity": float(answers.get("clarity", {}).get("score", 0.0)),
    }


async def decide_tool(query: str) -> ToolRoute:
    """Jev's typed decision: which tool does this query need?"""
    r = await jev_call(
        query[:60_000],
        _ROUTING_QUESTIONS,
        _normalize_route,
        lambda: _heuristic_route(query),
    )
    v = r.value
    return ToolRoute(
        tool=v["tool"],
        confidence=v["confidence"],
        probabilities=v.get("probabilities", {}),
        clarity=v.get("clarity", 0.0),
        latency_ms=r.latency_ms,
        input_tokens=r.input_tokens,
        cost_usd=r.cost_usd,
        simulated=r.simulated,
        low_confidence=v["confidence"] < MIN_CONFIDENCE,
    )
