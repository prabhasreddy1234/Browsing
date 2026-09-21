from __future__ import annotations

import json
import time
from typing import Any, Tuple

import httpx

from ..config import JEV_MODEL, OPENAI_API_KEY, OPENAI_MODEL, OPENROUTER_API_KEY
from ..models import DecisionResponse
from ..tool_registry import TOOL_NAMES
from .heuristics import get_local_fallback_tool
from .pricing import DEFAULT_PRICING, estimate_cost


class ProviderError(RuntimeError):
    pass


def build_local_fallback_decision(query: str, provider: str) -> Tuple[DecisionResponse, dict[str, Any]]:
    tool = get_local_fallback_tool(query)
    reason = "Local fallback heuristic selected the most likely tool for a deterministic benchmark run when no API key was configured."
    decision = DecisionResponse(tool=tool, confidence=0.88, reason=reason)
    input_tokens = max(120, min(1800, len(query) * 4))
    output_tokens = 60
    estimated_cost = estimate_cost(input_tokens, output_tokens, "mock", provider, {provider: {"mock": {"input": 0.00012, "output": 0.0004}}})
    metric = {
        "provider": provider,
        "model": "mock-local",
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "latency_ms": 35.0,
        "estimated_cost": estimated_cost,
        "selected_tool": tool,
        "confidence": 0.88,
        "reason": reason,
        "mode": "simulated",
    }
    return decision, metric


def validate_decision(raw: Any) -> DecisionResponse:
    if isinstance(raw, DecisionResponse):
        decision = raw
    elif isinstance(raw, dict):
        decision = DecisionResponse.model_validate(raw)
    else:
        raise ProviderError("Model response was not a structured object.")

    if decision.tool not in TOOL_NAMES:
        raise ProviderError(f"Tool '{decision.tool}' is not in the registered tool set.")
    if not 0.0 <= decision.confidence <= 1.0:
        raise ProviderError("Confidence must be between 0 and 1.")
    return decision


async def call_openai_decision(query: str, model_name: str = None, temperature: float = 0.0) -> Tuple[DecisionResponse, dict[str, Any]]:
    if not OPENAI_API_KEY:
        return build_local_fallback_decision(query, "openai")

    payload = {
        "model": model_name or OPENAI_MODEL,
        "temperature": temperature,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": "Select the single best tool from the registry to satisfy the user query. Return JSON only with keys tool, confidence, reason."},
            {"role": "user", "content": json.dumps({
                "query": query,
                "tools": [
                    {"name": "web_search", "description": "Search the public web for current information or facts.", "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
                    {"name": "fetch_webpage", "description": "Retrieve a specific page by URL.", "input_schema": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}},
                    {"name": "weather", "description": "Get current or forecast weather.", "input_schema": {"type": "object", "properties": {"location": {"type": "string"}}, "required": ["location"]}},
                    {"name": "calculator", "description": "Perform arithmetic and formulas.", "input_schema": {"type": "object", "properties": {"expression": {"type": "string"}}, "required": ["expression"]}},
                    {"name": "database_search", "description": "Query a structured internal database.", "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
                    {"name": "file_search", "description": "Search local files, docs, and notes.", "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
                    {"name": "no_tool", "description": "No tool is needed.", "input_schema": {"type": "object", "properties": {}, "required": []}},
                ],
            })},
        ],
    }

    t0 = time.perf_counter()
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
            json=payload,
        )
    latency_ms = (time.perf_counter() - t0) * 1000
    if response.status_code >= 400:
        raise ProviderError(f"OpenAI API error: {response.text[:500]}")
    data = response.json()
    content = data["choices"][0]["message"]["content"]
    parsed = json.loads(content)
    decision = validate_decision(parsed)
    usage = data.get("usage", {})
    metric = {
        "provider": "openai",
        "model": model_name or OPENAI_MODEL,
        "input_tokens": usage.get("prompt_tokens", 0),
        "output_tokens": usage.get("completion_tokens", 0),
        "latency_ms": latency_ms,
        "estimated_cost": estimate_cost(usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0), model_name or OPENAI_MODEL, "openai", DEFAULT_PRICING),
        "selected_tool": decision.tool,
        "confidence": decision.confidence,
        "reason": decision.reason,
    }
    return decision, metric


async def call_jev_decision(query: str, model_name: str = None) -> Tuple[DecisionResponse, dict[str, Any]]:
    """Jev decision via the real System One layer.

    Jev returns a *typed* choice (not text), so cost is input-tokens only
    ($0.042/1M, output free) and output_tokens is always 0. When no
    TYPESAFE_API_KEY is set this runs in badged simulation mode.
    """
    from .jev_system_one import decide_tool  # local import avoids a cycle

    route = await decide_tool(query)
    reason = (
        f"Jev System One selected '{route.tool}' with {route.confidence:.0%} confidence"
        + (" (simulated — no TYPESAFE_API_KEY)." if route.simulated else ".")
    )
    decision = DecisionResponse(tool=route.tool, confidence=route.confidence, reason=reason)
    metric = {
        "provider": "jev",
        "model": model_name or JEV_MODEL,
        "input_tokens": route.input_tokens,
        "output_tokens": 0,  # System One returns a typed decision; output is free.
        "latency_ms": route.latency_ms,
        "estimated_cost": route.cost_usd,
        "selected_tool": route.tool,
        "confidence": route.confidence,
        "probabilities": route.probabilities,
        "reason": reason,
        "simulated": route.simulated,
        "low_confidence": route.low_confidence,
        "mode": "simulated" if route.simulated else "live",
    }
    return decision, metric


async def summarize_page(query: str, page_text: str, model_name: str = None, temperature: float = 0.2) -> Tuple[str, dict[str, Any]]:
    """The LLM "writes the words": a short answer grounded in the fetched page.

    This is the text-generation half of the pattern — Jev decided the tool, the
    code opened the browser, and now the LLM turns the page into an answer.
    """
    snippet = (page_text or "")[:4000]
    if not OPENAI_API_KEY:
        text = (
            f"[Simulated summary — no OPENAI_API_KEY] For \"{query}\", the page returned: "
            + " ".join(snippet.split())[:280]
        )
        input_tokens = max(80, len(snippet) // 4)
        output_tokens = 60
        return text, {
            "provider": "openai",
            "model": "mock-local",
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "latency_ms": 40.0,
            "estimated_cost": estimate_cost(input_tokens, output_tokens, "mock", "openai", {"openai": {"mock": {"input": 0.00015, "output": 0.0006}}}),
            "simulated": True,
        }

    model = model_name or OPENAI_MODEL
    payload = {
        "model": model,
        "temperature": temperature,
        "messages": [
            {"role": "system", "content": "You are a concise assistant. Using only the provided page text, answer the user's query in 2-3 sentences. If the page does not contain the answer, say so."},
            {"role": "user", "content": json.dumps({"query": query, "page_text": snippet})},
        ],
    }
    t0 = time.perf_counter()
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
            json=payload,
        )
    latency_ms = (time.perf_counter() - t0) * 1000
    if response.status_code >= 400:
        raise ProviderError(f"OpenAI API error: {response.text[:500]}")
    data = response.json()
    text = data["choices"][0]["message"]["content"].strip()
    usage = data.get("usage", {})
    metric = {
        "provider": "openai",
        "model": model,
        "input_tokens": usage.get("prompt_tokens", 0),
        "output_tokens": usage.get("completion_tokens", 0),
        "latency_ms": latency_ms,
        "estimated_cost": estimate_cost(usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0), model, "openai", DEFAULT_PRICING),
        "simulated": False,
    }
    return text, metric
