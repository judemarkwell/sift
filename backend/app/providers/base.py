"""The adapter contract every provider implements.

Real adapters (Anthropic, OpenAI, Bedrock, Gemini...) implement this same
interface, so the gateway and UI never change.
"""

from __future__ import annotations

from typing import AsyncIterator, Protocol, Union

from app.schema import AIRequest, Message, ModelInfo, Usage

# An adapter streams text chunks. Real providers also yield one Usage object
# (usually at the end) with the provider-reported token counts, which replace
# the gateway's estimates.
StreamItem = Union[str, Usage]


class ProviderError(RuntimeError):
    """A provider failed. The message is shown to the user, so keep it plain."""


class ProviderAdapter(Protocol):
    provider: str

    def models(self) -> list[ModelInfo]: ...

    def stream(
        self, request: AIRequest, sent_messages: list[Message]
    ) -> AsyncIterator[StreamItem]: ...
