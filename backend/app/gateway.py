"""The gateway: one pipeline every request goes through.

    pre-request  -> context assembly (later: PII redaction, policy checks)
    provider     -> the adapter streams the response
    post-response-> usage + cost (later: provenance, evaluation)

Each stage records a PipelineStep, so the trace shows exactly what happened.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import AsyncIterator, Union

from app.providers import ADAPTERS, ProviderAdapter
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


class Gateway:
    def __init__(self, store: TraceStore, adapters: list[ProviderAdapter] = ADAPTERS):
        self.store = store
        self._routes: dict[str, tuple[ProviderAdapter, ModelInfo]] = {
            m.id: (a, m) for a in adapters for m in a.models()
        }

    def models(self) -> list[ModelInfo]:
        return [m for _, m in self._routes.values()]

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

    @staticmethod
    def _price(model: ModelInfo, usage: Usage) -> Cost:
        inp = usage.input_tokens * model.input_price_per_mtok / 1_000_000
        out = usage.output_tokens * model.output_price_per_mtok / 1_000_000
        return Cost(input_usd=inp, output_usd=out, total_usd=inp + out)

    # ---- main entry point --------------------------------------------------

    async def run(self, request: AIRequest) -> AsyncIterator[GatewayEvent]:
        if request.model not in self._routes:
            raise UnknownModelError(f"Unknown model: {request.model}")
        adapter, model = self._routes[request.model]
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
        ttft = 0
        provider_start = time.perf_counter()
        error: str | None = None
        try:
            async for chunk in adapter.stream(request, sent):
                if not parts:
                    ttft = clock.ms()
                parts.append(chunk)
                yield Delta(text=chunk)
        except Exception as exc:  # adapters raise provider errors here
            error = str(exc)
        pipeline.append(
            PipelineStep(
                name=f"{adapter.provider} · {model.name}",
                stage="provider",
                duration_ms=int((time.perf_counter() - provider_start) * 1000),
                detail=error or f"streamed {len(parts)} chunks",
            )
        )

        # post-response
        t = time.perf_counter()
        content = "".join(parts)
        usage = Usage(
            input_tokens=context.total_tokens,
            output_tokens=estimate_tokens(content),
            estimated=True,
        )
        cost = self._price(model, usage)
        pipeline.append(
            PipelineStep(
                name="Cost calculator",
                stage="post-response",
                duration_ms=int((time.perf_counter() - t) * 1000),
                detail=f"${cost.total_usd:.6f} at ${model.input_price_per_mtok}/"
                f"${model.output_price_per_mtok} per 1M in/out",
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
