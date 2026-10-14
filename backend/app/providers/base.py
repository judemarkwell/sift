"""The adapter contract every provider implements.

Real adapters (Anthropic, OpenAI, Bedrock, Gemini...) implement this same
interface, so the gateway and UI never change.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, AsyncIterator, Literal, Protocol, Union

from app.schema import AIRequest, Message, ModelInfo, Usage

@dataclass(frozen=True)
class StopReason:
    """Why the reply ended. "length" means it hit max_output_tokens and was
    cut off, so the UI offers Continue."""

    reason: Literal["stop", "length"]


# An adapter streams text chunks. Real providers also yield one Usage object
# (usually at the end) with the provider-reported token counts, which replace
# the gateway's estimates, and a StopReason.
StreamItem = Union[str, Usage, StopReason]


# The hidden turn sent when the user presses Continue on a cut-off reply.
CONTINUE_PROMPT = (
    "Continue exactly where your previous reply stopped. Don't repeat anything you already "
    "wrote and don't add a preamble; pick up mid-sentence if that's where it ended."
)


class ProviderError(RuntimeError):
    """A provider failed. The message is shown to the user, so keep it plain."""


class ProviderAdapter(Protocol):
    provider: str

    def models(self) -> list[ModelInfo]: ...

    def stream(
        self, request: AIRequest, sent_messages: list[Message], options: dict[str, Any]
    ) -> AsyncIterator[StreamItem]:
        """`sent_messages` is final (after skills; any system prompt first).
        `options` carries hints such as {"prompt_cache": True, "styles": [...]}
        and "load_image": a callable that returns an uploaded image's bytes."""
        ...
