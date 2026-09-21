from __future__ import annotations

from typing import Any, Optional

DEFAULT_PRICING = {
    "openai": {
        "gpt-4o-mini": {"input": 0.00015, "output": 0.0006},
        "gpt-4o": {"input": 0.005, "output": 0.015},
        "gpt-4.1-mini": {"input": 0.0004, "output": 0.0016},
    },
    "jev": {
        "typesafe/jev-1.13": {"input": 0.00005, "output": 0.0002},
        "openrouter/auto": {"input": 0.0001, "output": 0.0003},
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
