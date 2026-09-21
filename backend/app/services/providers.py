from __future__ import annotations

import json
import time
from typing import Any, Tuple

import httpx

from ..config import JEV_MODEL, OPENAI_API_KEY, OPENAI_MODEL, OPENROUTER_API_KEY
from ..models import DecisionResponse
from ..tool_registry import TOOL_NAMES
from .pricing import DEFAULT_PRICING, estimate_cost


class ProviderError(RuntimeError):
    pass


def get_local_fallback_tool(query: str) -> str:
    q = query.lower()
    if any(term in q for term in ["weather", "rain", "temperature", "forecast", "sunny", "cloudy", "humidity", "umbrella", "snow"]):
        return "weather"
    if any(term in q for term in ["calculate", "calculator", "math", "sum", "product", "multiply", "divide", "add", "subtract", "+", "*", "-", "%", "equation", "interest", "discount", "square root"]):
        return "calculator"
    if any(term in q for term in ["http://", "https://", "url", "page", "article", "homepage", "website", "blog"]):
        return "fetch_webpage"
    if any(term in q for term in ["customer", "record", "id", "database", "crm", "sales", "orders", "patient", "vip account", "transaction", "query the db", "lookup user"]):
        return "database_search"
    if any(term in q for term in ["document", "doc", "file", "readme", "notes", "project", "repo", "in my files", "search local", "policy", "handbook", "issue tracker"]):
        return "file_search"
    if any(term in q for term in ["search the web", "latest", "latest news", "find information", "who is", "what is the capital", "release notes", "openai", "android", "tesla", "stock", "public information", "latest release"]):
        return "web_search"
    if q.strip() == "":
        return "no_tool"
    return "no_tool"


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
    if not OPENROUTER_API_KEY:
        return build_local_fallback_decision(query, "jev")

    model = model_name or JEV_MODEL
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "Select the single best tool. Return JSON with tool, confidence, reason only."},
            {"role": "user", "content": json.dumps({
                "query": query,
                "tool_registry": [
                    {"name": "web_search", "description": "Search the public web for current information or facts.", "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
                    {"name": "fetch_webpage", "description": "Retrieve a specific page by URL.", "input_schema": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}},
                    {"name": "weather", "description": "Get current or forecast weather.", "input_schema": {"type": "object", "properties": {"location": {"type": "string"}}, "required": ["location"]}},
                    {"name": "calculator", "description": "Perform arithmetic and formulas.", "input_schema": {"type": "object", "properties": {"expression": {"type": "string"}}, "required": ["expression"]}},
                    {"name": "database_search", "description": "Query a structured internal database.", "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
                    {"name": "file_search", "description": "Search local files, docs, and notes.", "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
                    {"name": "no_tool", "description": "No tool is needed.", "input_schema": {"type": "object", "properties": {}, "required": []}},
                ]
            })}
        ],
        "response_format": {"type": "json_schema", "json_schema": {"name": "tool_decision", "schema": {"type": "object", "properties": {"tool": {"type": "string"}, "confidence": {"type": "number"}, "reason": {"type": "string"}}, "required": ["tool", "confidence", "reason"], "additionalProperties": False}}}
    }

    t0 = time.perf_counter()
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENROUTER_API_KEY}", "Content-Type": "application/json", "HTTP-Referer": "http://localhost:5173", "X-Title": "Jev Decision Benchmark"},
            json=payload,
        )
    latency_ms = (time.perf_counter() - t0) * 1000
    if response.status_code >= 400:
        raise ProviderError(f"OpenRouter API error: {response.text[:500]}")
    data = response.json()
    content = data["choices"][0]["message"]["content"]
    parsed = json.loads(content)
    decision = validate_decision(parsed)
    usage = data.get("usage", {})
    metric = {
        "provider": "jev",
        "model": model,
        "input_tokens": usage.get("prompt_tokens", 0),
        "output_tokens": usage.get("completion_tokens", 0),
        "latency_ms": latency_ms,
        "estimated_cost": estimate_cost(usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0), model, "jev", DEFAULT_PRICING),
        "selected_tool": decision.tool,
        "confidence": decision.confidence,
        "reason": decision.reason,
    }
    return decision, metric
