"""The gateway: one pipeline every request goes through.

    pre-request   -> budget check, context assembly (later: PII redaction)
    provider      -> the adapter streams the response
    post-response -> usage + cost (later: provenance, evaluation)

Each stage records a PipelineStep, so the trace shows exactly what happened.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import AsyncIterator, Union

from app.providers import ProviderAdapter, ProviderError
from app.schema import (
    AIRequest,
    AIResponse,
    ContextBreakdown,
    ContextSegment,
    Cost,
    Message,
    ModelInfo,
    PipelineStep,
    Timing,
    Trace,
    Usage,
    new_id,
)
from app.store import TraceStore
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


@dataclass
class Delta:
    text: str


@dataclass
class Finished:
    trace: Trace


@dataclass
class Failed:
    message: str
    trace: Trace


GatewayEvent = Union[Started, Delta, Finished, Failed]


@dataclass
class _Clock:
    start: float = field(default_factory=time.perf_counter)

    def ms(self) -> int:
        return int((time.perf_counter() - self.start) * 1000)


def price(model: ModelInfo, usage: Usage) -> Cost:
    per = 1_000_000
    inp = usage.input_tokens * model.input_price_per_mtok / per
    out = usage.output_tokens * model.output_price_per_mtok / per
    write_rate = model.cache_write_price_per_mtok or model.input_price_per_mtok
    read_rate = model.cache_read_price_per_mtok or model.input_price_per_mtok
    cache = (usage.cache_write_tokens * write_rate + usage.cache_read_tokens * read_rate) / per
    return Cost(input_usd=inp, output_usd=out, cache_usd=cache, total_usd=inp + out + cache)


class Gateway:
    def __init__(
        self,
        store: TraceStore,
        adapters: list[ProviderAdapter],
        daily_budget_usd: float = 0.0,
    ):
        self.store = store
        self.daily_budget_usd = daily_budget_usd
        self._routes: dict[str, tuple[ProviderAdapter, ModelInfo]] = {
            m.id: (a, m) for a in adapters for m in a.models()
        }

    def models(self) -> list[ModelInfo]:
        return [m for _, m in self._routes.values()]

    # ---- budget ------------------------------------------------------------

    def spent_today(self) -> float:
        today = datetime.now(timezone.utc).date()
        return sum(
            t.response.cost.total_usd
            for t in self.store.all()
            if t.created_at.date() == today
            and self._routes.get(t.response.model, (None, None))[1] is not None
            and self._routes[t.response.model][1].live
        )

    def check_budget(self, model: ModelInfo) -> None:
        if not model.live or self.daily_budget_usd <= 0:
            return
        spent = self.spent_today()
        if spent >= self.daily_budget_usd:
            raise BudgetExceededError(
                f"Today's spending limit of ${self.daily_budget_usd:.2f} has been reached "
                f"(${spent:.4f} spent). Raise SIFT_DAILY_BUDGET_USD in backend/.env, "
                "or switch to a mock model."
            )

    # ---- pipeline stages -------------------------------------------------

    def _assemble_context(
        self, request: AIRequest, model: ModelInfo
    ) -> tuple[list[Message], ContextBreakdown]:
        sent: list[Message] = []
        if request.system:
            sent.append(Message(role="system", content=request.system))
        sent.extend(request.messages)

        history, prompt = request.messages[:-1], request.messages[-1:]
        segments = [
            ContextSegment(
                label="System instructions",
                tokens=estimate_tokens(request.system or ""),
            ),
            ContextSegment(label="Conversation history", tokens=estimate_messages(history)),
            ContextSegment(label="Your prompt", tokens=estimate_messages(prompt)),
        ]
        total = sum(s.tokens for s in segments)
        return sent, ContextBreakdown(
            segments=segments, total_tokens=total, window=model.context_window
        )

    # ---- main entry point --------------------------------------------------

    def resolve(self, model_id: str) -> tuple[ProviderAdapter, ModelInfo]:
        if model_id not in self._routes:
            raise UnknownModelError(f"Unknown model: {model_id}")
        return self._routes[model_id]

    async def run(self, request: AIRequest) -> AsyncIterator[GatewayEvent]:
        adapter, model = self.resolve(request.model)
        clock = _Clock()
        pipeline: list[PipelineStep] = []

        # pre-request
        t = time.perf_counter()
        sent, context = self._assemble_context(request, model)
        pipeline.append(
            PipelineStep(
                name="Context assembly",
                stage="pre-request",
                duration_ms=int((time.perf_counter() - t) * 1000),
                detail=f"{len(sent)} messages, ~{context.total_tokens:,} tokens "
                f"({context.percent}% of {model.context_window:,})",
            )
        )

        trace_id = new_id("trace")
        yield Started(trace_id=trace_id, model=model, context=context)

        # provider
        parts: list[str] = []
        reported: Usage | None = None
        ttft = 0
        provider_start = time.perf_counter()
        error: str | None = None
        try:
            async for item in adapter.stream(request, sent):
                if isinstance(item, Usage):
                    reported = item
                    continue
                if not parts:
                    ttft = clock.ms()
                parts.append(item)
                yield Delta(text=item)
        except ProviderError as exc:
            error = str(exc)
        except Exception as exc:  # never leak a stack trace to the user
            error = f"Unexpected error from {adapter.provider}: {type(exc).__name__}"
        pipeline.append(
            PipelineStep(
                name=f"{model.name} via {adapter.provider}",
                stage="provider",
                duration_ms=int((time.perf_counter() - provider_start) * 1000),
                detail=error or f"streamed {len(parts)} chunks",
            )
        )

        # post-response
        t = time.perf_counter()
        content = "".join(parts)
        usage = reported or Usage(
            input_tokens=context.total_tokens,
            output_tokens=estimate_tokens(content),
            estimated=True,
        )
        if error and reported is None and model.live:
            # The provider failed before reporting usage. Rejected requests
            # aren't billed, so don't show an invented cost.
            usage = Usage(estimated=True)
        cost = price(model, usage)
        cache_note = ""
        if usage.cache_read_tokens or usage.cache_write_tokens:
            cache_note = (
                f"; cache read {usage.cache_read_tokens:,}, "
                f"cache write {usage.cache_write_tokens:,} tokens"
            )
        pipeline.append(
            PipelineStep(
                name="Cost calculator",
                stage="post-response",
                duration_ms=int((time.perf_counter() - t) * 1000),
                detail=f"${cost.total_usd:.6f} from "
                f"{'provider-reported' if not usage.estimated else 'estimated'} usage"
                f"{cache_note}",
            )
        )

        trace = Trace(
            id=trace_id,
            org_id=request.org_id,
            user_id=request.user_id,
            conversation_id=request.conversation_id,
            request=request,
            sent_messages=sent,
            response=AIResponse(
                model=model.id,
                provider=adapter.provider,
                content=content,
                finish_reason="error" if error else "stop",
                usage=usage,
                cost=cost,
                timing=Timing(time_to_first_token_ms=ttft, total_ms=clock.ms()),
            ),
            context=context,
            pipeline=pipeline,
        )
        self.store.put(trace)
        yield Failed(message=error, trace=trace) if error else Finished(trace=trace)
