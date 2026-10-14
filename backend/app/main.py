"""Sift API.

Every route takes the caller from `current_principal` and scopes all reads
and writes to that principal's org.
"""

from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.auth import current_principal
from app.billing.payments import PaymentError
from app.billing.plans import PLANS, TOPUP_AMOUNTS, TOPUP_FEE
from app.billing.service import PlanError
from app.deps import App
from app.gateway import BudgetExceededError, Delta, Failed, Finished, Started, UnknownModelError
from app.report import conversation_report
from app.schema import (
    Conversation,
    ConversationSummary,
    Finding,
    Message,
    ModelInfo,
    Principal,
    StoredMessage,
    Trace,
    new_id,
    utcnow,
)
from app.skills.pii.entities import ENTITIES, PRESETS
from app.skills.pii.redactor import scan
from app.skills.pii.skill import PiiConfig, active_detectors, effective_policy
from app.skills.registry import SKILL_BY_ID, SKILLS, SettingsError, validate_patch

app = FastAPI(title="Sift API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("SIFT_CORS_ORIGINS", "http://localhost:5173").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

core = App()


def get_app() -> App:
    return core


def _sse(event: str, data: object) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


def _plan_error(exc: PlanError) -> HTTPException:
    return HTTPException(402, {"message": str(exc), "code": exc.code})


# ---- basics -------------------------------------------------------------------


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


class ModelView(ModelInfo):
    allowed: bool
    required_plan: str | None = None


@app.get("/api/models", response_model=list[ModelView])
def list_models(p: Principal = Depends(current_principal), a: App = Depends(get_app)) -> list[ModelView]:
    acct = a.billing.account(p.org_id)
    out = []
    for m in a.gateway.models():
        allowed = a.billing.model_allowed(acct, m)
        required = None
        if not allowed:
            required = next(pl.name for pl in PLANS.values() if pl.models is None or m.id in pl.models)
        out.append(ModelView(**m.model_dump(), allowed=allowed, required_plan=required))
    return out


@app.get("/api/me")
def me(p: Principal = Depends(current_principal), a: App = Depends(get_app)) -> dict[str, Any]:
    acct = a.billing.account(p.org_id)
    return {
        "principal": p,
        "plan_id": acct.plan_id,
        "plan_name": acct.plan.name,
        "features": acct.plan.features,
        "available_usd": round(acct.available_usd, 6),
        "platform": {
            "daily_budget_usd": a.gateway.daily_budget_usd,
            "spent_today_usd": round(a.gateway.spent_today(), 6),
            "live_models": any(m.live for m in a.gateway.models()),
        },
    }


# ---- conversations ------------------------------------------------------------------


def _summary(conv: Conversation, a: App) -> ConversationSummary:
    spend = sum(t.response.cost.total_usd for t in a.storage.list_traces(conv.org_id, conversation_id=conv.id))
    return ConversationSummary(
        id=conv.id,
        title=conv.title,
        model_id=conv.model_id,
        updated_at=conv.updated_at,
        message_count=len(conv.messages),
        spend_usd=spend,
    )


@app.get("/api/conversations", response_model=list[ConversationSummary])
def list_conversations(p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    return [_summary(c, a) for c in a.storage.list_conversations(p.org_id, p.user_id)]


def _own_conversation(p: Principal, a: App, conv_id: str) -> Conversation:
    conv = a.storage.get_conversation(p.org_id, conv_id)
    if not conv or conv.user_id != p.user_id:
        raise HTTPException(404, "Conversation not found")
    return conv


@app.get("/api/conversations/{conv_id}", response_model=Conversation)
def get_conversation(conv_id: str, p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    return _own_conversation(p, a, conv_id)


class ConversationPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=120)
    model_id: str | None = None


@app.patch("/api/conversations/{conv_id}", response_model=ConversationSummary)
def patch_conversation(conv_id: str, body: ConversationPatch, p: Principal = Depends(current_principal),
                       a: App = Depends(get_app)):
    conv = _own_conversation(p, a, conv_id)
    if body.title:
        conv.title = body.title.strip()
    if body.model_id:
        a.gateway.resolve(body.model_id)
        conv.model_id = body.model_id
    a.storage.put_conversation(conv)
    return _summary(conv, a)


@app.delete("/api/conversations/{conv_id}", status_code=204)
def delete_conversation(conv_id: str, p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    _own_conversation(p, a, conv_id)
    a.storage.delete_conversation(p.org_id, conv_id)


@app.get("/api/conversations/{conv_id}/report", response_class=PlainTextResponse)
def report(conv_id: str, p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    conv = _own_conversation(p, a, conv_id)
    traces = {t.id: t for t in a.storage.list_traces(p.org_id, conversation_id=conv.id)}
    models = {m.id: m for m in a.gateway.models()}
    return conversation_report(conv, traces, models)


@app.get("/api/traces/{trace_id}", response_model=Trace)
def get_trace(trace_id: str, p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    trace = a.storage.get_trace(p.org_id, trace_id)
    if not trace or trace.user_id != p.user_id:
        raise HTTPException(404, "Trace not found")
    return trace


# ---- chat --------------------------------------------------------------------------


class ChatRequest(BaseModel):
    conversation_id: str | None = None
    model: str
    message: str = Field(min_length=1, max_length=200_000)
    ephemeral: bool = Field(False, description="Compare mode: run once, don't save to a conversation")


def _history(conv: Conversation) -> list[Message]:
    return [Message(role=m.role, content=m.content) for m in conv.messages if m.status == "done"]


def _mask_blocked(text: str, marks: list[Finding]) -> str:
    """Never store a value the policy blocked, even in the user's own history."""
    for f in sorted((f for f in marks if f.action == "block"), key=lambda f: f.start or 0, reverse=True):
        if f.start is not None and f.end is not None:
            text = text[: f.start] + (f.preview or "•••") + text[f.end :]
    return text


def _safe_title(text: str, marks: list[Finding]) -> str:
    """Conversation titles show up in lists and exports, so anything a skill
    redacted or blocked appears as its placeholder here too."""
    for f in sorted((f for f in marks if f.action in ("redact", "block")), key=lambda f: f.start or 0,
                    reverse=True):
        if f.start is not None and f.end is not None:
            text = text[: f.start] + (f.placeholder or f.preview or "•••") + text[f.end :]
    return " ".join(text.split())[:60] or "New chat"


@app.post("/api/chat/stream")
async def chat_stream(body: ChatRequest, p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    try:
        _, model = a.gateway.resolve(body.model)
        a.billing.check(p.org_id, model)
        a.gateway.check_budget(model)
        if body.ephemeral and not a.billing.has_feature(p.org_id, "compare"):
            raise PlanError("Comparing models is part of the Pro and Team plans.", "feature_not_in_plan")
    except UnknownModelError as exc:
        raise HTTPException(404, str(exc)) from exc
    except PlanError as exc:
        raise _plan_error(exc) from exc
    except BudgetExceededError as exc:
        raise HTTPException(402, {"message": str(exc), "code": "platform_budget"}) from exc

    text = body.message.strip()
    if body.ephemeral:
        conv = Conversation(id=new_id("cmp"), org_id=p.org_id, user_id=p.user_id, model_id=model.id)
    elif body.conversation_id:
        conv = _own_conversation(p, a, body.conversation_id)
    else:
        conv = Conversation(org_id=p.org_id, user_id=p.user_id, model_id=model.id)
    is_first = not conv.messages

    user_msg = StoredMessage(role="user", content=text)
    history = _history(conv) + [Message(role="user", content=text)]
    conv.model_id = model.id
    conv.messages.append(user_msg)
    conv.updated_at = utcnow()

    def save() -> None:
        # Only saved once pre-request skills have run, so a blocked value is
        # masked before it's ever written down.
        if is_first:
            conv.title = _safe_title(user_msg.content, user_msg.marks)
        if not body.ephemeral:
            a.storage.put_conversation(conv)

    async def events():
        yield _sse("conversation", {"conversation_id": conv.id, "user_message_id": user_msg.id})
        async for ev in a.gateway.run(p, conv.id, model.id, history, ephemeral=body.ephemeral):
            if isinstance(ev, Started):
                user_msg.marks = ev.prompt_marks
                save()
                yield _sse("start", {
                    "trace_id": ev.trace_id,
                    "model": ev.model.model_dump(),
                    "context": ev.context.model_dump(),
                    "prompt_marks": [f.model_dump() for f in ev.prompt_marks],
                    "pipeline": [s.model_dump() for s in ev.pipeline],
                })
            elif isinstance(ev, Delta):
                yield _sse("delta", {"text": ev.text})
            elif isinstance(ev, (Finished, Failed)):
                user_msg.marks = ev.prompt_marks
                if isinstance(ev, Finished):
                    reply = StoredMessage(role="assistant", content=ev.content, model_id=model.id,
                                          trace_id=ev.trace.id, marks=ev.reply_marks)
                else:
                    reply = StoredMessage(role="assistant", content=ev.content, model_id=model.id,
                                          trace_id=ev.trace.id, status="blocked" if ev.blocked else "error",
                                          error=ev.message)
                    # Keep failed turns out of future history so a retry starts clean.
                    user_msg.status = reply.status
                    if ev.blocked:
                        user_msg.content = _mask_blocked(user_msg.content, ev.prompt_marks)
                        user_msg.marks = [f for f in ev.prompt_marks if f.action != "block"]
                conv.messages.append(reply)
                conv.updated_at = utcnow()
                save()
                payload = {
                    "trace": ev.trace.model_dump(mode="json"),
                    "message": reply.model_dump(mode="json"),
                    "user_message": user_msg.model_dump(mode="json"),
                }
                if isinstance(ev, Finished):
                    yield _sse("done", payload)
                else:
                    yield _sse("error", {**payload, "error": ev.message, "blocked": ev.blocked})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---- skills ------------------------------------------------------------------------


def _skills_view(p: Principal, a: App) -> dict[str, Any]:
    resolved = a.skill_settings(p)
    user = a.storage.get_settings("user", p.user_id)
    can_admin = p.role == "admin" and a.billing.has_feature(p.org_id, "workspace_policy")
    return {
        "skills": [
            {
                "manifest": s.manifest.model_dump(),
                "resolved": resolved[s.manifest.id].model_dump(),
                "user": user.get(s.manifest.id, {}),
            }
            for s in SKILLS
        ],
        "pii": {
            "entities": [e.__dict__ for e in ENTITIES],
            "presets": {k: {"name": v["name"], "description": v["description"], "policy": v["policy"]}
                        for k, v in PRESETS.items()},
        },
        "can_admin": can_admin,
        "workspace_policy_available": a.billing.has_feature(p.org_id, "workspace_policy"),
    }


@app.get("/api/skills")
def list_skills(p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    return _skills_view(p, a)


class SkillPatch(BaseModel):
    enabled: bool | None = None
    config: dict[str, Any] | None = None
    locked: list[Literal["enabled", "config"]] | None = None
    reset: bool = False


def _apply_patch(scope: str, scope_id: str, skill_id: str, body: SkillPatch, a: App) -> None:
    skill = SKILL_BY_ID.get(skill_id)
    if not skill:
        raise HTTPException(404, "Unknown skill")
    data = a.storage.get_settings(scope, scope_id)
    if body.reset:
        data.pop(skill_id, None)
    else:
        patch = body.model_dump(exclude_none=True, exclude={"reset"})
        try:
            clean = validate_patch(skill, patch)
        except SettingsError as exc:
            raise HTTPException(400, str(exc)) from exc
        entry = data.get(skill_id, {})
        if "config" in clean:
            entry["config"] = {**entry.get("config", {}), **clean.pop("config")}
        entry.update(clean)
        data[skill_id] = entry
    a.storage.put_settings(scope, scope_id, data)


@app.patch("/api/skills/{skill_id}")
def patch_skill(skill_id: str, body: SkillPatch, p: Principal = Depends(current_principal),
                a: App = Depends(get_app)):
    if body.locked is not None:
        raise HTTPException(400, "Locks are set in workspace policy.")
    resolved = a.skill_settings(p).get(skill_id)
    if resolved:
        if body.enabled is not None and "enabled" in resolved.locked:
            raise HTTPException(403, "Your workspace requires this setting.")
        if body.config is not None and "config" in resolved.locked:
            raise HTTPException(403, "Your workspace requires this setting.")
    _apply_patch("user", p.user_id, skill_id, body, a)
    return _skills_view(p, a)


@app.patch("/api/workspace/skills/{skill_id}")
def patch_workspace_skill(skill_id: str, body: SkillPatch, p: Principal = Depends(current_principal),
                          a: App = Depends(get_app)):
    if p.role != "admin":
        raise HTTPException(403, "Only workspace admins can change workspace policy.")
    if not a.billing.has_feature(p.org_id, "workspace_policy"):
        raise _plan_error(PlanError("Workspace policies are part of the Team plan.", "feature_not_in_plan"))
    _apply_patch("org", p.org_id, skill_id, body, a)
    return _skills_view(p, a)


class ScanRequest(BaseModel):
    text: str = Field(max_length=200_000)


@app.post("/api/pii/scan")
def pii_scan(body: ScanRequest, p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    resolved = a.skill_settings(p)["pii-redaction"]
    if not resolved.enabled:
        return {"enabled": False, "findings": []}
    config = PiiConfig(**resolved.config)
    findings = scan(body.text, effective_policy(config), active_detectors(config))
    return {"enabled": True, "findings": [f.model_dump() for f in findings]}


# ---- usage ---------------------------------------------------------------------


@app.get("/api/usage")
def usage(days: int = Query(30, ge=1, le=365), p: Principal = Depends(current_principal),
          a: App = Depends(get_app)):
    now = datetime.now(timezone.utc)
    start = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    traces = a.storage.list_traces(p.org_id, user_id=p.user_id, since=start)
    models = {m.id: m for m in a.gateway.models()}

    daily: dict[str, dict[str, float]] = {
        (start + timedelta(days=i)).date().isoformat(): defaultdict(float) for i in range(days)
    }
    by_model: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    totals: dict[str, float] = defaultdict(float)
    privacy: dict[str, float] = defaultdict(float)
    privacy_kinds: dict[str, int] = defaultdict(int)
    for t in traces:
        r = t.response
        day = t.created_at.date().isoformat()
        live = models.get(t.model).live if t.model in models else False
        if day in daily:
            daily[day][t.model] += r.cost.total_usd
        bm = by_model[t.model]
        bm["messages"] += 1
        bm["cost_usd"] += r.cost.total_usd
        bm["input_tokens"] += r.usage.total_input_tokens
        bm["output_tokens"] += r.usage.output_tokens
        bm["total_ms"] += r.timing.total_ms
        bm["ttft_ms"] += r.timing.time_to_first_token_ms
        totals["messages"] += 1
        totals["cost_usd"] += r.cost.total_usd
        totals["live_cost_usd"] += r.cost.total_usd if live else 0
        totals["input_tokens"] += r.usage.total_input_tokens
        totals["output_tokens"] += r.usage.output_tokens
        totals["cache_read_tokens"] += r.usage.cache_read_tokens
        totals["cache_saved_usd"] += max(r.cost.uncached_usd - r.cost.total_usd, 0) if r.cost.uncached_usd else 0
        totals["charged_usd"] += t.charged_usd
        if r.finish_reason == "blocked":
            privacy["blocked_messages"] += 1
        for step in t.pipeline:
            if step.skill_id == "pii-redaction":
                for f in step.findings:
                    privacy[f"{f.action}"] += 1
                    privacy_kinds[f.label] += 1
            if step.skill_id == "response-scan" and step.findings:
                privacy["reply_flags"] += len(step.findings)

    model_rows = []
    for mid, v in sorted(by_model.items(), key=lambda kv: -kv[1]["cost_usd"]):
        m = models.get(mid)
        n = v["messages"] or 1
        model_rows.append({
            "model_id": mid,
            "name": m.name if m else mid,
            "provider": m.provider if m else "",
            "live": bool(m and m.live),
            "messages": int(v["messages"]),
            "cost_usd": v["cost_usd"],
            "avg_cost_usd": v["cost_usd"] / n,
            "input_tokens": int(v["input_tokens"]),
            "output_tokens": int(v["output_tokens"]),
            "avg_latency_ms": int(v["total_ms"] / n),
            "avg_ttft_ms": int(v["ttft_ms"] / n),
        })
    top = sorted(traces, key=lambda t: -t.response.cost.total_usd)[:5]
    return {
        "days": days,
        "daily": [{"date": d, "by_model": dict(v), "total_usd": sum(v.values())} for d, v in daily.items()],
        "by_model": model_rows,
        "totals": dict(totals),
        "privacy": {**privacy, "by_kind": dict(sorted(privacy_kinds.items(), key=lambda kv: -kv[1]))},
        "top_messages": [
            {
                "trace_id": t.id,
                "conversation_id": t.conversation_id,
                "model_id": t.model,
                "cost_usd": t.response.cost.total_usd,
                "input_tokens": t.response.usage.total_input_tokens,
                "created_at": t.created_at,
                "ephemeral": t.ephemeral,
            }
            for t in top
            if t.response.cost.total_usd > 0
        ],
    }


# ---- billing -------------------------------------------------------------------


@app.get("/api/billing")
def billing(p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    return {
        **a.billing.summary(p.org_id),
        "plans": [pl.model_dump() | {"sift_fee_usd": pl.sift_fee_usd} for pl in PLANS.values()],
        "topups": {"amounts": TOPUP_AMOUNTS, "fee": TOPUP_FEE},
        "ledger": a.storage.list_ledger(p.org_id, 30),
    }


class CheckoutRequest(BaseModel):
    plan_id: str | None = None
    topup_usd: float | None = None
    seats: int = Field(1, ge=1, le=500)


@app.post("/api/billing/checkout")
def checkout(body: CheckoutRequest, p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    if p.role != "admin":
        raise HTTPException(403, "Only workspace admins can change the plan.")
    try:
        return a.billing.start_checkout(p.org_id, plan_id=body.plan_id, topup_usd=body.topup_usd, seats=body.seats)
    except PlanError as exc:
        raise HTTPException(400, {"message": str(exc), "code": exc.code}) from exc


@app.post("/api/billing/checkout/{checkout_id}/complete")
def complete_checkout(checkout_id: str, p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    try:
        a.billing.complete_checkout(p.org_id, checkout_id)
    except PaymentError as exc:
        raise HTTPException(400, {"message": str(exc), "code": "checkout"}) from exc
    return billing(p, a)
