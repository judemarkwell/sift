"""The gateway: one pipeline every request goes through.

    pre-request skills   trim, redact, guard spend, request caching
    provider             the adapter streams the reply (through output transformers)
    post-response skills cost meter, cache report, reply check

Each skill records a PipelineStep, so the trace shows exactly what happened,
in order. A pre-request skill can block: the provider is never called and
nothing is charged.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator, Callable, Union

from app.providers import ProviderAdapter, ProviderError
from app.schema import (
    AIRequest,
    AIResponse,
    ContextBreakdown,
    ContextSegment,
    Cost,
    Finding,
    Message,
    ModelInfo,
    PipelineStep,
    Principal,
    Timing,
    Trace,
    Usage,
    new_id,
)
from app.skills.base import PipelineContext, Skill, StepResult
from app.skills.pii.redactor import Vault
from app.skills.registry import SKILLS, ResolvedSkill
from app.storage.base import Storage
from app.tokens import estimate_messages, estimate_tokens


class UnknownModelError(ValueError):
    pass


class BudgetExceededError(RuntimeError):
    pass


@dataclass
class Started:
    trace_id: str
    model: ModelInfo
    context: ContextBreakdown
    prompt_marks: list[Finding]
    pipeline: list[PipelineStep]


@dataclass
class Delta:
    text: str


@dataclass
class Finished:
    trace: Trace
    content: str  # what the user sees (placeholders restored)
    reply_marks: list[Finding]
    prompt_marks: list[Finding]


@dataclass
class Failed:
    message: str
    trace: Trace
    content: str
    prompt_marks: list[Finding]
    blocked: bool = False


GatewayEvent = Union[Started, Delta, Finished, Failed]
SettingsResolver = Callable[[Principal], dict[str, ResolvedSkill]]
Charger = Callable[[Trace, ModelInfo], float]


@dataclass
class _Clock:
    start: float = field(default_factory=time.perf_counter)

    def ms(self) -> int:
        return int((time.perf_counter() - self.start) * 1000)


class Gateway:
    def __init__(
        self,
        storage: Storage,
        adapters: list[ProviderAdapter],
        settings_for: SettingsResolver,
        charge: Charger | None = None,
        daily_budget_usd: float = 0.0,
        skills: list[Skill] = SKILLS,
    ):
        self.storage = storage
        self.settings_for = settings_for
        self.charge = charge
        self.daily_budget_usd = daily_budget_usd
        self.skills = skills
        self._routes: dict[str, tuple[ProviderAdapter, ModelInfo]] = {
            m.id: (a, m) for a in adapters for m in a.models()
        }

    # ---- models & platform budget ------------------------------------------------

    def models(self) -> list[ModelInfo]:
        return [m for _, m in self._routes.values()]

    def resolve(self, model_id: str) -> tuple[ProviderAdapter, ModelInfo]:
        if model_id not in self._routes:
            raise UnknownModelError(f"Unknown model: {model_id}")
        return self._routes[model_id]

    def spent_today(self) -> float:
        start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        live = {m.id for m in self.models() if m.live}
        return self.storage.spend_since(start, live)

    def check_budget(self, model: ModelInfo) -> None:
        """Platform-wide safety cap, separate from each user's plan."""
        if not model.live or self.daily_budget_usd <= 0:
            return
        spent = self.spent_today()
        if spent >= self.daily_budget_usd:
            tomorrow = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%b %d")
            raise BudgetExceededError(
                f"Sift's daily spending cap of ${self.daily_budget_usd:.2f} has been reached. Real models "
                f"are paused until {tomorrow} (UTC); mock models still work. To change the cap, set "
                "SIFT_DAILY_BUDGET_USD in backend/.env."
            )

    # ---- pipeline ----------------------------------------------------------------

    async def _run_stage(
        self,
        ctx: PipelineContext,
        settings: dict[str, ResolvedSkill],
        stage: str,
        steps: list[PipelineStep],
    ) -> None:
        for skill in self.skills:
            m = skill.manifest
            if stage not in m.stages:
                continue
            resolved = settings.get(m.id)
            if resolved is None or not resolved.enabled:
                continue
            config = skill.Config(**resolved.config)
            t = time.perf_counter()
            try:
                hook = skill.before if stage == "pre-request" else skill.after
                result = await hook(ctx, config)
            except Exception as exc:  # a broken skill must not take chat down
                result = StepResult("error", f"Skill failed: {type(exc).__name__}")
            if result is None:
                continue
            steps.append(
                PipelineStep(
                    name=m.name,
                    stage=stage,  # type: ignore[arg-type]
                    duration_ms=int((time.perf_counter() - t) * 1000),
                    detail=result.detail,
                    skill_id=m.id,
                    status=result.status,
                    findings=result.findings,
                )
            )
            if ctx.blocked_reason:
                return

    @staticmethod
    def _context(ctx: PipelineContext) -> ContextBreakdown:
        convo = [m for m in ctx.messages if m.role != "system"]
        history, prompt = convo[:-1], convo[-1:]
        segments = [
            ContextSegment(label="System instructions", tokens=estimate_tokens(ctx.system_prompt or "")),
            ContextSegment(label="Conversation history", tokens=estimate_messages(history)),
            ContextSegment(label="Your prompt", tokens=estimate_messages(prompt)),
        ]
        return ContextBreakdown(
            segments=segments, total_tokens=sum(s.tokens for s in segments), window=ctx.model.context_window
        )

    async def run(
        self,
        principal: Principal,
        conversation_id: str,
        model_id: str,
        messages: list[Message],
        *,
        ephemeral: bool = False,
        max_output_tokens: int = 1024,
    ) -> AsyncIterator[GatewayEvent]:
        adapter, model = self.resolve(model_id)
        clock = _Clock()
        settings = self.settings_for(principal)
        vault = (
            Vault()
            if ephemeral
            else Vault.from_dict(self.storage.get_vault(principal.org_id, conversation_id))
        )
        request = AIRequest(
            org_id=principal.org_id,
            user_id=principal.user_id,
            conversation_id=conversation_id,
            model=model.id,
            messages=messages,
            max_output_tokens=max_output_tokens,
        )
        ctx = PipelineContext(
            principal=principal, request=request, model=model, messages=list(messages), vault=vault
        )
        steps: list[PipelineStep] = []
        trace_id = new_id("trace")

        await self._run_stage(ctx, settings, "pre-request", steps)
        if not ephemeral and vault.by_placeholder:
            self.storage.put_vault(principal.org_id, conversation_id, vault.to_dict())
        context = self._context(ctx)
        sent = list(ctx.messages)
        if ctx.system_prompt:
            sent = [Message(role="system", content=ctx.system_prompt)] + [m for m in sent if m.role != "system"]

        if ctx.blocked_reason:
            trace = self._trace(trace_id, principal, conversation_id, model, adapter, sent, context, steps,
                                content="", usage=Usage(), finish="blocked", ttft=0, clock=clock,
                                ephemeral=ephemeral)
            self.storage.put_trace(trace)
            yield Failed(ctx.blocked_reason, trace, "", ctx.prompt_marks, blocked=True)
            return

        yield Started(trace_id, model, context, ctx.prompt_marks, list(steps))

        # provider
        raw: list[str] = []
        shown: list[str] = []
        reported: Usage | None = None
        ttft = 0
        provider_start = time.perf_counter()

        def through(text: str) -> str:
            for t in ctx.transformers:
                text = t.feed(text)
            return text

        try:
            async for item in adapter.stream(request, sent, ctx.provider_options):
                if isinstance(item, Usage):
                    reported = item
                    continue
                if not raw:
                    ttft = clock.ms()
                raw.append(item)
                out = through(item)
                if out:
                    shown.append(out)
                    yield Delta(out)
        except ProviderError as exc:
            ctx.error = str(exc)
        except Exception as exc:  # never leak a stack trace to the user
            ctx.error = f"Unexpected error from {adapter.provider}: {type(exc).__name__}"
        # flush anything the transformers were holding back
        tail = ""
        for i, t in enumerate(ctx.transformers):
            flushed = t.flush()
            for later in ctx.transformers[i + 1 :]:
                flushed = later.feed(flushed)
            tail += flushed
        if tail:
            shown.append(tail)
            yield Delta(tail)

        steps.append(
            PipelineStep(
                name=f"{model.name} via {adapter.provider}",
                stage="provider",
                duration_ms=int((time.perf_counter() - provider_start) * 1000),
                detail=ctx.error or f"Streamed {len(raw)} chunks",
                status="error" if ctx.error else "ok",
            )
        )

        ctx.raw_output = "".join(raw)
        if ctx.error and reported is None and model.live:
            # Failed before usage was reported: rejected requests aren't billed.
            ctx.usage = Usage(estimated=True)
        else:
            ctx.usage = reported or Usage(
                input_tokens=context.total_tokens,
                output_tokens=estimate_tokens(ctx.raw_output),
                estimated=True,
            )
        await self._run_stage(ctx, settings, "post-response", steps)

        content = "".join(shown)
        trace = self._trace(trace_id, principal, conversation_id, model, adapter, sent, context, steps,
                            content=ctx.raw_output, usage=ctx.usage, finish="error" if ctx.error else "stop",
                            ttft=ttft, clock=clock, ephemeral=ephemeral)
        if ctx.cost is not None:
            trace.response.cost = ctx.cost
        if self.charge:
            trace.charged_usd = self.charge(trace, model)
        self.storage.put_trace(trace)

        reply_marks: list[Finding] = []
        for t in ctx.transformers:
            for ph, start, end in getattr(t, "restored", []):
                kind = ph.strip("[]").rsplit("_", 1)[0]
                reply_marks.append(
                    Finding(kind=kind, label="Restored from placeholder", action="redact",
                            placeholder=ph, start=start, end=end)
                )
        if ctx.error:
            yield Failed(ctx.error, trace, content, ctx.prompt_marks)
        else:
            yield Finished(trace, content, reply_marks, ctx.prompt_marks)

    def _trace(
        self, trace_id: str, principal: Principal, conversation_id: str, model: ModelInfo,
        adapter: ProviderAdapter, sent: list[Message], context: ContextBreakdown,
        steps: list[PipelineStep], *, content: str, usage: Usage, finish: Any, ttft: int,
        clock: _Clock, ephemeral: bool,
    ) -> Trace:
        return Trace(
            id=trace_id,
            org_id=principal.org_id,
            user_id=principal.user_id,
            conversation_id=conversation_id,
            model=model.id,
            sent_messages=sent,
            response=AIResponse(
                model=model.id,
                provider=adapter.provider,
                content=content,
                finish_reason=finish,
                usage=usage,
                cost=Cost(),
                timing=Timing(time_to_first_token_ms=ttft, total_ms=clock.ms()),
            ),
            context=context,
            pipeline=steps,
            ephemeral=ephemeral,
        )
