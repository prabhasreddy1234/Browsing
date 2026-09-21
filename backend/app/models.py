from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class ToolDefinition(BaseModel):
    name: str
    description: str
    input_schema: dict[str, Any] = Field(default_factory=dict)


class DecisionResponse(BaseModel):
    tool: str
    confidence: float = 0.0
    reason: str = ""


class BenchmarkQuery(BaseModel):
    query: str
    expected_tool: str
    category: Optional[str] = None


class ProviderMetric(BaseModel):
    provider: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    latency_ms: float = 0.0
    estimated_cost: float = 0.0
    selected_tool: str
    confidence: float = 0.0
    reason: str = ""
    correctness: bool = False


class BenchmarkRunRecord(BaseModel):
    id: str
    query: str
    expected_tool: str
    jev_tool: Optional[str] = None
    openai_tool: Optional[str] = None
    jev_latency_ms: Optional[float] = None
    openai_latency_ms: Optional[float] = None
    jev_input_tokens: Optional[int] = None
    openai_input_tokens: Optional[int] = None
    jev_output_tokens: Optional[int] = None
    openai_output_tokens: Optional[int] = None
    jev_estimated_cost: Optional[float] = None
    openai_estimated_cost: Optional[float] = None
    jev_correct: Optional[bool] = None
    openai_correct: Optional[bool] = None
    timestamp: str
    jev_model: Optional[str] = None
    openai_model: Optional[str] = None
