from __future__ import annotations

import asyncio
import difflib
import re
import time
from typing import Any, AsyncIterator, Optional
from urllib.parse import quote_plus

import httpx

from .jev_system_one import MIN_CONFIDENCE, decide_tool
from .providers import call_openai_decision, summarize_page

URL_RE = re.compile(r"https?://[^\s\"'<>]+")
DOMAIN_RE = re.compile(r"\b((?:https?://)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)\b", re.I)
COMMON_TLDS = (".com", ".org", ".net", ".io", ".gov", ".edu", ".co", ".ai", ".dev", ".info", ".news", ".tv")
# Words that mark the end of a search phrase, e.g. "search for NBA in wikipedia.org".
_STOP_RE = re.compile(r"\b(?:in|on|at|from|using|within|website|site|web ?site|the web|google|browser)\b", re.I)


# Popular sites we auto-correct obvious typos toward (e.g. "wikipidea.org").
KNOWN_SITES = [
    "wikipedia.org", "bing.com", "duckduckgo.com", "reddit.com", "stackoverflow.com",
    "github.com", "youtube.com", "imdb.com", "amazon.com", "news.ycombinator.com",
    "nytimes.com", "bbc.com", "cnn.com", "espn.com",
]


def _canonical_host(host: str) -> Optional[str]:
    """If `host` is a close typo of a well-known site, return the correct one."""
    h = host.lower()
    if h.startswith("www."):
        h = h[4:]
    match = difflib.get_close_matches(h, KNOWN_SITES, n=1, cutoff=0.80)
    if match and match[0] != h:
        return match[0]
    return None


def _extract_site(query: str) -> Optional[str]:
    """Find a website mentioned in the query (with or without scheme), fixing obvious typos."""
    for match in DOMAIN_RE.finditer(query):
        candidate = match.group(1)
        host = candidate.split("//")[-1].split("/")[0].lower()
        if not any(host.endswith(tld) for tld in COMMON_TLDS):
            continue
        corrected = _canonical_host(host)
        if corrected:
            return f"https://{corrected}"
        return candidate if candidate.lower().startswith("http") else f"https://{candidate}"
    return None


def _extract_search_term(query: str) -> Optional[str]:
    """Pull the thing to search for out of phrases like 'search for X in SITE'."""
    for pattern in (r"search\s+for\s+(.+)", r"search\s+(.+)", r"look\s*up\s+(.+)", r"find\s+(.+)", r"query\s+(.+)"):
        match = re.search(pattern, query, re.I)
        if not match:
            continue
        term = match.group(1)
        term = _STOP_RE.split(term)[0]          # cut off "... in <site>"
        term = DOMAIN_RE.sub("", term)           # drop any domain left in the phrase
        term = term.strip(" .,\"'\t")
        if term:
            return term
    return None


def _parse_intent(query: str, tool: str) -> dict[str, Any]:
    """Turn the prompt into a concrete browser action.

    Handles three shapes:
      - "search for X in SITE"  -> open SITE and search it for X   (site_search)
      - a URL / a bare site     -> open that page                  (fetch_webpage)
      - anything else           -> a web search                    (web_search)
    """
    site = _extract_site(query)
    term = _extract_search_term(query)
    urls = URL_RE.findall(query)

    if site and term:
        return {"mode": "site_search", "url": site, "search_term": term}
    if urls:  # a full URL (with its path) wins over a bare domain
        return {"mode": "fetch_webpage", "url": urls[0], "search_term": None}
    if site:
        return {"mode": "fetch_webpage", "url": site, "search_term": None}
    # Default: web search (Bing is friendlier to automated browsers than most).
    return {"mode": "web_search", "url": f"https://www.bing.com/search?q={quote_plus(query)}", "search_term": None}


# Buttons that dismiss a cookie / consent dialog which would otherwise block typing.
_CONSENT_SELECTORS = [
    "button#L2AGLb",                       # Google "Accept all"
    'button:has-text("Accept all")',
    'button:has-text("I agree")',
    'button:has-text("Agree")',
    'button:has-text("Accept")',
    'button:has-text("Got it")',
]

# Search boxes, most-specific first. `textarea[name="q"]` is Google's current box.
_SEARCH_SELECTORS = [
    'textarea[name="q"]',                  # Google (current)
    'input[name="q"]',                     # Bing, older Google
    "input#searchInput",                   # Wikipedia / MediaWiki
    'input[name="search"]',
    'input[type="search"]',
    'input[name="query"]',
    'textarea[aria-label*="search" i]',
    'input[aria-label*="search" i]',
    'input[placeholder*="search" i]',
    'textarea[placeholder*="search" i]',
    'input[title*="search" i]',
]


async def _perform_site_search(page, term: str) -> bool:
    """Type `term` into the site's own search box and submit. Returns True if it found one."""
    # Best-effort: clear a consent/cookie dialog that would block interaction.
    for selector in _CONSENT_SELECTORS:
        try:
            button = await page.query_selector(selector)
            if button:
                await button.click(timeout=2000)
                await page.wait_for_timeout(400)
                break
        except Exception:
            pass

    for selector in _SEARCH_SELECTORS:
        try:
            element = await page.query_selector(selector)
        except Exception:
            element = None
        if not element:
            continue
        try:
            await element.click()
            await element.fill(term)
            await element.press("Enter")
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=15000)
            except Exception:
                pass
            await page.wait_for_timeout(1200)  # let results render
            return True
        except Exception:
            continue
    return False


async def _browse_with_playwright(target: str, headed: bool = False, search_term: Optional[str] = None) -> dict[str, Any]:
    """Open a real Chromium browser, navigate, optionally search on the site, and capture the page.

    When `headed` is True the browser window is shown on screen and slowed down a
    little so the automation is visible; otherwise it runs headless (invisible).
    When `search_term` is set, the site's own search box is filled and submitted.
    """
    from playwright.async_api import async_playwright  # imported lazily

    b0 = time.perf_counter()
    searched_on_site = False
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=not headed, slow_mo=350 if headed else 0)
        try:
            page = await browser.new_page(
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                )
            )
            if headed:
                await page.bring_to_front()
            final_url = target
            status: Optional[int] = None
            response = await page.goto(target, wait_until="domcontentloaded", timeout=30000)
            if response is not None:
                status = response.status
                final_url = response.url
            # Perform the search ON the site itself, if requested.
            if search_term:
                searched_on_site = await _perform_site_search(page, search_term)
                final_url = page.url
            title = await page.title()
            # Prefer the main results/content region so the LLM gets the answer,
            # not the page's nav and boilerplate.
            body_text = await page.evaluate(
                "() => { const m = document.querySelector('#b_results, #main, main, [role=main], article'); "
                "const el = m || document.body; return el ? el.innerText : ''; }"
            )
            if headed:
                # Keep the window on screen long enough to actually watch it.
                await page.wait_for_timeout(2500)
        finally:
            await browser.close()
    browser_ms = (time.perf_counter() - b0) * 1000
    snippet = " ".join((body_text or "").split())[:1500]
    return {
        "engine": "playwright-chromium-headed" if headed else "playwright-chromium-headless",
        "url": target,
        "final_url": final_url,
        "http_status": status,
        "title": title,
        "snippet": snippet,
        "browser_time_ms": browser_ms,
        "fallback": False,
        "searched_on_site": searched_on_site,
        "search_term": search_term,
    }


async def _browse_with_httpx(target: str, error: str, search_term: Optional[str] = None) -> dict[str, Any]:
    """Fallback used when a real browser cannot open (no display / missing binary).

    Cannot run a site's JS search box, so when a search was requested it falls
    back to a Bing web search for the term instead of the bare site.
    """
    fetch_url = f"https://www.bing.com/search?q={quote_plus(search_term)}" if search_term else target
    b0 = time.perf_counter()
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        response = await client.get(
            fetch_url,
            headers={"User-Agent": "Mozilla/5.0 (compatible; JevBrowserAgent/1.0)"},
        )
    browser_ms = (time.perf_counter() - b0) * 1000
    text = re.sub(r"<[^>]+>", " ", response.text)
    snippet = " ".join(text.split())[:1500]
    title_match = re.search(r"<title[^>]*>(.*?)</title>", response.text, re.IGNORECASE | re.DOTALL)
    return {
        "engine": "httpx-fallback",
        "url": fetch_url,
        "final_url": str(response.url),
        "http_status": response.status_code,
        "title": title_match.group(1).strip() if title_match else "",
        "snippet": snippet,
        "browser_time_ms": browser_ms,
        "fallback": True,
        "fallback_reason": error,
        "searched_on_site": False,
        "search_term": search_term,
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
    headed: bool = False,
) -> AsyncIterator[dict[str, Any]]:
    """One pipeline as a live workflow: decide -> browse -> answer.

    `approach` is "jev" (System One decides) or "llm" (the LLM decides). When
    `headed` is True the browser opens visibly on screen. Emits `step_start` /
    `step_end` (with latency, tokens, cost, cumulative totals) per stage, then a
    `done` event with the full result. Every event carries the `approach` so a
    merged comparison stream can tell the two apart.
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

    # ── Step 2 — open a real browser and search the web / a specific site ─────
    selected_tool = decision["tool"]
    intent = _parse_intent(query, selected_tool)
    target = intent["url"]
    browse_mode = intent["mode"]
    search_term = intent["search_term"]
    label2 = (
        f"Browser searches '{search_term}' on the site" if browse_mode == "site_search"
        else "Browser opens the page" if browse_mode == "fetch_webpage"
        else "Browser searches the web"
    )
    yield tag({"type": "step_start", "index": 2, "total": TOTAL_STEPS, "step": "browser", "label": label2, "target": target, "mode": browse_mode, "search_term": search_term, "headed": headed})
    try:
        # Hard cap so a stuck/headed browser can never hang the request forever.
        browser_data = await asyncio.wait_for(
            _browse_with_playwright(target, headed=headed, search_term=search_term),
            timeout=60.0,
        )
    except Exception as exc:  # ImportError, missing binary, no display, timeout, nav error…
        browser_data = await _browse_with_httpx(target, str(exc), search_term=search_term)
    step2 = {
        "step": "browser",
        "label": label2,
        "mode": browse_mode,
        "engine": browser_data["engine"],
        "url": browser_data["final_url"],
        "http_status": browser_data.get("http_status"),
        "searched_on_site": browser_data.get("searched_on_site", False),
        "search_term": search_term,
        "latency_ms": browser_data["browser_time_ms"],
        "cost": 0.0,
        "input_tokens": 0,
        "output_tokens": 0,
    }
    steps.append(step2)
    yield tag({"type": "step_end", "index": 2, "total": TOTAL_STEPS, **step2, **cumulative()})

    # ── Step 3 — the LLM writes an answer grounded in the page ────────────────
    yield tag({"type": "step_start", "index": 3, "total": TOTAL_STEPS, "step": "llm_answer", "label": "LLM writes the answer"})
    answer_query = search_term or query
    summary, summary_metric = await summarize_page(answer_query, browser_data.get("snippet", ""), openai_model, temperature)
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
