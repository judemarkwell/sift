"""Output styles: /tldr, /explain, /long and friends.

A style is a short instruction added to the system prompt plus, for some, a
reply-length budget. Users pick them with slash commands anywhere in a
message ("/tldr what changed in v2?") or with the style buttons. Commands
are removed from the text before it's sent, and the trace shows which
styles applied.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Style:
    id: str
    label: str
    group: str  # "Length", "Format", "Tone", "Purpose"
    description: str  # shown in the menu
    instruction: str  # sent to the model
    max_tokens: int | None = None  # reply budget; None keeps the default


STYLES: list[Style] = [
    # Length
    Style("tldr", "TL;DR", "Length", "The answer in three lines or fewer",
          "Reply with a TL;DR: at most three short sentences or bullets. Lead with the answer itself. "
          "No preamble, no recap.", 400),
    Style("short", "Short", "Length", "One short paragraph",
          "Keep the reply to one short paragraph. Skip background the user didn't ask for.", 800),
    Style("long", "Long", "Length", "Thorough, with sections and examples",
          "Be thorough. Cover the topic in depth, organized with headings, and include concrete examples "
          "and edge cases.", 32_000),
    # Format
    Style("steps", "Steps", "Format", "A numbered list of steps",
          "Answer as a numbered list of concrete, ordered steps. Each step starts with a verb.", 6000),
    Style("bullets", "Bullets", "Format", "Concise bullet points",
          "Answer as concise bullet points, one idea per bullet. No long paragraphs."),
    Style("table", "Table", "Format", "A Markdown table where possible",
          "Present the answer as a Markdown table wherever the content allows, with a one-line summary above it."),
    Style("code", "Code", "Format", "Just the code",
          "Reply with code only, in fenced code blocks with the language named. Add at most one sentence of "
          "explanation, and only if essential.", 32_000),
    Style("outline", "Outline", "Format", "A structured outline",
          "Reply as a hierarchical outline with headings and nested bullets, suitable for a document skeleton."),
    # Purpose
    Style("explain", "Explain", "Purpose", "Step by step, jargon defined",
          "Explain this for someone new to the topic: build up step by step, define each technical term the "
          "first time it appears, and use one concrete analogy.", 8000),
    Style("eli5", "Like I'm 5", "Purpose", "Very simple words",
          "Explain using very simple words and short sentences that a curious child could follow. "
          "Use an everyday comparison.", 1500),
    Style("critique", "Critique", "Purpose", "Strengths, weaknesses, fixes",
          "Review critically. Give strengths, then weaknesses, then specific improvements in priority order. "
          "Be direct; don't soften real problems.", 6000),
    Style("pros-cons", "Pros & cons", "Purpose", "Both sides, then a verdict",
          "Lay out the pros and cons as two lists, then give a one-paragraph recommendation with the deciding factor."),
    Style("quiz", "Quiz me", "Purpose", "Questions to test understanding",
          "Instead of explaining, write five short questions that test understanding of this topic, "
          "with answers listed at the end under a heading.", 3000),
    # Tone
    Style("formal", "Formal", "Tone", "Professional and precise",
          "Use a formal, professional tone suitable for workplace documents."),
    Style("casual", "Casual", "Tone", "Relaxed and friendly",
          "Use a relaxed, friendly, conversational tone."),
]

STYLE_BY_ID = {s.id: s for s in STYLES}

# "/tldr" or "/pros-cons" as a whole word, at the start or after whitespace.
_COMMAND = re.compile(r"(?:(?<=\s)|^)/([a-z][a-z0-9-]*)(?=\s|$|[.,;:!?])")


def parse_styles(text: str) -> tuple[str, list[str]]:
    """Pull known style commands out of a message. Unknown /words stay in the
    text (they may be paths or the user's own words)."""
    found: list[str] = []

    def take(m: re.Match[str]) -> str:
        sid = m.group(1)
        if sid in STYLE_BY_ID:
            if sid not in found:
                found.append(sid)
            return ""
        return m.group(0)

    clean = _COMMAND.sub(take, text)
    clean = re.sub(r"[ \t]{2,}", " ", clean).strip()
    return clean, found


def style_budget(style_ids: list[str], default: int, cap: int) -> int:
    """Reply-length budget: the largest budget any chosen style asks for, so
    /long wins over /bullets; the default when none set one."""
    budgets = [STYLE_BY_ID[s].max_tokens for s in style_ids if s in STYLE_BY_ID and STYLE_BY_ID[s].max_tokens]
    return min(max(budgets) if budgets else default, cap)


def style_instructions(style_ids: list[str]) -> str | None:
    chosen = [STYLE_BY_ID[s] for s in style_ids if s in STYLE_BY_ID]
    if not chosen:
        return None
    lines = "\n".join(f"- {s.instruction}" for s in chosen)
    return f"The user asked for this reply style:\n{lines}"
