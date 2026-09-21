from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.config import JEV_MODEL, OPENAI_MODEL
from app.data.benchmark_queries import BENCHMARK_QUERIES
from app.db import init_db, list_runs, save_run
from app.services.browser_agent import run_browser_agent, stream_browser_agent, stream_compare
from app.services.pricing import DEFAULT_PRICING, estimate_cost
from app.services.providers import ProviderError, call_jev_decision, call_openai_decision
from app.tool_registry import TOOL_NAMES

app = FastAPI(title="Jev Decision Benchmark")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

init_db()


class DecisionRequest(BaseModel):
    query: str
    model: Optional[str] = None
    temperature: float = 0.0


class RunBenchmarkRequest(BaseModel):
    queries: Optional[list[str]] = None
    runs: int = 1
    openai_model: str = OPENAI_MODEL
    jev_model: str = JEV_MODEL
    temperature: float = 0.0
    run_openai: bool = True
    run_jev: bool = True


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/status")
async def status() -> dict[str, Any]:
    """Reference-style status: is Jev live or simulated, its price, LLM keys, budget."""
    from app.config import DEMO_BUDGET_USD, JEV_IN_PER_M, OPENAI_API_KEY, has_jev_key

    return {
        "jev": "live" if has_jev_key() else "simulated",
        "jev_in_per_m": JEV_IN_PER_M,
        "jev_note": "Typed System One decisions — input-billed only, output free.",
        "llm": "live" if OPENAI_API_KEY else "simulated",
        "llm_model": OPENAI_MODEL,
        "budget_usd": DEMO_BUDGET_USD,
    }


@app.post("/api/decision/jev")
async def decide_jev(payload: DecisionRequest) -> dict[str, Any]:
    try:
        decision, metric = await call_jev_decision(payload.query, payload.model)
        return {"decision": decision.model_dump(), "metrics": metric}
    except ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/decision/openai")
async def decide_openai(payload: DecisionRequest) -> dict[str, Any]:
    try:
        decision, metric = await call_openai_decision(payload.query, payload.model, payload.temperature)
        return {"decision": decision.model_dump(), "metrics": metric}
    except ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/tools")
async def tools() -> dict[str, list[str]]:
    return {"tools": sorted(TOOL_NAMES)}


class LlmOnlyRequest(BaseModel):
    query: str
    model: Optional[str] = None
    temperature: float = 0.0


@app.post("/api/agent/llm-only")
async def agent_llm_only(payload: LlmOnlyRequest) -> dict[str, Any]:
    """Tab 1 — pure LLM: the model alone selects a tool. Logs time and cost."""
    if not payload.query.strip():
        raise HTTPException(status_code=400, detail="Query must not be empty.")
    try:
        decision, metric = await call_openai_decision(payload.query, payload.model, payload.temperature)
    except ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {
        "mode": "llm-only",
        "query": payload.query,
        "selected_tool": decision.tool,
        "decision": decision.model_dump(),
        "total_time_ms": metric["latency_ms"],
        "total_cost": metric["estimated_cost"],
        "total_input_tokens": metric["input_tokens"],
        "total_output_tokens": metric["output_tokens"],
        "model": metric.get("model"),
        "metrics": metric,
    }


class BrowserAgentRequest(BaseModel):
    query: str
    jev_model: Optional[str] = None
    openai_model: Optional[str] = None
    temperature: float = 0.0


@app.post("/api/agent/browser")
async def agent_browser(payload: BrowserAgentRequest) -> dict[str, Any]:
    """Tab 2 — Jev + LLM that actually opens a browser. Logs time and cost."""
    if not payload.query.strip():
        raise HTTPException(status_code=400, detail="Query must not be empty.")
    try:
        return await run_browser_agent(
            payload.query,
            jev_model=payload.jev_model,
            openai_model=payload.openai_model,
            temperature=payload.temperature,
        )
    except ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/agent/browser/stream")
async def agent_browser_stream(payload: BrowserAgentRequest) -> StreamingResponse:
    """Live workflow: stream each stage (path chosen, latency, tokens) as it happens."""
    if not payload.query.strip():
        raise HTTPException(status_code=400, detail="Query must not be empty.")

    async def event_source():
        try:
            async for event in stream_browser_agent(
                payload.query,
                jev_model=payload.jev_model,
                openai_model=payload.openai_model,
                temperature=payload.temperature,
            ):
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as exc:  # pragma: no cover
            yield f"data: {json.dumps({'type': 'error', 'error': str(exc)})}\n\n"

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.post("/api/agent/compare/stream")
async def agent_compare_stream(payload: BrowserAgentRequest) -> StreamingResponse:
    """Run Jev+LLM and LLM-only side by side, streaming both live, then compare."""
    if not payload.query.strip():
        raise HTTPException(status_code=400, detail="Query must not be empty.")

    async def event_source():
        try:
            async for event in stream_compare(
                payload.query,
                jev_model=payload.jev_model,
                openai_model=payload.openai_model,
                temperature=payload.temperature,
            ):
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as exc:  # pragma: no cover
            yield f"data: {json.dumps({'type': 'error', 'error': str(exc)})}\n\n"

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.post("/api/benchmark/run")
async def run_benchmark(payload: RunBenchmarkRequest) -> dict[str, Any]:
    query_pool = payload.queries or [item.query for item in BENCHMARK_QUERIES]
    results: list[dict[str, Any]] = []
    summary: dict[str, Any] = {
        "total_tests": len(query_pool),
        "runs": payload.runs,
        "run_id": str(uuid.uuid4()),
    }

    if not payload.run_jev and not payload.run_openai:
        raise HTTPException(status_code=400, detail="At least one provider must be enabled.")

    for run_index in range(payload.runs):
        for query in query_pool:
            expected = next((item.expected_tool for item in BENCHMARK_QUERIES if item.query == query), "no_tool")
            one_result: dict[str, Any] = {
                "run_id": summary["run_id"],
                "run_index": run_index + 1,
                "query": query,
                "expected_tool": expected,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            if payload.run_jev:
                try:
                    decision, metric = await call_jev_decision(query, payload.jev_model)
                    one_result["jev_tool"] = decision.tool
                    one_result["jev_latency_ms"] = metric["latency_ms"]
                    one_result["jev_input_tokens"] = metric["input_tokens"]
                    one_result["jev_output_tokens"] = metric["output_tokens"]
                    one_result["jev_estimated_cost"] = metric["estimated_cost"]
                    one_result["jev_correct"] = decision.tool == expected
                    one_result["jev_model"] = payload.jev_model
                except Exception as exc:  # pragma: no cover
                    one_result["jev_error"] = str(exc)
            if payload.run_openai:
                try:
                    decision, metric = await call_openai_decision(query, payload.openai_model, payload.temperature)
                    one_result["openai_tool"] = decision.tool
                    one_result["openai_latency_ms"] = metric["latency_ms"]
                    one_result["openai_input_tokens"] = metric["input_tokens"]
                    one_result["openai_output_tokens"] = metric["output_tokens"]
                    one_result["openai_estimated_cost"] = metric["estimated_cost"]
                    one_result["openai_correct"] = decision.tool == expected
                    one_result["openai_model"] = payload.openai_model
                except Exception as exc:  # pragma: no cover
                    one_result["openai_error"] = str(exc)
            results.append(one_result)

    summary["results_count"] = len(results)
    summary["providers"] = {
        "jev": payload.run_jev,
        "openai": payload.run_openai,
    }

    save_run(summary["run_id"], "benchmark_run", {
        "queries": query_pool,
        "runs": payload.runs,
        "openai_model": payload.openai_model,
        "jev_model": payload.jev_model,
        "temperature": payload.temperature,
    }, summary, results)
    return {"run_id": summary["run_id"], "summary": summary, "results": results}


@app.post("/api/benchmark/run-all")
async def run_all_benchmark() -> dict[str, Any]:
    req = RunBenchmarkRequest(
        queries=[item.query for item in BENCHMARK_QUERIES],
        runs=1,
        openai_model=OPENAI_MODEL,
        jev_model=JEV_MODEL,
        temperature=0.0,
        run_openai=True,
        run_jev=True,
    )
    return await run_benchmark(req)


@app.get("/api/benchmark/results")
async def get_results() -> dict[str, Any]:
    return {"runs": list_runs()}


@app.get("/api/benchmark/summary")
async def get_summary() -> dict[str, Any]:
    rows = list_runs()
    if not rows:
        return {"total_runs": 0, "summary": {}}

    all_results: list[dict] = []
    for row in rows:
        results = json.loads(row["results"] or "[]")
        all_results.extend(results)

    if not all_results:
        return {"total_runs": len(rows), "summary": {}}

    total = len(all_results)
    jev_correct = sum(1 for row in all_results if row.get("jev_correct") is True)
    openai_correct = sum(1 for row in all_results if row.get("openai_correct") is True)
    jev_latency = [float(row["jev_latency_ms"]) for row in all_results if "jev_latency_ms" in row and row["jev_latency_ms"] is not None]
    openai_latency = [float(row["openai_latency_ms"]) for row in all_results if "openai_latency_ms" in row and row["openai_latency_ms"] is not None]
    jev_cost = sum(float(row.get("jev_estimated_cost") or 0) for row in all_results)
    openai_cost = sum(float(row.get("openai_estimated_cost") or 0) for row in all_results)
    summary = {
        "total_tests": total,
        "jev_accuracy": (jev_correct / total) * 100 if total else 0.0,
        "openai_accuracy": (openai_correct / total) * 100 if total else 0.0,
        "average_jev_latency_ms": sum(jev_latency) / len(jev_latency) if jev_latency else 0.0,
        "average_openai_latency_ms": sum(openai_latency) / len(openai_latency) if openai_latency else 0.0,
        "total_jev_cost": jev_cost,
        "total_openai_cost": openai_cost,
        "estimated_cost_savings_percent": ((openai_cost - jev_cost) / openai_cost * 100) if openai_cost else 0.0,
    }
    return {"total_runs": len(rows), "summary": summary}


@app.get("/api/benchmark/cost-analysis")
async def cost_analysis() -> dict[str, Any]:
    return {"pricing": DEFAULT_PRICING}


@app.get("/api/benchmark/latency-analysis")
async def latency_analysis() -> dict[str, Any]:
    rows = list_runs()
    result = {"series": []}
    for row in rows:
        entries = json.loads(row["results"] or "[]")
        if not entries:
            continue
        result["series"].append({
            "run_id": row["id"],
            "run_name": row["run_name"],
            "jev_avg": sum(float(entry.get("jev_latency_ms") or 0) for entry in entries if entry.get("jev_latency_ms") is not None) / max(1, sum(1 for entry in entries if entry.get("jev_latency_ms") is not None)),
            "openai_avg": sum(float(entry.get("openai_latency_ms") or 0) for entry in entries if entry.get("openai_latency_ms") is not None) / max(1, sum(1 for entry in entries if entry.get("openai_latency_ms") is not None)),
        })
    return result


@app.get("/api/benchmark/default-queries")
async def default_queries() -> dict[str, Any]:
    return {"queries": [item.model_dump() for item in BENCHMARK_QUERIES]}


@app.get("/api/benchmark/cost-simulator")
async def cost_simulator() -> dict[str, Any]:
    return {
        "simulations": [
            {"requests_per_day": 100, "jev": 0.0, "openai": 0.0},
            {"requests_per_day": 1000, "jev": 0.0, "openai": 0.0},
            {"requests_per_day": 10000, "jev": 0.0, "openai": 0.0},
            {"requests_per_day": 100000, "jev": 0.0, "openai": 0.0},
        ]
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
