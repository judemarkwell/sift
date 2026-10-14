from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.schema import PiiAction
from app.skills.base import BaseSkill, PipelineContext, SkillManifest, StepResult
from app.skills.pii.detectors import DETECTORS
from app.skills.pii.entities import DEFAULT_PRESET, PRESETS, Policy, lower_label
from app.skills.pii.hints import hint
from app.skills.pii.redactor import PLACEHOLDER_RE, StreamRestorer, redact_messages

PLACEHOLDER_NOTE = (
    "Privacy: the user's app replaced some sensitive values with placeholders such as [EMAIL_1] "
    "or [API_KEY_1] before sending this conversation, and puts the real values back into your "
    "reply before the user reads it. The user already knows this, so:\n"
    "- Treat each placeholder as the real value and answer as specifically as you would if you "
    "could see it.\n"
    "- Don't mention placeholders, redaction, or that you can't see a value, and don't fall back "
    "to generic advice because of it.\n"
    "- When you refer to a value, write its placeholder exactly, including the brackets, so it "
    "can be restored. This applies inside code, config files and commands too: write "
    "`api_key = \"[API_KEY_1]\"` or `-H 'x-api-key: [API_KEY_1]'`, never a renamed or shortened form "
    "like API_KEY_1 or <your key>. The user's copy will contain the real value.\n"
    "- If the exact characters of a value would really change your answer, say what to check "
    "about it (for example \"make sure [API_KEY_1] was copied in full\") instead of saying you "
    "can't see it.\n"
    "- Facts listed below about a value (its type, length, whether it looks complete) were checked "
    "by the app against the real value. Use them directly, for example: \"[API_KEY_1] is 97 "
    "characters, 11 short of a normal Anthropic key, so it was probably cut off when you copied it.\""
)


def placeholder_note(vault, used: set[str]) -> str:
    """The privacy note, plus safe shape hints for the placeholders in this request."""
    lines = []
    for ph in sorted(used):
        value = vault.by_placeholder.get(ph)
        kind = ph.strip("[]").rsplit("_", 1)[0]
        h = hint(kind, value) if value is not None else None
        if h:
            lines.append(f"- {ph} is {h}.")
    if not lines:
        return PLACEHOLDER_NOTE
    return PLACEHOLDER_NOTE + "\n\nWhat's known about these values (safe to rely on):\n" + "\n".join(lines)


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
            kinds = sorted({lower_label(f.label) for f in result.blocked})
            ctx.block(
                f"Blocked by your privacy policy: this message contains {', '.join(kinds)}. "
                "Remove it, or change the policy in Skills."
            )
            return StepResult("blocked", f"Stopped before sending: {', '.join(kinds)}", current or result.blocked)

        # Placeholders matter for every message (history is re-sent), but the
        # step reports only what's new in this turn so counts don't repeat.
        if any(f.action == "redact" for f in result.findings):
            used = {m.group(0) for msg in result.messages for m in PLACEHOLDER_RE.finditer(msg.content)}
            ctx.system_notes.append(placeholder_note(ctx.vault, used))
            if config.restore_in_reply:
                ctx.transformers.append(StreamRestorer(ctx.vault))

        redacted = [f for f in current if f.action == "redact"]
        warned = [f for f in current if f.action == "warn"]
        if not current:
            note = f"Nothing new; {earlier} earlier item(s) still use their placeholders" if earlier else "Nothing sensitive found"
            return StepResult("ok", note)
        parts = []
        if redacted:
            parts.append(f"replaced {len(redacted)} with placeholders")
        if warned:
            parts.append(f"{len(warned)} sent as-is (warn only)")
        detail = "; ".join(parts).capitalize()
        if earlier:
            detail += f". {earlier} item(s) from earlier messages kept their placeholders"
        return StepResult("changed" if redacted else "warn", detail, current)
