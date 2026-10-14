"""Mock providers for building the UI with zero API cost.

Each mock behaves like a different vendor: its own models, prices, latency
and writing style. Prices are illustrative, not real list prices.

Handy test prompts:
  /error   -> the provider fails mid-stream
  /long    -> a much longer reply (watch the cost and context numbers move)
"""

from __future__ import annotations

import asyncio
import random
import re
from dataclasses import dataclass
from typing import Any, AsyncIterator

from app.providers.base import CONTINUE_PROMPT, ProviderError, StopReason, StreamItem
from app.schema import AIRequest, Message, ModelInfo


@dataclass
class Persona:
    opener: list[str]
    closer: list[str]


def _topic(text: str, words: int = 8) -> str:
    without_commands = re.sub(r"/(error|long|cutoff)\b", "", text)
    cleaned = re.sub(r"\s+", " ", without_commands).strip().rstrip("?.!")
    parts = cleaned.split(" ")
    snippet = " ".join(parts[:words])
    return snippet + ("…" if len(parts) > words else "")


def _body(topic: str, long: bool) -> str:
    points = [
        f"**Start with the goal.** Before going deep on *{topic}*, decide what a good outcome looks like and how you'd measure it.",
        "**Separate what's known from what's assumed.** Most mistakes come from treating an assumption as a fact.",
        "**Pick the smallest useful next step.** Something you can finish and check today beats a perfect plan.",
        "**Write down the trade-offs.** Cost, speed and risk usually pull in different directions.",
        "**Revisit once you have data.** Your first answer is a hypothesis, not a verdict.",
    ]
    if not long:
        return "\n".join(f"{i}. {p}" for i, p in enumerate(points[:3], 1))

    extra = (
        "\n\n### A worked example\n\n"
        "Say you're comparing two options. List the three criteria that matter "
        "most, score each option from 1 to 5, and weight the scores by importance. "
        "The total won't decide for you, but it shows where your intuition and "
        "your stated priorities disagree, which is usually the interesting part.\n\n"
        "| Criterion | Weight | Option A | Option B |\n"
        "|---|---|---|---|\n"
        "| Cost | 0.5 | 4 | 2 |\n"
        "| Speed | 0.3 | 2 | 5 |\n"
        "| Risk | 0.2 | 3 | 3 |\n\n"
        "```python\n"
        "weights = {'cost': 0.5, 'speed': 0.3, 'risk': 0.2}\n"
        "a = {'cost': 4, 'speed': 2, 'risk': 3}\n"
        "score = sum(weights[k] * a[k] for k in weights)  # 3.2\n"
        "```\n"
    )
    return "\n".join(f"{i}. {p}" for i, p in enumerate(points, 1)) + extra


def _code_with_key(ph: str) -> str:
    """What a real model is told to write: the placeholder, exactly, inside code."""
    return (
        "Here's a working setup using your key:\n\n"
        "```python\nfrom anthropic import Anthropic\n\n"
        f'client = Anthropic(api_key="{ph}")\n'
        'reply = client.messages.create(model="claude-haiku-5-5", max_tokens=200,\n'
        '                               messages=[{"role": "user", "content": "Hello"}])\n'
        "print(reply.content[0].text)\n```\n\n"
        "Or test it straight from the terminal:\n\n"
        "```bash\ncurl https://api.anthropic.com/v1/messages \\\n"
        f"  -H 'x-api-key: {ph}' \\\n"
        "  -H 'anthropic-version: 2023-06-01' \\\n"
        "  -H 'content-type: application/json' \\\n"
        """  -d '{"model": "claude-haiku-5-5", "max_tokens": 50, "messages": [{"role": "user", "content": "Hi"}]}'\n```\n\n"""
        f"Keep `{ph}` out of version control: put it in a `.env` file instead."
    )


class MockAdapter:
    """One fake vendor. Implements the ProviderAdapter protocol."""

    def __init__(
        self,
        provider: str,
        models: list[ModelInfo],
        persona: Persona,
        first_token_ms: tuple[int, int],
        chunk_delay_ms: tuple[int, int],
    ) -> None:
        self.provider = provider
        self._models = models
        self._persona = persona
        self._first_token_ms = first_token_ms
        self._chunk_delay_ms = chunk_delay_ms

    def models(self) -> list[ModelInfo]:
        return self._models

    def _compose(self, request: AIRequest, sent: list[Message], styles: list[str]) -> str:
        last = next((m for m in reversed(sent) if m.role == "user"), None)
        last_user = last.content if last else ""
        model_name = next(m.name for m in self._models if m.id == request.model)
        sign = f"\n\n— *{model_name}, mock response*"

        if last_user == CONTINUE_PROMPT:
            return (
                "…and to finish the thought: the remaining points follow the same pattern. Check each "
                "assumption against real data, keep the next step small, and write down what you learned "
                "so the next decision is easier." + sign
            )

        topic = _topic(last_user) or "this"
        system = "\n".join(m.content for m in sent if m.role == "system")
        skill = re.search(r'saved skill "([^"]+)"', system)
        preface = f"_Following your **{skill.group(1)}** skill._\n\n" if skill else ""
        if last and last.images:
            sizes = ", ".join(f"{i.width}×{i.height}" for i in last.images)
            n = len(last.images)
            preface += f"I can see {n} image{'s' if n > 1 else ''} ({sizes}). "
            preface += "(A mock can't actually look at it; a real model would describe it here.)\n\n"

        placeholders = list(dict.fromkeys(re.findall(r"\[[A-Z_]+_\d+\]", last_user)))
        privacy = (
            "\n\n**Using your details:** I'll include "
            + ", ".join(placeholders)
            + f" where it's needed. For example, the follow-up goes to {placeholders[0]}."
            if placeholders
            else ""
        )

        if "tldr" in styles or "short" in styles:
            label = "**TL;DR:** " if "tldr" in styles else ""
            return (
                f"{preface}{label}For *{topic}*, start from the outcome you want, test your biggest "
                f"assumption first, and take one small step today.{privacy}{sign}"
            )
        if "steps" in styles:
            body = "\n".join(f"{i}. {s}" for i, s in enumerate(STEPS, 1))
        elif "table" in styles:
            body = TABLE
        elif "code" in styles:
            key = next((p for p in placeholders if p.startswith(("[API_KEY_", "[AWS_ACCESS_KEY_"))), None)
            body = _code_with_key(key) if key else CODE
        elif "bullets" in styles:
            body = "\n".join(f"- {s}" for s in STEPS)
        else:
            body = _body(topic, "long" in styles)
        opener = random.choice(self._persona.opener).format(topic=topic)
        closer = random.choice(self._persona.closer)
        turns = sum(1 for m in sent if m.role == "user")
        memory = (
            f"\n\n_(This is turn {turns} of our conversation, so I received "
            f"{len(sent)} messages of context.)_"
            if turns > 1
            else ""
        )
        tone = " Formally speaking," if "formal" in styles else ""
        return f"{preface}{opener}{tone}\n\n{body}{privacy}\n\n{closer}{memory}{sign}"

    async def stream(
        self, request: AIRequest, sent_messages: list[Message], options: dict[str, Any]
    ) -> AsyncIterator[StreamItem]:
        text = self._compose(request, sent_messages, options.get("styles", []))
        last_user = sent_messages[-1].content if sent_messages else ""

        # Respect the reply budget like a real model would: cut off and say so.
        budget = 60 if "/cutoff" in last_user else request.max_output_tokens
        truncated = len(text) > budget * 4
        if truncated:
            text = text[: budget * 4]

        await asyncio.sleep(random.randint(*self._first_token_ms) / 1000)

        # Split into token-sized pieces, like real streams. Long words (and
        # placeholders like [EMAIL_1]) get split across chunks on purpose.
        chunks = re.findall(r"\S{1,6}\s*|\s+", text)
        fail_at = len(chunks) // 3 if "/error" in last_user else None
        for i, chunk in enumerate(chunks):
            if fail_at is not None and i == fail_at:
                raise ProviderError(
                    f"{self.provider} returned 529 overloaded (simulated)"
                )
            yield chunk
            await asyncio.sleep(random.randint(*self._chunk_delay_ms) / 1000)
        yield StopReason("length" if truncated else "stop")



STEPS = [
    "Write down the outcome you want and how you'll know you got it.",
    "List what you know for sure, and separately what you're assuming.",
    "Test the riskiest assumption first, as cheaply as you can.",
    "Do the smallest useful piece of work and check the result.",
    "Repeat, adjusting the plan with what you learned.",
]
TABLE = (
    "Here's the comparison at a glance.\n\n"
    "| Option | Cost | Speed | Risk |\n|---|---|---|---|\n"
    "| Do it now | Low | Fast | Medium |\n| Plan first | Medium | Slower | Low |\n"
    "| Wait | None | — | High |"
)
CODE = (
    "```python\n"
    "def weighted_score(scores: dict[str, float], weights: dict[str, float]) -> float:\n"
    "    return sum(weights[k] * scores[k] for k in weights)\n"
    "```"
)


MOCK_PROVIDERS = [
    MockAdapter(
        provider="OpenAI (mock)",
        models=[
            ModelInfo(
                id="mock-gpt-mini",
                name="GPT Mini",
                provider="OpenAI (mock)",
                context_window=128_000,
                input_price_per_mtok=0.15,
                output_price_per_mtok=0.60,
                description="Fast and cheap. Good default.",
            ),
            ModelInfo(
                id="mock-gpt-flagship",
                name="GPT Flagship",
                provider="OpenAI (mock)",
                context_window=200_000,
                input_price_per_mtok=2.50,
                output_price_per_mtok=10.00,
                description="Most capable, priced to match.",
            ),
        ],
        persona=Persona(
            opener=[
                "Great question! Here's a clear way to think about **{topic}**:",
                "Sure — let's break down **{topic}** step by step.",
            ],
            closer=[
                "Want me to turn this into a checklist?",
                "Let me know if you'd like a deeper dive on any of these.",
            ],
        ),
        first_token_ms=(250, 500),
        chunk_delay_ms=(12, 30),
    ),
    MockAdapter(
        provider="Anthropic (mock)",
        models=[
            ModelInfo(
                id="mock-claude-haiku",
                name="Claude Haiku",
                provider="Anthropic (mock)",
                context_window=200_000,
                input_price_per_mtok=1.00,
                output_price_per_mtok=5.00,
                description="Quick, efficient everyday model.",
            ),
            ModelInfo(
                id="mock-claude-sonnet",
                name="Claude Sonnet",
                provider="Anthropic (mock)",
                context_window=200_000,
                input_price_per_mtok=3.00,
                output_price_per_mtok=15.00,
                description="Balanced reasoning and speed.",
            ),
        ],
        persona=Persona(
            opener=[
                "A few things matter most for **{topic}**.",
                "Here's how I'd approach **{topic}**, with the trade-offs made explicit.",
            ],
            closer=[
                "If you tell me more about your constraints, I can narrow this down.",
                "The third point is usually where people get stuck, so it's worth starting there.",
            ],
        ),
        first_token_ms=(400, 800),
        chunk_delay_ms=(15, 35),
    ),
    MockAdapter(
        provider="Google (mock)",
        models=[
            ModelInfo(
                id="mock-gemini-flash",
                name="Gemini Flash",
                provider="Google (mock)",
                context_window=1_000_000,
                input_price_per_mtok=0.10,
                output_price_per_mtok=0.40,
                description="Huge context window, very low cost.",
            ),
        ],
        persona=Persona(
            opener=[
                "Okay, here's an overview of **{topic}**:",
                "Let's look at **{topic}** from a practical angle.",
            ],
            closer=[
                "I can also compare a couple of specific options if that helps.",
                "Would a summary table be useful?",
            ],
        ),
        first_token_ms=(150, 350),
        chunk_delay_ms=(8, 20),
    ),
]
