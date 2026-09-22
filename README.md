# Jev Decision Benchmark

A local app for comparing a **Jev**-based decision layer against a traditional LLM on the task of selecting the right tool for a user query — and driving a real browser from Jev's decision.

## What Jev is

**Jev is TypeSafe's "System One" decision model.** It returns *typed, probabilistic decisions* (a choice with a confidence and per-option probabilities) in ~70–200 ms — it does **not** generate text. Pricing is **$0.042 per 1M input tokens, output free**.

The design pattern:

> **Jev makes the decision. An LLM writes the words. Your code owns the control flow.**

When no `TYPESAFE_API_KEY` is set, the Jev layer runs in clearly-badged **simulation mode** (an offline heuristic with realistic System One latency). The same applies to the LLM when no `OPENAI_API_KEY` is set.

## Features

- React + TypeScript frontend with a dashboard, charts, and three live agent tabs
- FastAPI backend with SQLite persistence and Server-Sent Events streaming
- Faithful Jev System One decision layer (typed choice, confidence, probabilities, input-only cost)
- A **real, visible** Chromium browser agent driven by the decision layer — it can open a
  site and search *on it* (e.g. "search for NBA in wikipedia.org")
- Live per-step workflow (which path, latency, tokens, cost) streamed as it happens
- A **side-by-side benchmark** of Jev+LLM vs LLM-only running concurrently
- A live cost simulator and an architecture comparison section
- Typo-correction for common site names and graceful fallback when a browser can't open

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
# open the browser visibly on the LLM-Only and Jev+LLM tabs (set 0 to run headless)
BROWSER_HEADED=1
```

Everything runs without keys: Jev falls back to a simulated System One heuristic and the LLM to a simulated summary, each badged in the UI. **Put real keys only in `.env` (git-ignored), never in `.env.example`.**

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

## How accuracy is calculated

Accuracy is graded only against the built-in labelled dataset (each query has an
`expected_tool`). Run **"Run entire benchmark"** for accuracy numbers. Custom queries you
add have no ground truth, so they run but are excluded from accuracy (shown as `—`) rather
than scored against a wrong default. Accuracy therefore = correct / graded, not correct / total.

## Cost simulator

The dashboard includes a **live** simulator. Edit requests/month, average input tokens,
average output tokens, and the percentage of requests that need the main LLM; it computes
the LLM-only vs Jev-routed monthly cost and the saving in real time, using the actual pricing
table and Jev's input-only price. Jev routes every request cheaply and only the chosen
percentage reach the full LLM.

## Limitations of the benchmark

- This is a tool-selection benchmark, not end-to-end tool execution.
- The model is only choosing among mock tools; real tool execution is not performed in v1.
- API responses can vary over time, so single-run comparisons are not strong evidence.
- The benchmark intentionally keeps the tool set fixed and simple to reduce confounding factors.
- Cost estimates are approximate based on configured pricing tables when the provider does not return direct pricing metadata.

## Tabs

The frontend has four tabs (switch via the sidebar):

- **Dashboard** — the full benchmark dashboard (Jev vs LLM across the labelled dataset): KPIs, latency / cost / accuracy charts, a request-level table, the architecture comparison, and the live cost simulator.
- **LLM Only** — enter a task; the **LLM decides** the tool, a **visible browser window opens** and searches for your input, and the LLM **writes a text answer** grounded in the page. Live workflow with per-step latency, tokens and cost.
- **Jev + LLM (Browser)** — enter a task (or a URL). **Jev decides** the tool (a typed System One choice with confidence + probabilities), **your code opens a visible browser**, and **the LLM writes** an answer grounded in the page. A **live workflow** streams each stage as it happens (chosen path, running timer, per-step latency, tokens, cost, cumulative totals), then shows the Jev decision (live/simulated badge), probability bars, the answer, a per-step breakdown, and the captured page.
- **Compare (Jev vs LLM)** — enter a task; **both** pipelines run concurrently and stream side by side: *Jev + LLM* vs *LLM only*. The browser and answer stages are identical, so every difference is attributable to the decision layer. When both finish you get a **benchmark comparison**: tool agreement, decision latency / cost / tokens, total time / cost / tokens, percentage advantages, bar charts, and both answers. (Compare runs headless so it doesn't open two windows.)

## Prompt examples

The agent tabs understand a few prompt shapes:

| Prompt | What happens |
|---|---|
| `open www.wikipedia.org and search for NBA` | opens Wikipedia and searches *on the site* → the NBA article |
| `search for quantum computing in wikipedia.org` | same, on-site search |
| `Retrieve the page https://example.com/docs` | opens that exact URL |
| `What is the latest news about Android 16?` | a general web search (Bing) |

Notes: common site typos are auto-corrected (`wikipidea.org` → `wikipedia.org`). **Google is not
usable for automated search** — it returns a CAPTCHA ("unusual traffic") by design; use Wikipedia
or a plain web-search prompt for demos.

## API endpoints

Agent (live, Server-Sent Events):

- `GET  /api/status` — whether Jev and the LLM are live or simulated, Jev's price, and the demo budget.
- `POST /api/agent/llm/stream` — LLM-only live workflow (LLM decides → **visible** browser → LLM answer).
- `POST /api/agent/browser/stream` — Jev + LLM live workflow, opening a **visible** browser; events carry per-step latency, tokens, cost, and cumulative totals.
- `POST /api/agent/compare/stream` — runs Jev+LLM and LLM-only concurrently; streams both (each event tagged with `approach`), then a final `comparison` event with side-by-side stats.
- `POST /api/agent/llm-only` — LLM-only tool decision with time and cost (non-streaming, no browser).
- `POST /api/agent/browser` — non-streaming Jev + LLM browser run (returns the final result only).

> The **LLM Only** and **Jev + LLM (Browser)** tabs open the browser in *headed* (visible) mode so you can watch the automation. **Compare** runs headless. Headed needs a desktop session; if the browser can't open, the agent falls back to an HTTP fetch (badged in the UI). Toggle with `BROWSER_HEADED` in `.env`.

Benchmark & data:

- `POST /api/benchmark/run` · `POST /api/benchmark/run-all` — run a benchmark and store it.
- `GET  /api/benchmark/results` — list stored runs.
- `DELETE /api/benchmark/results` — wipe all stored runs (what the dashboard's "Clear history" calls).
- `GET  /api/benchmark/summary` — aggregate accuracy / latency / cost across stored runs.
- `GET  /api/benchmark/cost-analysis` — the pricing table.
- `GET  /api/benchmark/latency-analysis` — per-run latency series.
- `POST /api/decision/jev` · `POST /api/decision/openai` — a single tool decision.

## Notes

This project is designed to run locally on a development machine without Docker or cloud deployment.

The Jev System One pattern — typed decisions, input-only pricing, simulation-without-keys, and the "Jev decides / LLM writes / code owns control flow" separation — is implemented on this Python/FastAPI + React stack.
