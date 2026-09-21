from __future__ import annotations

from typing import Any, Optional

# Prices are USD per 1,000,000 tokens (estimate_cost divides by 1e6). Keep every
# entry in these units so costs are comparable across providers and against Jev's
# $0.042/1M (see JEV_IN_PER_M in config.py).
DEFAULT_PRICING = {
    "openai": {
        "gpt-4o-mini": {"input": 0.15, "output": 0.60},
        "gpt-4o": {"input": 2.50, "output": 10.00},
        "gpt-4.1-mini": {"input": 0.40, "output": 1.60},
        "mock": {"input": 0.15, "output": 0.60},
    },
    "jev": {
        "typesafe/jev-1.13": {"input": 0.042, "output": 0.0},
        "openrouter/auto": {"input": 0.10, "output": 0.30},
        "mock": {"input": 0.042, "output": 0.0},
    },
}


def get_pricing_table() -> dict[str, dict[str, dict[str, float]]]:
    return DEFAULT_PRICING


def estimate_cost(input_tokens: int, output_tokens: int, model_name: str, provider: str, table: Optional[dict[str, Any]] = None) -> float:
    pricing = (table or DEFAULT_PRICING).get(provider, {})
    model_prices = pricing.get(model_name)
    if not model_prices:
        return 0.0
    input_price = float(model_prices.get("input", 0.0))
    output_price = float(model_prices.get("output", 0.0))
    input_cost = (input_tokens / 1_000_000) * input_price
    output_cost = (output_tokens / 1_000_000) * output_price
    return input_cost + output_cost


def safe_percentage_change(before: float, after: float) -> float:
    if before == 0:
        return 0.0
    return ((after - before) / before) * 100
