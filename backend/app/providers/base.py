"""The adapter contract every provider implements.

Real adapters (OpenAI, Anthropic via Bedrock, Gemini, Sign in with ChatGPT)
will implement this same interface, so the gateway and UI never change.
"""

from __future__ import annotations

from typing import AsyncIterator, Protocol

from app.schema import AIRequest, Message, ModelInfo


class ProviderAdapter(Protocol):
    provider: str

    def models(self) -> list[ModelInfo]: ...

    def stream(
        self, request: AIRequest, sent_messages: list[Message]
    ) -> AsyncIterator[str]:
        """Yield response text chunks as they arrive."""
        ...
