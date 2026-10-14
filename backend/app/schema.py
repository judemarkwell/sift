"""Sift's provider-agnostic schema.

Every provider adapter translates to and from these types. Nothing outside
`app/providers/` should ever see a provider-specific object.

Privacy rule: a Trace is a log, so it must never contain text that a
pre-request skill removed. Traces store `sent_messages` (what actually left
Sift, after redaction), never the raw request.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
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
    """What the gateway runs. Built server-side from the stored conversation,
    so history can't be tampered with by the client."""

    org_id: str
    user_id: str
    conversation_id: str
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
    # What the same tokens would have cost with no prompt caching.
    uncached_usd: float = 0.0


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


# ---- skills ---------------------------------------------------------------

Stage = Literal["pre-request", "provider", "post-response"]
StepStatus = Literal["ok", "changed", "warn", "blocked", "error"]
PiiAction = Literal["block", "redact", "warn", "allow"]


class Finding(BaseModel):
    """Something a skill noticed. For PII, never carries the raw value:
    `preview` is masked (j•••@acme.com)."""

    kind: str  # e.g. EMAIL, CREDIT_CARD, TRIMMED_TURN, OVER_BUDGET
    label: str  # human name, e.g. "Email address"
    action: PiiAction | Literal["info"] = "info"
    placeholder: str | None = None
    preview: str | None = None
    message_index: int | None = None
    start: int | None = None
    end: int | None = None
    detector: str | None = None


class PipelineStep(BaseModel):
    """One stage in the gateway pipeline. Every skill adds a step, so the
    trace shows exactly what happened and in what order."""

    name: str
    stage: Stage
    duration_ms: int
    detail: str = ""
    skill_id: str | None = None
    status: StepStatus = "ok"
    findings: list[Finding] = Field(default_factory=list)


class AIResponse(BaseModel):
    id: str = Field(default_factory=lambda: new_id("msg"))
    model: str
    provider: str
    content: str
    finish_reason: Literal["stop", "length", "error", "blocked"] = "stop"
    usage: Usage
    cost: Cost
    timing: Timing


class Trace(BaseModel):
    """The full record of one request: the data foundation for the info line,
    trace panel, usage dashboard and billing."""

    id: str = Field(default_factory=lambda: new_id("trace"))
    created_at: datetime = Field(default_factory=utcnow)
    org_id: str
    user_id: str
    conversation_id: str
    model: str
    sent_messages: list[Message] = Field(
        description="Exactly what was sent to the provider, after pre-request skills"
    )
    response: AIResponse
    context: ContextBreakdown
    pipeline: list[PipelineStep]
    charged_usd: float = 0.0  # what was deducted from the user's credit
    ephemeral: bool = False  # compare-mode runs aren't part of a conversation


# ---- conversations ----------------------------------------------------------


class StoredMessage(BaseModel):
    id: str = Field(default_factory=lambda: new_id("msg"))
    role: Literal["user", "assistant"]
    content: str
    created_at: datetime = Field(default_factory=utcnow)
    model_id: str | None = None
    status: Literal["done", "error", "blocked"] = "done"
    error: str | None = None
    trace_id: str | None = None
    # Spans in `content` that a skill acted on, for highlighting in the UI.
    marks: list[Finding] = Field(default_factory=list)


class Conversation(BaseModel):
    id: str = Field(default_factory=lambda: new_id("conv"))
    org_id: str
    user_id: str
    title: str = "New chat"
    model_id: str
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    messages: list[StoredMessage] = Field(default_factory=list)


class ConversationSummary(BaseModel):
    id: str
    title: str
    model_id: str
    updated_at: datetime
    message_count: int
    spend_usd: float


class Principal(BaseModel):
    """Who is calling. Comes from Cognito later; a fixed local user for now."""

    org_id: str
    user_id: str
    email: str
    role: Literal["admin", "member"] = "admin"


JSON = dict[str, Any]
