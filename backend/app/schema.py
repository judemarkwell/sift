"""Sift's provider-agnostic schema.

Every provider adapter translates to and from these types. Nothing outside
`app/providers/` should ever see a provider-specific object.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field, computed_field


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


Role = Literal["system", "user", "assistant"]


class Message(BaseModel):
    role: Role
    content: str


class ModelInfo(BaseModel):
    id: str
    name: str
    provider: str
    context_window: int
    input_price_per_mtok: float = Field(description="USD per 1M input tokens")
    output_price_per_mtok: float = Field(description="USD per 1M output tokens")
    cache_write_price_per_mtok: float | None = None
    cache_read_price_per_mtok: float | None = None
    description: str = ""
    live: bool = Field(default=False, description="True for real providers that cost money")


class AIRequest(BaseModel):
    """What the client asks for. Org and user are passed everywhere so
    multi-tenancy is already wired when real auth arrives."""

    org_id: str = "org_local"
    user_id: str = "user_local"
    conversation_id: str = Field(default_factory=lambda: new_id("conv"))
    model: str
    messages: list[Message]
    system: str | None = None
    max_output_tokens: int = 1024


class Usage(BaseModel):
    input_tokens: int = 0  # uncached input tokens
    output_tokens: int = 0
    cache_write_tokens: int = 0
    cache_read_tokens: int = 0
    estimated: bool = True  # true until a real provider reports usage

    @computed_field  # type: ignore[prop-decorator]
    @property
    def total_input_tokens(self) -> int:
        return self.input_tokens + self.cache_write_tokens + self.cache_read_tokens


class Cost(BaseModel):
    input_usd: float = 0.0
    output_usd: float = 0.0
    cache_usd: float = 0.0
    total_usd: float = 0.0


class Timing(BaseModel):
    time_to_first_token_ms: int = 0
    total_ms: int = 0


class ContextSegment(BaseModel):
    label: str
    tokens: int


class ContextBreakdown(BaseModel):
    segments: list[ContextSegment]
    total_tokens: int
    window: int

    @computed_field  # type: ignore[prop-decorator]
    @property
    def percent(self) -> float:
        return round(100 * self.total_tokens / self.window, 2) if self.window else 0.0


class PipelineStep(BaseModel):
    """One stage in the gateway pipeline. Plugins (PII, cost, ...) will each
    add a step here, so the trace shows exactly what happened and in what order."""

    name: str
    stage: Literal["pre-request", "provider", "post-response"]
    duration_ms: int
    detail: str = ""


class AIResponse(BaseModel):
    id: str = Field(default_factory=lambda: new_id("msg"))
    model: str
    provider: str
    content: str
    finish_reason: Literal["stop", "length", "error"] = "stop"
    usage: Usage
    cost: Cost
    timing: Timing


class Trace(BaseModel):
    """The full record of one request. This is the data foundation that the
    info strip, trace panel, cost views and (later) explainability read from."""

    id: str = Field(default_factory=lambda: new_id("trace"))
    created_at: datetime = Field(default_factory=utcnow)
    org_id: str
    user_id: str
    conversation_id: str
    request: AIRequest
    sent_messages: list[Message] = Field(
        description="Exactly what was sent to the provider, after pre-request plugins"
    )
    response: AIResponse
    context: ContextBreakdown
    pipeline: list[PipelineStep]
