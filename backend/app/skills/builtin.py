"""The skills that ship with Sift, besides PII redaction."""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.schema import Cost, Finding, ModelInfo, Usage
from app.skills.base import BaseSkill, PipelineContext, SkillManifest, StepResult
from app.skills.pii.detectors import PatternDetector
from app.skills.pii.redactor import PLACEHOLDER_RE, detect, mask
from app.skills.pii.entities import ENTITY_BY_KIND
from app.tokens import estimate_messages, estimate_tokens

# ---- pricing (shared with billing and the usage dashboard) ----------------------


def price(model: ModelInfo, usage: Usage) -> Cost:
    per = 1_000_000
    inp = usage.input_tokens * model.input_price_per_mtok / per
    out = usage.output_tokens * model.output_price_per_mtok / per
    write_rate = model.cache_write_price_per_mtok or model.input_price_per_mtok
    read_rate = model.cache_read_price_per_mtok or model.input_price_per_mtok
    cache = (usage.cache_write_tokens * write_rate + usage.cache_read_tokens * read_rate) / per
    uncached = (usage.total_input_tokens * model.input_price_per_mtok / per) + out
    return Cost(
        input_usd=inp,
        output_usd=out,
        cache_usd=cache,
        total_usd=inp + out + cache,
        uncached_usd=uncached,
    )


EXPECTED_OUTPUT_TOKENS = 600  # typical reply length, for pre-send estimates


def estimate_request_cost(model: ModelInfo, input_tokens: int, max_output: int) -> float:
    out = min(max_output, EXPECTED_OUTPUT_TOKENS)
    return (input_tokens * model.input_price_per_mtok + out * model.output_price_per_mtok) / 1_000_000


# ---- context trimmer ---------------------------------------------------------------


class TrimConfig(BaseModel):
    max_history_tokens: int = Field(
        40_000,
        ge=1_000,
        le=1_000_000,
        title="History limit (tokens)",
        description="Older messages beyond this are left out, oldest first",
    )


class ContextTrimmerSkill(BaseSkill):
    Config = TrimConfig
    manifest = SkillManifest(
        id="context-trimmer",
        name="Context trimmer",
        summary="Keeps long conversations from getting slow and expensive.",
        description=(
            "Every message re-sends the whole conversation, so long chats cost more each turn. "
            "When the history goes over your limit, the oldest messages are left out and the "
            "trace shows exactly which ones."
        ),
        category="Context",
        stages=["pre-request"],
        can_modify_request=True,
        config_schema=TrimConfig.model_json_schema(),
    )

    async def before(self, ctx: PipelineContext, config: TrimConfig) -> StepResult:  # type: ignore[override]
        system = [m for m in ctx.messages if m.role == "system"]
        convo = [m for m in ctx.messages if m.role != "system"]
        history, prompt = convo[:-1], convo[-1:]
        total = estimate_messages(history)
        if total <= config.max_history_tokens:
            return StepResult("ok", f"History is ~{total:,} tokens, under the {config.max_history_tokens:,} limit")
        dropped = 0
        dropped_tokens = 0
        # Drop whole exchanges from the front so roles keep alternating.
        while history and estimate_messages(history) > config.max_history_tokens:
            cut = 2 if len(history) >= 2 else 1
            dropped += cut
            dropped_tokens += estimate_messages(history[:cut])
            history = history[cut:]
        while history and history[0].role != "user":
            dropped += 1
            dropped_tokens += estimate_messages(history[:1])
            history = history[1:]
        ctx.messages = system + history + prompt
        return StepResult(
            "changed",
            f"Left out the {dropped} oldest messages (~{dropped_tokens:,} tokens)",
            [Finding(kind="TRIMMED", label="Messages left out", preview=f"{dropped} messages")],
        )


# ---- spend guard -------------------------------------------------------------------


class SpendConfig(BaseModel):
    max_cost_per_message_usd: float = Field(
        0.10, ge=0.0, le=50.0, title="Limit per message (USD)", description="Estimated before sending"
    )
    action: str = Field("warn", title="When over the limit", json_schema_extra={"enum": ["warn", "block"]})


class SpendGuardSkill(BaseSkill):
    Config = SpendConfig
    manifest = SkillManifest(
        id="spend-guard",
        name="Spend guard",
        summary="Catches unexpectedly expensive messages before they're sent.",
        description=(
            "Estimates what a message will cost before it goes out, from its size and the "
            "model's price. Over your limit, it either warns you or stops the message."
        ),
        category="Cost",
        stages=["pre-request"],
        can_modify_request=False,
        config_schema=SpendConfig.model_json_schema(),
    )

    async def before(self, ctx: PipelineContext, config: SpendConfig) -> StepResult:  # type: ignore[override]
        tokens = estimate_messages(ctx.messages) + estimate_tokens(" ".join(ctx.system_notes))
        cost = estimate_request_cost(ctx.model, tokens, ctx.request.max_output_tokens)
        detail = f"Estimated ${cost:.4f} for ~{tokens:,} input tokens"
        if cost <= config.max_cost_per_message_usd:
            return StepResult("ok", f"{detail}, under ${config.max_cost_per_message_usd:.2f}")
        finding = Finding(kind="OVER_BUDGET", label="Over per-message limit", preview=f"${cost:.4f}")
        if config.action == "block":
            ctx.block(
                f"This message would cost about ${cost:.4f}, over your ${config.max_cost_per_message_usd:.2f} "
                "per-message limit. Start a new chat, pick a cheaper model, or raise the limit in Skills."
            )
            return StepResult("blocked", detail, [finding])
        return StepResult("warn", f"{detail}, over ${config.max_cost_per_message_usd:.2f}", [finding])


# ---- prompt caching ----------------------------------------------------------------------


class PromptCacheSkill(BaseSkill):
    manifest = SkillManifest(
        id="prompt-cache",
        name="Prompt caching",
        summary="Reuses the unchanged start of a conversation at a fraction of the price.",
        description=(
            "Providers can cache the part of a request that hasn't changed since the last turn and "
            "charge much less to re-read it. Sift turns this on where supported and reports what it saved."
        ),
        category="Cost",
        stages=["pre-request", "post-response"],
        can_modify_request=False,
        config_schema={},
    )

    async def before(self, ctx: PipelineContext, config: BaseModel) -> StepResult:
        ctx.provider_options["prompt_cache"] = True
        supported = ctx.model.cache_read_price_per_mtok is not None
        return StepResult("ok", "Requested" if supported else f"{ctx.model.name} doesn't support caching")

    async def after(self, ctx: PipelineContext, config: BaseModel) -> StepResult | None:
        if not ctx.usage or not ctx.cost:
            return None
        saved = ctx.cost.uncached_usd - ctx.cost.total_usd
        if ctx.usage.cache_read_tokens:
            return StepResult(
                "ok",
                f"{ctx.usage.cache_read_tokens:,} tokens read from cache, saving ${max(saved, 0):.5f}",
            )
        if ctx.usage.cache_write_tokens:
            return StepResult("ok", f"Cached {ctx.usage.cache_write_tokens:,} tokens for the next turn")
        return StepResult("ok", "Nothing cached on this turn")


# ---- response scan -----------------------------------------------------------------------


class ResponseScanSkill(BaseSkill):
    manifest = SkillManifest(
        id="response-scan",
        name="Reply check",
        summary="Flags personal data or secrets that appear in a reply.",
        description=(
            "Models sometimes produce contact details, keys or IDs that weren't in your message. "
            "This checks each reply and points them out so you don't paste them somewhere by accident."
        ),
        category="Quality",
        stages=["post-response"],
        can_modify_request=False,
        config_schema={},
    )

    async def after(self, ctx: PipelineContext, config: BaseModel) -> StepResult | None:
        if not ctx.raw_output:
            return None
        # Placeholders are our own; anything else detected came from the model.
        text = PLACEHOLDER_RE.sub(lambda m: " " * len(m.group(0)), ctx.raw_output)
        spans = detect(text, [PatternDetector()])
        findings = [
            Finding(
                kind=s.kind,
                label=ENTITY_BY_KIND[s.kind].label if s.kind in ENTITY_BY_KIND else s.kind,
                action="warn",
                preview=mask(s.kind, s.text),
                detector="reply-check",
            )
            for s in spans
        ]
        if not findings:
            return StepResult("ok", "Nothing sensitive in the reply")
        kinds = sorted({f.label.lower() for f in findings})
        return StepResult("warn", f"The reply contains {', '.join(kinds)}. Check before sharing.", findings)


# ---- cost meter (core) ------------------------------------------------------------------


class CostMeterSkill(BaseSkill):
    manifest = SkillManifest(
        id="cost-meter",
        name="Cost meter",
        summary="Prices every reply from the model's real token usage.",
        description="Turns token counts into dollars using each model's published prices. Always on.",
        category="Cost",
        stages=["post-response"],
        can_modify_request=False,
        core=True,
        lockable=False,
        config_schema={},
    )

    async def after(self, ctx: PipelineContext, config: BaseModel) -> StepResult | None:
        if ctx.usage is None:
            return None
        ctx.cost = price(ctx.model, ctx.usage)
        source = "estimated" if ctx.usage.estimated else "provider-reported"
        sim = "" if ctx.model.live else " (simulated, not charged)"
        return StepResult("ok", f"${ctx.cost.total_usd:.6f} from {source} usage{sim}")
