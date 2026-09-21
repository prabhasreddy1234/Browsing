import os
from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[2]
load_dotenv(ROOT_DIR / ".env")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
JEV_MODEL = os.getenv("JEV_MODEL", "typesafe/jev-1.13")
DATABASE_PATH = ROOT_DIR / "data" / "benchmark.db"

# ── Jev (TypeSafe System One) ────────────────────────────────────────────────
# Jev is a "System One" decision model: it returns typed, probabilistic choices
# (not generated text) in ~70-200 ms. "Jev makes the decision. An LLM writes the
# words. Your code owns the control flow."  https://typesafe.ai
# Pricing: $0.042 per 1M input tokens, output free.
TYPESAFE_API_KEY = os.getenv("TYPESAFE_API_KEY", "")
JEV_IN_PER_M = float(os.getenv("JEV_IN_PER_M", "0.042"))
# Hard cap on real LLM spend for a demo session (Jev is ~free and never blocked).
DEMO_BUDGET_USD = float(os.getenv("DEMO_BUDGET_USD", "0.5"))


def has_jev_key() -> bool:
    """True when a real TypeSafe key is set; otherwise Jev runs in simulation."""
    return bool(TYPESAFE_API_KEY.strip())


def jev_cost_usd(input_tokens: int) -> float:
    """Jev cost: input tokens only, output is free."""
    return (input_tokens * JEV_IN_PER_M) / 1_000_000
