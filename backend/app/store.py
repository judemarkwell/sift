"""Trace storage behind a small interface.

Local dev uses memory. Swapping in DynamoDB (or DynamoDB Local) later means
writing one new class with these two methods; nothing else changes.
"""

from __future__ import annotations

from typing import Protocol

from app.schema import Trace


class TraceStore(Protocol):
    def put(self, trace: Trace) -> None: ...

    def get(self, org_id: str, trace_id: str) -> Trace | None: ...

    def list(self, org_id: str, conversation_id: str | None = None) -> list[Trace]: ...

    def all(self) -> list[Trace]: ...


class InMemoryTraceStore:
    def __init__(self) -> None:
        self._traces: dict[str, Trace] = {}

    def put(self, trace: Trace) -> None:
        self._traces[trace.id] = trace

    def get(self, org_id: str, trace_id: str) -> Trace | None:
        trace = self._traces.get(trace_id)
        # Always scope reads by org, so tenant isolation is habit from day one.
        return trace if trace and trace.org_id == org_id else None

    def list(self, org_id: str, conversation_id: str | None = None) -> list[Trace]:
        return [
            t
            for t in self._traces.values()
            if t.org_id == org_id
            and (conversation_id is None or t.conversation_id == conversation_id)
        ]

    def all(self) -> list[Trace]:
        return list(self._traces.values())
