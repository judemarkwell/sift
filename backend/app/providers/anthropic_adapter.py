"""Anthropic (Claude API) adapter.

Uses the platform's own API key (ANTHROPIC_API_KEY), so every user's
requests are billed to the Sift account. Usage reported by the API replaces
the gateway's token estimates, including prompt-cache reads and writes.

Prices are from https://platform.claude.com/docs/en/about-claude/pricing
(checked 2026-10-13). Haiku 5.5 is listed at its <=100K-token-prompt rate.
"""

from __future__ import annotations

from typing import AsyncIterator

import anthropic

from app.providers.base import ProviderError, StreamItem
from app.schema import AIRequest, Message, ModelInfo, Usage

PROVIDER = "Anthropic"

MODELS = [
    ModelInfo(
        id="claude-haiku-5-5",
        name="Claude Haiku 5.5",
        provider=PROVIDER,
        context_window=1_000_000,
        input_price_per_mtok=0.10,
        output_price_per_mtok=0.50,
        cache_write_price_per_mtok=0.125,
        cache_read_price_per_mtok=0.01,
        description="Fastest and cheapest. Prompts over 100K tokens cost 5x more.",
        live=True,
    ),
    ModelInfo(
        id="claude-sonnet-5-5",
        name="Claude Sonnet 5.5",
        provider=PROVIDER,
        context_window=1_000_000,
        input_price_per_mtok=2.00,
        output_price_per_mtok=10.00,
        cache_write_price_per_mtok=2.50,
        cache_read_price_per_mtok=0.10,
        description="Strong all-rounder at a moderate price.",
        live=True,
    ),
    ModelInfo(
        id="claude-opus-5-5",
        name="Claude Opus 5.5",
        provider=PROVIDER,
        context_window=1_000_000,
        input_price_per_mtok=4.00,
        output_price_per_mtok=20.00,
        cache_write_price_per_mtok=5.00,
        cache_read_price_per_mtok=0.20,
        description="Most capable for complex work.",
        live=True,
    ),
]


class AnthropicAdapter:
    provider = PROVIDER

    def __init__(self, api_key: str, max_output_tokens: int) -> None:
        self._client = anthropic.AsyncAnthropic(api_key=api_key)
        self._max_output_tokens = max_output_tokens

    def models(self) -> list[ModelInfo]:
        return MODELS

    async def stream(
        self, request: AIRequest, sent_messages: list[Message]
    ) -> AsyncIterator[StreamItem]:
        system = "\n\n".join(m.content for m in sent_messages if m.role == "system")
        messages = [
            {"role": m.role, "content": m.content}
            for m in sent_messages
            if m.role != "system"
        ]
        kwargs: dict = {
            "model": request.model,
            "max_tokens": min(request.max_output_tokens, self._max_output_tokens),
            "messages": messages,
            # Automatic prompt caching: the API caches the longest reusable
            # prefix, so long conversations get cheaper on later turns.
            "cache_control": {"type": "ephemeral"},
        }
        if system:
            kwargs["system"] = system

        try:
            async with self._client.messages.stream(**kwargs) as stream:
                async for text in stream.text_stream:
                    yield text
                final = await stream.get_final_message()
        except anthropic.AuthenticationError as exc:
            raise ProviderError("Anthropic rejected the API key. Check ANTHROPIC_API_KEY in backend/.env") from exc
        except anthropic.RateLimitError as exc:
            raise ProviderError("Anthropic rate limit reached. Wait a moment and try again") from exc
        except anthropic.APIStatusError as exc:
            raise ProviderError(f"Anthropic returned an error ({exc.status_code}): {exc.message}") from exc
        except anthropic.APIConnectionError as exc:
            raise ProviderError("Couldn't reach Anthropic. Check your internet connection") from exc

        u = final.usage
        yield Usage(
            input_tokens=u.input_tokens,
            output_tokens=u.output_tokens,
            cache_write_tokens=u.cache_creation_input_tokens or 0,
            cache_read_tokens=u.cache_read_input_tokens or 0,
            estimated=False,
        )
