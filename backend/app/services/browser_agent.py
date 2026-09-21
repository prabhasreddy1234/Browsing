from __future__ import annotations

import re
import time
from typing import Any, AsyncIterator, Optional
from urllib.parse import quote_plus

import httpx

from .jev_system_one import MIN_CONFIDENCE, decide_tool
from .providers import summarize_page

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


async def stream_browser_agent(
    query: str,
    jev_model: Optional[str] = None,
    openai_model: Optional[str] = None,
    temperature: float = 0.2,
) -> AsyncIterator[dict[str, Any]]:
    """Run the agent as a live workflow, yielding an event per stage.

    Emits `step_start` before each stage and `step_end` (with latency, tokens,
    cost and cumulative totals) after it, then a final `done` event carrying the
    full result. Follows the mantra: Jev decides, the code opens the browser,
    the LLM writes the words.
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

    # ── Step 1 — Jev (System One) makes the typed decision ────────────────────
    yield {"type": "step_start", "index": 1, "total": TOTAL_STEPS, "step": "jev_decide", "label": "Jev decides the tool"}
    route = await decide_tool(query)
    total_cost += route.cost_usd
    total_input_tokens += route.input_tokens
    step1 = {
        "step": "jev_decide",
        "label": "Jev decides the tool",
        "tool": route.tool,
        "confidence": route.confidence,
        "probabilities": route.probabilities,
        "simulated": route.simulated,
        "reason": (
            f"System One picked '{route.tool}' at {route.confidence:.0%} confidence"
            + (" — below the 60% guard, worth double-checking" if route.low_confidence else "")
        ),
        "latency_ms": route.latency_ms,
        "cost": route.cost_usd,
        "input_tokens": route.input_tokens,
        "output_tokens": 0,
    }
    steps.append(step1)
    yield {"type": "step_end", "index": 1, "total": TOTAL_STEPS, **step1, **cumulative()}

    # ── Step 2 — the CODE owns control flow: open a real browser ──────────────
    selected_tool = route.tool
    target, browse_mode = _resolve_target(query, selected_tool)
    yield {"type": "step_start", "index": 2, "total": TOTAL_STEPS, "step": "browser", "label": "Browser opens the page", "target": target, "mode": browse_mode}
    try:
        browser_data = await _browse_with_playwright(target)
    except Exception as exc:  # ImportError, missing binary, navigation error, etc.
        browser_data = await _browse_with_httpx(target, str(exc))
    step2 = {
        "step": "browser",
        "label": "Browser opens the page",
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
    yield {"type": "step_end", "index": 2, "total": TOTAL_STEPS, **step2, **cumulative()}

    # ── Step 3 — the LLM writes the words: an answer grounded in the page ─────
    yield {"type": "step_start", "index": 3, "total": TOTAL_STEPS, "step": "llm_answer", "label": "LLM writes the answer"}
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
    yield {"type": "step_end", "index": 3, "total": TOTAL_STEPS, **step3, **cumulative()}

    total_time_ms = (time.perf_counter() - t0) * 1000
    result = {
        "query": query,
        "selected_tool": selected_tool,
        "jev": {
            "tool": route.tool,
            "confidence": route.confidence,
            "probabilities": route.probabilities,
            "clarity": route.clarity,
            "simulated": route.simulated,
            "low_confidence": route.low_confidence,
            "latency_ms": route.latency_ms,
            "cost": route.cost_usd,
            "input_tokens": route.input_tokens,
        },
        "answer": summary,
        "browser": browser_data,
        "steps": steps,
        "total_time_ms": total_time_ms,
        "total_cost": total_cost,
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
        "openai_model": summary_metric.get("model"),
    }
    yield {"type": "done", "result": result}


async def run_browser_agent(
    query: str,
    jev_model: Optional[str] = None,
    openai_model: Optional[str] = None,
    temperature: float = 0.2,
) -> dict[str, Any]:
    """Non-streaming variant: drain the live workflow and return the final result."""
    result: dict[str, Any] = {}
    async for event in stream_browser_agent(query, jev_model, openai_model, temperature):
        if event["type"] == "done":
            result = event["result"]
    return result
