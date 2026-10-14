import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import main
from app.deps import App
from app.providers.base import ProviderError
from app.providers.mock import MockAdapter, Persona
from app.schema import ModelInfo, Usage
from app.storage.sqlite import SqliteStorage


class FakeLive:
    """A 'real' provider for tests: costs money, reports usage, echoes placeholders."""

    provider = "FakeCo"
    model = ModelInfo(id="fake-live", name="Fake Live", provider="FakeCo", context_window=100_000,
                      input_price_per_mtok=1000.0, output_price_per_mtok=1000.0,
                      cache_read_price_per_mtok=100.0, live=True)

    def __init__(self) -> None:
        self.last_sent = None
        self.last_options = None
        self.fail = False

    def models(self):
        return [self.model]

    async def stream(self, request, sent_messages, options: dict[str, Any]):
        self.last_sent = sent_messages
        self.last_options = options
        if self.fail:
            raise ProviderError("FakeCo is down")
        user = sent_messages[-1].content
        for piece in ["You said: ", user[:30], " — got it, [EMA", "IL_1]."]:
            yield piece
        yield Usage(input_tokens=100, output_tokens=20, cache_read_tokens=50, estimated=False)


@pytest.fixture()
def fake():
    return FakeLive()


@pytest.fixture()
def client(fake):
    mock = MockAdapter(
        provider="Mock",
        models=[ModelInfo(id="mock-a", name="Mock A", provider="Mock", context_window=10_000,
                          input_price_per_mtok=1, output_price_per_mtok=2)],
        persona=Persona(opener=["About **{topic}**:"], closer=["Done."]),
        first_token_ms=(0, 0),
        chunk_delay_ms=(0, 0),
    )
    test_app = App(storage=SqliteStorage(":memory:"), adapters=[fake, mock], default_plan="pro",
                   daily_budget_usd=0)
    main.app.dependency_overrides[main.get_app] = lambda: test_app
    with TestClient(main.app) as c:
        c.sift = test_app  # type: ignore[attr-defined]
        yield c
    main.app.dependency_overrides.clear()


def stream(client, **body):
    """POST to the chat stream and return the parsed events."""
    with client.stream("POST", "/api/chat/stream", json=body) as r:
        if r.status_code != 200:
            r.read()
            return r.status_code, r.json()
        events = []
        for block in r.read().decode().split("\n\n"):
            if not block.strip():
                continue
            name = block.split("\n")[0].removeprefix("event: ")
            data = json.loads(block.split("\n")[1].removeprefix("data: "))
            events.append((name, data))
        return 200, events
