# Jev Decision Benchmark

A local benchmark app for comparing a Jev-based routing layer against a traditional OpenAI model on the task of selecting the right tool for a user query.

## Features

- React + TypeScript frontend with dashboard and charts
- FastAPI backend with SQLite persistence
- Shared fixed tool registry and benchmark dataset
- Runs decision calls against OpenAI and Jev/OpenRouter
- Stores benchmark runs locally for later inspection
- Includes a basic cost simulator and architecture comparison section

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

## Configuration

Create a `.env` file in the project root with values similar to:

```bash
OPENAI_API_KEY=your-openai-key
OPENROUTER_API_KEY=your-openrouter-key
OPENAI_MODEL=gpt-4o-mini
JEV_MODEL=typesafe/jev-1.13
```

Do not commit `.env`.

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

## Cost simulator

The dashboard includes a simple simulator that estimates cost based on request volume, average input tokens, and average output tokens.

It also includes a scenario where Jev routes requests and only a percentage of them require a main OpenAI call, clearly marked as a simulation rather than measured data.

## Limitations of the benchmark

- This is a tool-selection benchmark, not end-to-end tool execution.
- The model is only choosing among mock tools; real tool execution is not performed in v1.
- API responses can vary over time, so single-run comparisons are not strong evidence.
- The benchmark intentionally keeps the tool set fixed and simple to reduce confounding factors.
- Cost estimates are approximate based on configured pricing tables when the provider does not return direct pricing metadata.

## API endpoints

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
