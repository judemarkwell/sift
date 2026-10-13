"""Sift API.

    GET  /api/health
    GET  /api/models
    POST /api/chat/stream       -> Server-Sent Events: start, delta, done, error
    GET  /api/traces            -> ?conversation_id=...
    GET  /api/traces/{trace_id}
"""

from __future__ import annotations

import json
import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from app.gateway import Delta, Failed, Finished, Gateway, Started, UnknownModelError
from app.schema import AIRequest, ModelInfo, Trace
from app.store import InMemoryTraceStore

# Hardcoded tenant until Cognito arrives; passed everywhere regardless.
LOCAL_ORG = "org_local"

app = FastAPI(title="Sift API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("SIFT_CORS_ORIGINS", "http://localhost:5173").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

gateway = Gateway(store=InMemoryTraceStore())


def _sse(event: str, data: object) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/models", response_model=list[ModelInfo])
def list_models() -> list[ModelInfo]:
    return gateway.models()


@app.post("/api/chat/stream")
async def chat_stream(request: AIRequest) -> StreamingResponse:
    if not request.messages or request.messages[-1].role != "user":
        raise HTTPException(400, "The last message must be from the user.")
    request.org_id = LOCAL_ORG
    if request.model not in {m.id for m in gateway.models()}:
        raise HTTPException(404, f"Unknown model: {request.model}")

    async def events():
        try:
            async for ev in gateway.run(request):
                if isinstance(ev, Started):
                    yield _sse(
                        "start",
                        {
                            "trace_id": ev.trace_id,
                            "model": ev.model.model_dump(),
                            "context": ev.context.model_dump(),
                        },
                    )
                elif isinstance(ev, Delta):
                    yield _sse("delta", {"text": ev.text})
                elif isinstance(ev, Finished):
                    yield _sse("done", {"trace": ev.trace.model_dump(mode="json")})
                elif isinstance(ev, Failed):
                    yield _sse(
                        "error",
                        {"message": ev.message, "trace": ev.trace.model_dump(mode="json")},
                    )
        except UnknownModelError as exc:
            yield _sse("error", {"message": str(exc)})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/traces", response_model=list[Trace])
def list_traces(conversation_id: str | None = None) -> list[Trace]:
    return gateway.store.list(LOCAL_ORG, conversation_id)


@app.get("/api/traces/{trace_id}", response_model=Trace)
def get_trace(trace_id: str) -> Trace:
    trace = gateway.store.get(LOCAL_ORG, trace_id)
    if not trace:
        raise HTTPException(404, "Trace not found")
    return trace
