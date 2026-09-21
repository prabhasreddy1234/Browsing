from __future__ import annotations

import asyncio
import re
import time
from typing import Any, AsyncIterator, Optional
from urllib.parse import quote_plus

import httpx

from .jev_system_one import MIN_CONFIDENCE, decide_tool
from .providers import call_openai_decision, summarize_page

URL_RE = re.compile(r"https?://[^\s\"'<>]+")


def _resolve_target(query: str, tool: str) -> tuple[str, str]:
    """Decide the URL to open based on the selected tool and the query."""
    urls = URL_RE.findall(query)
    if tool == "fetch_webpage" and urls:
        return urls[0], "fetch_webpage"
    if urls:
        return urls[0], "fetch_webpage"
    # Default to a web search (no API key needed). Bing is friendlier to headless browsers.
    return f"https://www.bing.com/search?q={quote_plus(query)}", "web_search"


async def _browse_with_playwright(target: str) -> dict[str, Any]:
    """Open a real headless Chromium browser, navigate, and capture the page."""
    from playwright.async_api import async_playwright  # imported lazily

    b0 = time.perf_counter()
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            page = await browser.new_page(
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                )
            )
            final_url = target
            status: Optional[int] = None
            response = await page.goto(target, wait_until="domcontentloaded", timeout=30000)
            if response is not None:
                status = response.status
                final_url = response.url
            title = await page.title()
            body_text = await page.evaluate("() => document.body ? document.body.innerText : ''")
        finally:
            await browser.close()
    browser_ms = (time.perf_counter() - b0) * 1000
    snippet = " ".join((body_text or "").split())[:800]
    return {
        "engine": "playwright-chromium-headless",
        "url": target,
        "final_url": final_url,
        "http_status": status,
        "title": title,
        "snippet": snippet,
        "browser_time_ms": browser_ms,
        "fallback": False,
    }


async def _browse_with_httpx(target: str, error: str) -> dict[str, Any]:
    """Fallback used when Playwright / its browser binary is unavailable."""
    b0 = time.perf_counter()
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        response = await client.get(
            target,
            headers={"User-Agent": "Mozilla/5.0 (compatible; JevBrowserAgent/1.0)"},
        )
    browser_ms = (time.perf_counter() - b0) * 1000
    text = re.sub(r"<[^>]+>", " ", response.text)
    snippet = " ".join(text.split())[:800]
    title_match = re.search(r"<title[^>]*>(.*?)</title>", response.text, re.IGNORECASE | re.DOTALL)
    return {
        "engine": "httpx-fallback",
        "url": target,
        "final_url": str(response.url),
        "http_status": response.status_code,
        "title": title_match.group(1).strip() if title_match else "",
        "snippet": snippet,
        "browser_time_ms": browser_ms,
        "fallback": True,
        "fallback_reason": error,
    }


TOTAL_STEPS = 3


async def _decide(approach: str, query: str, jev_model: Optional[str], openai_model: Optional[str], temperature: float) -> dict[str, Any]:
    """Run the decision stage with the chosen approach and normalise its shape.

    This is the ONLY stage that differs between the two pipelines — the browser
    and answer stages are identical, so any delta in the stats comes from here.
    """
    if approach == "jev":
        route = await decide_tool(query)
        return {
            "approach": "jev",
            "step": "jev_decide",
            "label": "Jev decides the tool",
            "tool": route.tool,
            "confidence": route.confidence,
            "probabilities": route.probabilities,
            "simulated": route.simulated,
            "low_confidence": route.low_confidence,
            "reason": (
                f"System One picked '{route.tool}' at {route.confidence:.0%} confidence"
                + (" — below the 60% guard" if route.low_confidence else "")
            ),
            "latency_ms": route.latency_ms,
            "cost": route.cost_usd,
            "input_tokens": route.input_tokens,
            "output_tokens": 0,
        }
    # approach == "llm": the LLM classifies the tool (traditional baseline).
    decision, metric = await call_openai_decision(query, openai_model, temperature)
    return {
        "approach": "llm",
        "step": "llm_decide",
        "label": "LLM decides the tool",
        "tool": decision.tool,
        "confidence": decision.confidence,
        "probabilities": {},  # a chat LLM does not return per-option probabilities
        "simulated": metric.get("model") == "mock-local",
        "low_confidence": decision.confidence < MIN_CONFIDENCE,
        "reason": decision.reason,
        "latency_ms": metric["latency_ms"],
        "cost": metric["estimated_cost"],
        "input_tokens": metric["input_tokens"],
        "output_tokens": metric["output_tokens"],
    }


async def stream_pipeline(
    query: str,
    approach: str = "jev",
    jev_model: Optional[str] = None,
    openai_model: Optional[str] = None,
    temperature: float = 0.2,
) -> AsyncIterator[dict[str, Any]]:
    """One pipeline as a live workflow: decide -> browse -> answer.

    `approach` is "jev" (System One decides) or "llm" (the LLM decides). Emits
    `step_start` / `step_end` (with latency, tokens, cost, cumulative totals) per
    stage, then a `done` event with the full result. Every event carries the
    `approach` so a merged comparison stream can tell the two apart.
    """
    steps: list[dict[str, Any]] = []
    total_cost = 0.0
    total_input_tokens = 0
    total_output_tokens = 0
    t0 = time.perf_counter()

    def cumulative() -> dict[str, Any]:
        return {
            "cumulative_time_ms": (time.perf_counter() - t0) * 1000,
            "cumulative_cost": total_cost,
            "cumulative_input_tokens": total_input_tokens,
            "cumulative_output_tokens": total_output_tokens,
        }

    def tag(event: dict[str, Any]) -> dict[str, Any]:
        return {**event, "approach": approach}

    # ── Step 1 — the decision (the only stage that differs) ───────────────────
    decide_step = "jev_decide" if approach == "jev" else "llm_decide"
    decide_label = "Jev decides the tool" if approach == "jev" else "LLM decides the tool"
    yield tag({"type": "step_start", "index": 1, "total": TOTAL_STEPS, "step": decide_step, "label": decide_label})
    decision = await _decide(approach, query, jev_model, openai_model, temperature)
    total_cost += float(decision["cost"])
    total_input_tokens += int(decision["input_tokens"])
    total_output_tokens += int(decision["output_tokens"])
    step1 = {k: decision[k] for k in ("step", "label", "tool", "confidence", "probabilities", "simulated", "reason", "latency_ms", "cost", "input_tokens", "output_tokens")}
    steps.append(step1)
    yield tag({"type": "step_end", "index": 1, "total": TOTAL_STEPS, **step1, **cumulative()})

    # ── Step 2 — open a real browser and search the web ───────────────────────
    selected_tool = decision["tool"]
    target, browse_mode = _resolve_target(query, selected_tool)
    yield tag({"type": "step_start", "index": 2, "total": TOTAL_STEPS, "step": "browser", "label": "Browser searches the web", "target": target, "mode": browse_mode})
    try:
        browser_data = await _browse_with_playwright(target)
    except Exception as exc:  # ImportError, missing binary, navigation error, etc.
        browser_data = await _browse_with_httpx(target, str(exc))
    step2 = {
        "step": "browser",
        "label": "Browser searches the web",
        "mode": browse_mode,
        "engine": browser_data["engine"],
        "url": browser_data["final_url"],
        "http_status": browser_data.get("http_status"),
        "latency_ms": browser_data["browser_time_ms"],
        "cost": 0.0,
        "input_tokens": 0,
        "output_tokens": 0,
    }
    steps.append(step2)
    yield tag({"type": "step_end", "index": 2, "total": TOTAL_STEPS, **step2, **cumulative()})

    # ── Step 3 — the LLM writes an answer grounded in the page ────────────────
    yield tag({"type": "step_start", "index": 3, "total": TOTAL_STEPS, "step": "llm_answer", "label": "LLM writes the answer"})
    summary, summary_metric = await summarize_page(query, browser_data.get("snippet", ""), openai_model, temperature)
    total_cost += float(summary_metric["estimated_cost"])
    total_input_tokens += int(summary_metric["input_tokens"])
    total_output_tokens += int(summary_metric["output_tokens"])
    step3 = {
        "step": "llm_answer",
        "label": "LLM writes the answer",
        "simulated": summary_metric.get("simulated", False),
        "reason": summary,
        "latency_ms": summary_metric["latency_ms"],
        "cost": summary_metric["estimated_cost"],
        "input_tokens": summary_metric["input_tokens"],
        "output_tokens": summary_metric["output_tokens"],
    }
    steps.append(step3)
    yield tag({"type": "step_end", "index": 3, "total": TOTAL_STEPS, **step3, **cumulative()})

    total_time_ms = (time.perf_counter() - t0) * 1000
    result = {
        "approach": approach,
        "query": query,
        "selected_tool": selected_tool,
        "decision": {k: decision[k] for k in ("tool", "confidence", "probabilities", "simulated", "low_confidence", "latency_ms", "cost", "input_tokens", "output_tokens")},
        # `jev` kept for backward compatibility with the single-pipeline browser tab.
        "jev": {
            "tool": decision["tool"],
            "confidence": decision["confidence"],
            "probabilities": decision["probabilities"],
            "simulated": decision["simulated"],
            "low_confidence": decision["low_confidence"],
            "latency_ms": decision["latency_ms"],
            "cost": decision["cost"],
            "input_tokens": decision["input_tokens"],
        },
        "answer": summary,
        "browser": browser_data,
        "steps": steps,
        "decision_latency_ms": decision["latency_ms"],
        "decision_cost": decision["cost"],
        "decision_tokens": decision["input_tokens"] + decision["output_tokens"],
        "total_time_ms": total_time_ms,
        "total_cost": total_cost,
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
        "openai_model": summary_metric.get("model"),
    }
    yield tag({"type": "done", "result": result})


# Backward-compatible alias: the single "Jev + LLM (Browser)" tab uses this.
async def stream_browser_agent(
    query: str,
    jev_model: Optional[str] = None,
    openai_model: Optional[str] = None,
    temperature: float = 0.2,
) -> AsyncIterator[dict[str, Any]]:
    async for event in stream_pipeline(query, "jev", jev_model, openai_model, temperature):
        yield event


async def run_browser_agent(
    query: str,
    jev_model: Optional[str] = None,
    openai_model: Optional[str] = None,
    temperature: float = 0.2,
) -> dict[str, Any]:
    """Non-streaming variant: drain the live workflow and return the final result."""
    result: dict[str, Any] = {}
    async for event in stream_pipeline(query, "jev", jev_model, openai_model, temperature):
        if event["type"] == "done":
            result = event["result"]
    return result


def _pct_savings(baseline: float, candidate: float) -> float:
    """How much cheaper/faster `candidate` is than `baseline`, as a percentage."""
    if not baseline:
        return 0.0
    return (baseline - candidate) / baseline * 100


def build_comparison(jev: dict[str, Any], llm: dict[str, Any]) -> dict[str, Any]:
    """Side-by-side stats. The browser + answer stages are identical across both,
    so every delta is attributable to the decision layer (Jev vs LLM)."""
    return {
        "same_tool": jev["selected_tool"] == llm["selected_tool"],
        "jev_tool": jev["selected_tool"],
        "llm_tool": llm["selected_tool"],
        "decision_latency_ms": {"jev": jev["decision_latency_ms"], "llm": llm["decision_latency_ms"]},
        "decision_cost": {"jev": jev["decision_cost"], "llm": llm["decision_cost"]},
        "decision_tokens": {"jev": jev["decision_tokens"], "llm": llm["decision_tokens"]},
        "total_time_ms": {"jev": jev["total_time_ms"], "llm": llm["total_time_ms"]},
        "total_cost": {"jev": jev["total_cost"], "llm": llm["total_cost"]},
        "total_tokens": {
            "jev": jev["total_input_tokens"] + jev["total_output_tokens"],
            "llm": llm["total_input_tokens"] + llm["total_output_tokens"],
        },
        # Positive = Jev is cheaper / faster than the LLM-only approach.
        "decision_cost_savings_pct": _pct_savings(llm["decision_cost"], jev["decision_cost"]),
        "decision_latency_savings_pct": _pct_savings(llm["decision_latency_ms"], jev["decision_latency_ms"]),
        "total_cost_savings_pct": _pct_savings(llm["total_cost"], jev["total_cost"]),
        "total_time_savings_pct": _pct_savings(llm["total_time_ms"], jev["total_time_ms"]),
    }


async def stream_compare(
    query: str,
    jev_model: Optional[str] = None,
    openai_model: Optional[str] = None,
    temperature: float = 0.2,
) -> AsyncIterator[dict[str, Any]]:
    """Run BOTH pipelines concurrently and interleave their live events.

    Each event is tagged with its `approach` ("jev" or "llm"). When both finish,
    emits a final `comparison` event with side-by-side stats for benchmarking.
    """
    queue: asyncio.Queue = asyncio.Queue()
    results: dict[str, dict[str, Any]] = {}

    async def pump(approach: str) -> None:
        try:
            async for event in stream_pipeline(query, approach, jev_model, openai_model, temperature):
                await queue.put(event)
        except Exception as exc:  # pragma: no cover
            await queue.put({"type": "error", "approach": approach, "error": str(exc)})
        finally:
            await queue.put({"type": "_pipeline_done", "approach": approach})

    tasks = [asyncio.create_task(pump("jev")), asyncio.create_task(pump("llm"))]

    finished = 0
    try:
        while finished < 2:
            event = await queue.get()
            if event["type"] == "_pipeline_done":
                finished += 1
                continue
            if event["type"] == "done":
                results[event["approach"]] = event["result"]
            yield event
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()

    if "jev" in results and "llm" in results:
        yield {
            "type": "comparison",
            "jev": results["jev"],
            "llm": results["llm"],
            "comparison": build_comparison(results["jev"], results["llm"]),
        }
