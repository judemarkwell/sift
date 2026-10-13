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
from typing import AsyncIterator

from app.schema import AIRequest, Message, ModelInfo


class MockProviderError(RuntimeError):
    pass


@dataclass
class Persona:
    opener: list[str]
    closer: list[str]


def _topic(text: str, words: int = 8) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip().rstrip("?.!")
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

    def _compose(self, request: AIRequest, sent: list[Message]) -> str:
        last_user = next((m.content for m in reversed(sent) if m.role == "user"), "")
        topic = _topic(last_user) or "this"
        turns = sum(1 for m in sent if m.role == "user")
        opener = random.choice(self._persona.opener).format(topic=topic)
        closer = random.choice(self._persona.closer)
        memory = (
            f"\n\n_(This is turn {turns} of our conversation, so I received "
            f"{len(sent)} messages of context.)_"
            if turns > 1
            else ""
        )
        model_name = next(m.name for m in self._models if m.id == request.model)
        return (
            f"{opener}\n\n{_body(topic, '/long' in last_user)}\n\n{closer}"
            f"{memory}\n\n— *{model_name}, mock response*"
        )

    async def stream(
        self, request: AIRequest, sent_messages: list[Message]
    ) -> AsyncIterator[str]:
        text = self._compose(request, sent_messages)
        last_user = sent_messages[-1].content if sent_messages else ""

        await asyncio.sleep(random.randint(*self._first_token_ms) / 1000)

        # Split into word-ish chunks, keeping whitespace, like real token streams.
        chunks = re.findall(r"\S+\s*|\s+", text)
        fail_at = len(chunks) // 3 if "/error" in last_user else None
        for i, chunk in enumerate(chunks):
            if fail_at is not None and i == fail_at:
                raise MockProviderError(
                    f"{self.provider} returned 529 overloaded (simulated)"
                )
            yield chunk
            await asyncio.sleep(random.randint(*self._chunk_delay_ms) / 1000)


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
