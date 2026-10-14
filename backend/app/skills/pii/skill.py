from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.schema import PiiAction
from app.skills.base import BaseSkill, PipelineContext, SkillManifest, StepResult
from app.skills.pii.detectors import DETECTORS
from app.skills.pii.entities import DEFAULT_PRESET, PRESETS, Policy
from app.skills.pii.redactor import StreamRestorer, redact_messages

PLACEHOLDER_NOTE = (
    "Some values in this conversation were replaced with placeholders such as "
    "[EMAIL_1] or [PHONE_2] to protect privacy. Treat each placeholder as the "
    "real value it stands for, and when you refer to one, copy the placeholder "
    "exactly, including the brackets."
)


class PiiConfig(BaseModel):
    preset: Literal["personal", "small_team", "customer_data", "regulated"] = Field(
        DEFAULT_PRESET, title="Policy preset"
    )
    overrides: dict[str, PiiAction] = Field(
        default_factory=dict, title="Per-type overrides", description="Changes to the preset, by data type"
    )
    detectors: list[Literal["patterns", "comprehend"]] = Field(
        default_factory=lambda: ["patterns", "comprehend"], title="Detectors"
    )
    restore_in_reply: bool = Field(
        True, title="Restore values in replies", description="Show real values where the model used a placeholder"
    )


def effective_policy(config: PiiConfig) -> Policy:
    return {**PRESETS[config.preset]["policy"], **config.overrides}


def active_detectors(config: PiiConfig):
    return [DETECTORS[d] for d in config.detectors if d in DETECTORS]


class PiiRedactionSkill(BaseSkill):
    Config = PiiConfig
    manifest = SkillManifest(
        id="pii-redaction",
        name="PII redaction",
        summary="Finds personal data and secrets before anything leaves Sift.",
        description=(
            "Scans every message for emails, phone numbers, card numbers, government IDs, "
            "API keys and more. Depending on your policy it replaces them with placeholders "
            "like [EMAIL_1], blocks the message, or just points them out. Placeholders in the "
            "reply are swapped back so you still see real values."
        ),
        category="Privacy",
        stages=["pre-request"],
        can_modify_request=True,
        config_schema=PiiConfig.model_json_schema(),
    )

    async def before(self, ctx: PipelineContext, config: PiiConfig) -> StepResult:  # type: ignore[override]
        policy = effective_policy(config)
        result = redact_messages(ctx.messages, policy, active_detectors(config), ctx.vault)
        last_user = max((i for i, m in enumerate(ctx.messages) if m.role == "user"), default=-1)
        current = [f for f in result.findings if f.message_index == last_user]
        earlier = len(result.findings) - len(current)
        ctx.prompt_marks.extend(current)

        # Even when blocking, the trace (a log) must only ever hold the redacted text.
        ctx.messages = result.messages
        if result.blocked:
            kinds = sorted({f.label.lower() for f in result.blocked})
            ctx.block(
                f"Blocked by your privacy policy: this message contains {', '.join(kinds)}. "
                "Remove it, or change the policy in Skills."
            )
            return StepResult("blocked", f"Stopped before sending: {', '.join(kinds)}", result.findings)

        redacted = [f for f in result.findings if f.action == "redact"]
        warned = [f for f in result.findings if f.action == "warn"]
        if redacted:
            ctx.system_notes.append(PLACEHOLDER_NOTE)
            if config.restore_in_reply:
                ctx.transformers.append(StreamRestorer(ctx.vault))

        if not result.findings:
            return StepResult("ok", "Nothing sensitive found")
        parts = []
        if redacted:
            parts.append(f"replaced {len(redacted)} with placeholders")
        if warned:
            parts.append(f"{len(warned)} sent as-is (warn only)")
        detail = "; ".join(parts).capitalize()
        if earlier:
            detail += f" ({earlier} of these were in earlier messages)"
        return StepResult("changed" if redacted else "warn", detail, result.findings)
