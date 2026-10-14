"""The skill contract.

A skill is a small, self-describing unit that plugs into the gateway
pipeline. Its manifest says where it runs, whether it may change the request,
and what can be configured; the settings UI is generated from that manifest,
so adding a skill never needs new settings screens.

    pre-request    before(ctx)  may inspect/modify ctx.messages, add system
                                notes, attach an output transformer, or block
    post-response  after(ctx)   reads the reply, usage and cost
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, ClassVar, Literal, Protocol

from pydantic import BaseModel

from app.schema import (
    AIRequest,
    Cost,
    Finding,
    Message,
    ModelInfo,
    Principal,
    Stage,
    StepStatus,
    Usage,
)


class SkillManifest(BaseModel):
    id: str
    name: str
    summary: str  # one line, shown in the list
    description: str  # what it does, in plain terms
    category: Literal["Privacy", "Cost", "Context", "Quality"]
    stages: list[Stage]
    can_modify_request: bool
    core: bool = False  # always on; can't be disabled
    default_enabled: bool = True
    lockable: bool = True  # a workspace admin can enforce it
    config_schema: dict[str, Any] = {}


class OutputTransformer(Protocol):
    """Rewrites the streamed reply on its way to the user."""

    def feed(self, chunk: str) -> str: ...

    def flush(self) -> str: ...


@dataclass
class StepResult:
    status: StepStatus = "ok"
    detail: str = ""
    findings: list[Finding] = field(default_factory=list)


@dataclass
class PipelineContext:
    principal: Principal
    request: AIRequest
    model: ModelInfo
    messages: list[Message]  # what will be sent; pre-request skills edit this
    vault: Any  # PII vault for this conversation (app.skills.pii.redactor.Vault)
    system_notes: list[str] = field(default_factory=list)
    provider_options: dict[str, Any] = field(default_factory=dict)
    transformers: list[OutputTransformer] = field(default_factory=list)
    # Findings that point at spans of the user's latest message, for highlighting.
    prompt_marks: list[Finding] = field(default_factory=list)
    blocked_reason: str | None = None
    # Filled in after the provider responds.
    raw_output: str = ""
    usage: Usage | None = None
    cost: Cost | None = None
    error: str | None = None

    def block(self, reason: str) -> None:
        self.blocked_reason = reason

    @property
    def system_prompt(self) -> str | None:
        parts = [m.content for m in self.messages if m.role == "system"] + self.system_notes
        return "\n\n".join(parts) if parts else None


class Skill(Protocol):
    manifest: ClassVar[SkillManifest]
    Config: ClassVar[type[BaseModel]]

    async def before(self, ctx: PipelineContext, config: BaseModel) -> StepResult | None: ...

    async def after(self, ctx: PipelineContext, config: BaseModel) -> StepResult | None: ...


class BaseSkill:
    """Default no-op hooks so a skill only implements the stage it uses."""

    class Config(BaseModel):
        pass

    async def before(self, ctx: PipelineContext, config: BaseModel) -> StepResult | None:
        return None

    async def after(self, ctx: PipelineContext, config: BaseModel) -> StepResult | None:
        return None
