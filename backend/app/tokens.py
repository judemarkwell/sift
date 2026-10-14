"""Rough token estimation.

Every provider tokenizes differently, so pre-send counts are always estimates
(the UI shows "~" for these). Real adapters replace them with the provider's
reported usage once the response finishes.
"""

import math

from app.schema import Message


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, math.ceil(len(text) / 4))


def estimate_messages(messages: list[Message]) -> int:
    # ~4 tokens of per-message overhead for role markers, like most chat formats.
    # Images are counted exactly (see app/images.py).
    return sum(estimate_tokens(m.content) + 4 + sum(i.tokens for i in m.images) for m in messages)


def image_tokens(messages: list[Message]) -> int:
    return sum(i.tokens for m in messages for i in m.images)
