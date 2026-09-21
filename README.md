# Jev Decision Benchmark

A local app for comparing a **Jev**-based decision layer against a traditional LLM on the task of selecting the right tool for a user query — and driving a real browser from Jev's decision.

## What Jev is

**Jev is TypeSafe's "System One" decision model.** It returns *typed, probabilistic decisions* (a choice with a confidence and per-option probabilities) in ~70–200 ms — it does **not** generate text. Pricing is **$0.042 per 1M input tokens, output free**.

The design pattern:

> **Jev makes the decision. An LLM writes the words. Your code owns the control flow.**

When no `TYPESAFE_API_KEY` is set, the Jev layer runs in clearly-badged **simulation mode** (an offline heuristic with realistic System One latency). The same applies to the LLM when no `OPENAI_API_KEY` is set.

## Features

- React + TypeScript frontend with dashboard, charts, and two interactive agent tabs
- FastAPI backend with SQLite persistence
- Faithful Jev System One decision layer (typed choice, confidence, probabilities, input-only cost)
- A real headless-Chromium browser agent driven by Jev's decision
- Stores benchmark runs locally for later inspection
- Includes a cost simulator and architecture comparison section

## Project structure

- /frontend
- /backend
- /data
- README.md
- .env.example

## Setup

1. Copy `.env.example` to `.env` and fill in your local API keys.
2. Install frontend dependencies:

   ```bash
   cd frontend
   npm install
   ```

3. Install backend dependencies:

   ```bash
   cd backend
   pip install -r requirements.txt
   ```

4. Install the Chromium browser used by the browser agent tab:

   ```bash
   playwright install chromium
   ```

   If this step is skipped, the browser tab still works but falls back to a plain
   HTTP fetch (marked as a fallback in the response) instead of a real browser.

## Configuration

Create a `.env` file in the project root with values similar to:

```bash
# Jev (TypeSafe System One) — typed decisions, $0.042/1M input, output free
TYPESAFE_API_KEY=your-typesafe-key
# LLM that "writes the words"
OPENAI_API_KEY=your-openai-key
OPENAI_MODEL=gpt-4o-mini
# optional overrides
JEV_IN_PER_M=0.042
DEMO_BUDGET_USD=0.5
```

Everything runs without keys: Jev falls back to a simulated System One heuristic and the LLM to a simulated summary, each badged in the UI. Do not commit `.env`.

## Run locally

Frontend:

```bash
cd frontend
npm run dev
```

Backend:

```bash
cd backend
uvicorn main:app --reload
```

The frontend expects the API at `http://localhost:8000`.

## Run the benchmark

Use the UI dashboard to run a benchmark, or call the backend endpoints directly.

Example:

```bash
curl -X POST http://localhost:8000/api/benchmark/run-all
```

## How latency is calculated

The backend measures wall-clock time around each API request in milliseconds and stores the value in the benchmark result row.

```python
start = time.perf_counter()
response = ...
latency_ms = (time.perf_counter() - start) * 1000
```

## How token usage is calculated

Token counts come from the provider response `usage` payload when available. The backend stores both prompt/input and completion/output tokens and uses them for cost estimation.

## How cost is calculated

The backend computes total cost as:

```python
input_cost = input_tokens / 1_000_000 * input_price
output_cost = output_tokens / 1_000_000 * output_price
total_cost = input_cost + output_cost
```

A configurable default pricing table is defined in `backend/app/services/pricing.py` and can be adjusted without changing the frontend.

**Jev is priced differently:** because System One returns a typed decision rather than generated text, it is billed on **input tokens only** at `JEV_IN_PER_M` ($0.042 per 1M by default), with output free. See `jev_cost_usd` in `backend/app/config.py` and the Jev layer in `backend/app/services/jev_system_one.py`.

## Cost simulator

The dashboard includes a simple simulator that estimates cost based on request volume, average input tokens, and average output tokens.

It also includes a scenario where Jev routes requests and only a percentage of them require a main OpenAI call, clearly marked as a simulation rather than measured data.

## Limitations of the benchmark

- This is a tool-selection benchmark, not end-to-end tool execution.
- The model is only choosing among mock tools; real tool execution is not performed in v1.
- API responses can vary over time, so single-run comparisons are not strong evidence.
- The benchmark intentionally keeps the tool set fixed and simple to reduce confounding factors.
- Cost estimates are approximate based on configured pricing tables when the provider does not return direct pricing metadata.

## Tabs

The frontend has three working tabs (switch via the sidebar):

- **Dashboard** — the full benchmark dashboard (Jev vs LLM across the dataset).
- **LLM Only** — enter a query; the LLM alone picks a tool (the traditional baseline, no Jev, no browser). Logs time and cost.
- **Jev + LLM (Browser)** — enter a query (or a URL). **Jev decides** the tool (a typed System One choice with confidence + probabilities), **your code opens** a real headless Chromium browser, and **the LLM writes** an answer grounded in the page. A **live workflow** streams each stage as it happens: which path was chosen, a running elapsed timer, per-step latency, tokens consumed, and cost — with cumulative totals. When it finishes it also shows the Jev decision (with a live/simulated badge), the probability bars, the LLM answer, a per-step breakdown, and the captured page.
- **Compare (Jev vs LLM)** — enter a task; **both** pipelines run concurrently and stream side by side in real time: *Jev + LLM* (Jev decides the tool) vs *LLM only* (the LLM decides the tool). The web-search and answer stages are identical in both, so every difference in the stats is attributable to the decision layer. When both finish you get a **benchmark comparison**: agreement on the tool, decision latency / cost / tokens, total time / cost / tokens, percentage advantages, bar charts, and both answers.

## API endpoints

- `GET  /api/status` — whether Jev and the LLM are live or simulated, Jev's price, and the demo budget.
- `POST /api/agent/llm-only` — LLM-only tool decision with time and cost.
- `POST /api/agent/browser` — Jev decides → browser opens → LLM answers; returns the Jev decision, steps, total time, and total cost.
- `POST /api/agent/browser/stream` — the same flow as a live Server-Sent Events stream (`step_start` / `step_end` / `done`), each event carrying per-step latency, tokens, cost, and cumulative totals.
- `POST /api/agent/compare/stream` — runs Jev+LLM and LLM-only concurrently; streams both pipelines' events (each tagged with `approach`), then a final `comparison` event with side-by-side benchmark stats.
- `POST /api/decision/jev`
- `POST /api/decision/openai`
- `POST /api/benchmark/run`
- `POST /api/benchmark/run-all`
- `GET /api/benchmark/results`
- `GET /api/benchmark/summary`
- `GET /api/benchmark/cost-analysis`
- `GET /api/benchmark/latency-analysis`

## Notes

This project is designed to run locally on a development machine without Docker or cloud deployment.

The Jev System One pattern — typed decisions, input-only pricing, simulation-without-keys, and the "Jev decides / LLM writes / code owns control flow" separation — is implemented on this Python/FastAPI + React stack.
