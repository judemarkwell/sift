"""Transparency report: a conversation as Markdown, with what each reply cost
and what Sift's skills did along the way. Never includes redacted values."""

from __future__ import annotations

from app.schema import Conversation, ModelInfo, Trace


def _money(v: float) -> str:
    return "$0" if v == 0 else (f"${v:.4f}" if v >= 0.0001 else "<$0.0001")


def conversation_report(conv: Conversation, traces: dict[str, Trace], models: dict[str, ModelInfo]) -> str:
    total = sum(t.response.cost.total_usd for t in traces.values())
    lines = [
        f"# {conv.title}",
        "",
        f"Exported from Sift. {len(conv.messages)} messages, total model cost {_money(total)}.",
        "",
        "Values that Sift's PII redaction replaced are shown as placeholders, exactly as the model received them.",
        "",
    ]
    for i, m in enumerate(conv.messages):
        t = traces.get(m.trace_id or "")
        if m.role == "user":
            # The trace hangs off the reply that follows this message.
            nxt = conv.messages[i + 1] if i + 1 < len(conv.messages) else None
            t = traces.get(nxt.trace_id or "") if nxt else None
            lines += ["---", "", "**You**", ""]
            # The redacted form the model saw, when there is one.
            text = m.content
            if t is not None:
                sent_users = [s for s in t.sent_messages if s.role == "user"]
                if sent_users:
                    text = sent_users[-1].content
            lines += [text, ""]
            continue
        model = models.get(m.model_id or "")
        name = model.name if model else (m.model_id or "Model")
        lines += [f"**{name}**", ""]
        if m.status != "done":
            lines += [f"> {m.error}", ""]
        if t is not None:
            lines += [t.response.content or "", ""]
            r = t.response
            meta = [
                f"{r.usage.total_input_tokens:,} tokens in",
                f"{r.usage.output_tokens:,} out",
                _money(r.cost.total_usd),
                f"{r.timing.total_ms / 1000:.1f}s",
            ]
            if r.usage.estimated:
                meta.append("estimated (mock model)")
            lines += [f"_{', '.join(meta)}_", ""]
            notes = [f"- {s.name}: {s.detail}" for s in t.pipeline if s.skill_id and s.status != "ok"]
            if notes:
                lines += ["Skills:", *notes, ""]
    return "\n".join(lines)
