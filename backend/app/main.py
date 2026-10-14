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

from fastapi import Depends, FastAPI, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from app.auth import current_principal
from app.billing.payments import PaymentError
from app.billing.plans import PLANS, TOPUP_AMOUNTS, TOPUP_FEE
from app.billing.service import PlanError
from app.deps import App
from app.images import MAX_UPLOAD_BYTES, ImageError
from app.images import process as process_image
from app.prompt_skills import ICONS, TEMPLATES, first_message, skill_note
from app.providers.base import CONTINUE_PROMPT
from app.styles import STYLE_BY_ID, STYLES, parse_styles
from app.gateway import BudgetExceededError, Delta, Failed, Finished, Started, UnknownModelError
from app.report import conversation_report
from app.schema import (
    Conversation,
    ConversationSummary,
    Finding,
    ImageRef,
    Message,
    ModelInfo,
    Principal,
    PromptSkill,
    SkillField,
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

MAX_IMAGES_PER_MESSAGE = 4

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
        skill_name=conv.skill_name,
    )


@app.get("/api/conversations", response_model=list[ConversationSummary])
def list_conversations(p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    _enforce_retention(p, a)
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
    message: str = Field("", max_length=200_000)
    ephemeral: bool = Field(False, description="Compare mode: run once, don't save to a conversation")
    styles: list[str] = Field(default_factory=list, max_length=6)
    image_ids: list[str] = Field(default_factory=list, max_length=MAX_IMAGES_PER_MESSAGE)
    # Start a new chat from a saved prompt skill, with its fields filled in.
    skill_id: str | None = None
    skill_values: dict[str, str] = Field(default_factory=dict)
    # Extend a reply that was cut off at its length limit.
    continue_message_id: str | None = None


def _history(conv: Conversation) -> list[Message]:
    return [
        Message(role=m.role, content=m.content, images=m.attachments)
        for m in conv.messages
        if m.status == "done"
    ]


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


def _sse_response(gen) -> StreamingResponse:
    return StreamingResponse(
        gen, media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


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
    _enforce_retention(p, a)

    if body.continue_message_id:
        conv, target = _continue_target(body, p, a)
        return _sse_response(_continue(conv, target, p, a, model))

    # Conversation
    skill: PromptSkill | None = None
    if body.ephemeral:
        conv = Conversation(id=new_id("cmp"), org_id=p.org_id, user_id=p.user_id, model_id=model.id)
    elif body.conversation_id:
        conv = _own_conversation(p, a, body.conversation_id)
    else:
        conv = Conversation(org_id=p.org_id, user_id=p.user_id, model_id=model.id)
        if body.skill_id:
            skill = _visible_skill(p, a, body.skill_id)
            conv.skill_id, conv.skill_name = skill.id, skill.name
            conv.skill_note = skill_note(skill)
            skill.use_count += 1
            a.storage.put_prompt_skill(skill)
    is_first = not conv.messages

    # Message text, styles and images
    raw = first_message(skill, body.skill_values, body.message) if skill else body.message
    text, typed_styles = parse_styles(raw)
    styles = list(dict.fromkeys([*body.styles, *typed_styles, *(skill.styles if skill else [])]))
    styles = [s for s in styles if s in STYLE_BY_ID]
    images = []
    for image_id in body.image_ids:
        meta = a.storage.get_upload(p.org_id, image_id)
        if not meta or meta["user_id"] != p.user_id:
            raise HTTPException(404, "That image is no longer available. Attach it again.")
        images.append(ImageRef(**{k: meta[k] for k in ("id", "media_type", "width", "height", "tokens")}))
    if images and not model.vision:
        raise HTTPException(400, f"{model.name} can't read images. Pick another model.")
    if not text and not images:
        if styles:
            text = "Go ahead."
        else:
            raise HTTPException(400, "Type a message first.")

    user_msg = StoredMessage(role="user", content=text, styles=styles, attachments=images)
    history = _history(conv) + [Message(role="user", content=text, images=images)]
    conv.model_id = model.id
    conv.messages.append(user_msg)
    conv.updated_at = utcnow()

    def save() -> None:
        # Only saved once pre-request skills have run, so a blocked value is
        # masked before it's ever written down.
        if is_first:
            conv.title = conv.skill_name or _safe_title(user_msg.content, user_msg.marks)
        if not body.ephemeral:
            a.storage.put_conversation(conv)

    async def events():
        yield _sse("conversation", {"conversation_id": conv.id, "user_message_id": user_msg.id,
                                    "styles": styles, "skill_name": conv.skill_name})
        run = a.gateway.run(p, conv.id, model.id, history, ephemeral=body.ephemeral, styles=styles,
                            skill_name=conv.skill_name, skill_note=conv.skill_note)
        async for ev in run:
            if isinstance(ev, Started):
                user_msg.marks = ev.prompt_marks
                save()
                yield _sse("start", _start_payload(ev))
            elif isinstance(ev, Delta):
                yield _sse("delta", {"text": ev.text})
            elif isinstance(ev, (Finished, Failed)):
                user_msg.marks = ev.prompt_marks
                if isinstance(ev, Finished):
                    reply = StoredMessage(role="assistant", content=ev.content, model_id=model.id,
                                          trace_id=ev.trace.id, marks=ev.reply_marks,
                                          truncated=ev.trace.response.finish_reason == "length")
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

    return _sse_response(events())


def _start_payload(ev: Started) -> dict[str, Any]:
    return {
        "trace_id": ev.trace_id,
        "model": ev.model.model_dump(),
        "context": ev.context.model_dump(),
        "prompt_marks": [f.model_dump() for f in ev.prompt_marks],
        "pipeline": [s.model_dump() for s in ev.pipeline],
    }


def _continue_target(body: ChatRequest, p: Principal, a: App) -> tuple[Conversation, StoredMessage]:
    if not body.conversation_id:
        raise HTTPException(400, "Continue needs a conversation.")
    conv = _own_conversation(p, a, body.conversation_id)
    target = conv.messages[-1] if conv.messages else None
    if not target or target.id != body.continue_message_id or target.role != "assistant" or not target.truncated:
        raise HTTPException(409, "Only the latest reply can be continued, and only if it was cut off.")
    return conv, target


async def _continue(conv: Conversation, target: StoredMessage, p: Principal, a: App, model: ModelInfo):
    """Continue a reply that hit its length limit, appending to the same message."""
    history = _history(conv) + [Message(role="user", content=CONTINUE_PROMPT)]
    prev_user = next((m for m in reversed(conv.messages) if m.role == "user"), None)
    styles = prev_user.styles if prev_user else []

    yield _sse("conversation", {"conversation_id": conv.id, "user_message_id": None, "continuing": target.id})
    run = a.gateway.run(p, conv.id, model.id, history, styles=styles, skill_name=conv.skill_name,
                        skill_note=conv.skill_note, continuation=True)
    async for ev in run:
        if isinstance(ev, Started):
            yield _sse("start", _start_payload(ev))
        elif isinstance(ev, Delta):
            yield _sse("delta", {"text": ev.text})
        elif isinstance(ev, Finished):
            offset = len(target.content)
            target.marks += [f.model_copy(update={"start": (f.start or 0) + offset, "end": (f.end or 0) + offset})
                             for f in ev.reply_marks]
            target.content += ev.content
            if target.trace_id:
                target.previous_trace_ids.append(target.trace_id)
            target.trace_id = ev.trace.id
            target.truncated = ev.trace.response.finish_reason == "length"
            target.model_id = model.id
            conv.updated_at = utcnow()
            a.storage.put_conversation(conv)
            yield _sse("done", {"trace": ev.trace.model_dump(mode="json"), "message": target.model_dump(mode="json"),
                                "user_message": None})
        elif isinstance(ev, Failed):
            # The partial reply stays as it was; nothing is appended.
            yield _sse("error", {"trace": ev.trace.model_dump(mode="json"), "message": target.model_dump(mode="json"),
                                 "user_message": None, "error": ev.message, "blocked": ev.blocked})


@app.get("/api/styles")
def list_styles() -> list[dict[str, Any]]:
    return [
        {"id": s.id, "label": s.label, "group": s.group, "description": s.description, "max_tokens": s.max_tokens}
        for s in STYLES
    ]


# ---- images -------------------------------------------------------------------------


def _image_quota(p: Principal, a: App) -> dict[str, int]:
    acct = a.billing.account(p.org_id)
    start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    used = a.storage.count_uploads_since(p.org_id, start, user_id=p.user_id)
    return {"per_day": acct.plan.images_per_day, "used_today": used,
            "remaining": max(acct.plan.images_per_day - used, 0)}


@app.get("/api/uploads/quota")
def upload_quota(p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    return _image_quota(p, a)


@app.post("/api/uploads")
async def upload_image(file: UploadFile, p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    quota = _image_quota(p, a)
    if quota["remaining"] <= 0:
        plan = a.billing.account(p.org_id).plan
        raise _plan_error(PlanError(
            f"You've used today's {quota['per_day']} image upload{'s' if quota['per_day'] != 1 else ''} on "
            f"{plan.name}. More are available tomorrow, or on a higher plan.", "image_limit"))
    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    try:
        img = process_image(raw)
    except ImageError as exc:
        raise HTTPException(400, str(exc)) from exc
    meta = {
        "id": new_id("img"),
        "org_id": p.org_id,
        "user_id": p.user_id,
        "created_at": utcnow().isoformat(),
        "media_type": img.media_type,
        "width": img.width,
        "height": img.height,
        "tokens": img.tokens,
        "bytes": len(img.data),
        "original": {"width": img.original_width, "height": img.original_height, "bytes": img.original_bytes},
        "resized": (img.width, img.height) != (img.original_width, img.original_height),
        "metadata_removed": img.metadata_removed,
    }
    a.storage.put_upload(meta, img.data)
    return {**meta, "quota": _image_quota(p, a)}


@app.get("/api/uploads/{upload_id}")
def get_upload(upload_id: str, p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    meta = a.storage.get_upload(p.org_id, upload_id)
    if not meta or meta["user_id"] != p.user_id:
        raise HTTPException(404, "Image not found")
    return Response(a.storage.get_upload_bytes(p.org_id, upload_id), media_type=meta["media_type"],
                    headers={"Cache-Control": "private, max-age=86400"})


# ---- prompt skills (user-made) ---------------------------------------------------------------


class PromptSkillIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    description: str = Field("", max_length=200)
    icon: str = "sparkles"
    instructions: str = Field(min_length=1, max_length=8000)
    fields: list[SkillField] = Field(default_factory=list, max_length=12)
    starter: str = Field("", max_length=2000)
    styles: list[str] = Field(default_factory=list, max_length=4)
    model_id: str | None = None
    ask_for_missing: bool = True
    shared: bool = False
    pinned: bool = True


def _visible_skill(p: Principal, a: App, skill_id: str) -> PromptSkill:
    skill = a.storage.get_prompt_skill(p.org_id, skill_id)
    if not skill or (skill.owner_id != p.user_id and not skill.shared):
        raise HTTPException(404, "Skill not found")
    return skill


def _check_skill_in(body: PromptSkillIn, p: Principal, a: App) -> None:
    keys = [f.key for f in body.fields]
    if len(keys) != len(set(keys)):
        raise HTTPException(400, "Each detail needs a different key.")
    if body.icon not in ICONS:
        raise HTTPException(400, "Unknown icon.")
    if any(s not in STYLE_BY_ID for s in body.styles):
        raise HTTPException(400, "Unknown output style.")
    if body.shared and not a.billing.has_feature(p.org_id, "workspace_policy"):
        raise _plan_error(PlanError("Sharing skills with a workspace is part of the Team plan.", "feature_not_in_plan"))


def _prompt_skills_view(p: Principal, a: App) -> dict[str, Any]:
    skills = sorted(a.storage.list_prompt_skills(p.org_id, p.user_id), key=lambda s: (-s.use_count, s.name))
    limit = a.billing.account(p.org_id).plan.prompt_skills
    return {
        "skills": [s.model_dump(mode="json") | {"mine": s.owner_id == p.user_id} for s in skills],
        "templates": [{**t, "fields": [f.model_dump() for f in t["fields"]]} for t in TEMPLATES],
        "icons": ICONS,
        "limit": limit,
        "can_share": a.billing.has_feature(p.org_id, "workspace_policy"),
    }


@app.get("/api/prompt-skills")
def list_prompt_skills(p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    return _prompt_skills_view(p, a)


@app.post("/api/prompt-skills")
def create_prompt_skill(body: PromptSkillIn, p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    _check_skill_in(body, p, a)
    limit = a.billing.account(p.org_id).plan.prompt_skills
    mine = [s for s in a.storage.list_prompt_skills(p.org_id, p.user_id) if s.owner_id == p.user_id]
    if limit is not None and len(mine) >= limit:
        raise _plan_error(PlanError(f"Your plan includes {limit} saved skills. Delete one, or upgrade for unlimited.",
                                    "skill_limit"))
    skill = PromptSkill(org_id=p.org_id, owner_id=p.user_id, **body.model_dump())
    a.storage.put_prompt_skill(skill)
    audit(a, p, "prompt_skill.create", skill.name)
    return skill.model_dump(mode="json") | {"mine": True}


@app.put("/api/prompt-skills/{skill_id}")
def update_prompt_skill(skill_id: str, body: PromptSkillIn, p: Principal = Depends(current_principal),
                        a: App = Depends(get_app)):
    skill = _visible_skill(p, a, skill_id)
    if skill.owner_id != p.user_id:
        raise HTTPException(403, "Only the person who made this skill can change it.")
    _check_skill_in(body, p, a)
    updated = PromptSkill.model_validate({**skill.model_dump(), **body.model_dump(), "updated_at": utcnow()})
    a.storage.put_prompt_skill(updated)
    audit(a, p, "prompt_skill.update", updated.name)
    return updated.model_dump(mode="json") | {"mine": True}


@app.delete("/api/prompt-skills/{skill_id}", status_code=204)
def delete_prompt_skill(skill_id: str, p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    skill = _visible_skill(p, a, skill_id)
    if skill.owner_id != p.user_id and p.role != "admin":
        raise HTTPException(403, "Only the person who made this skill can delete it.")
    a.storage.delete_prompt_skill(p.org_id, skill_id)
    audit(a, p, "prompt_skill.delete", skill.name)


# ---- privacy, data rights and audit ---------------------------------------------------------

RETENTION_CHOICES = (None, 7, 30, 90, 365)


def _privacy_settings(p: Principal, a: App) -> dict[str, Any]:
    return a.storage.get_settings("user", p.user_id).get("_privacy", {"retention_days": None})


def _enforce_retention(p: Principal, a: App) -> None:
    days = _privacy_settings(p, a).get("retention_days")
    if days:
        a.storage.purge_user_before(p.org_id, p.user_id, utcnow() - timedelta(days=days))


def audit(a: App, p: Principal, action: str, target: str = "", **detail: Any) -> None:
    a.storage.add_audit(p.org_id, {"created_at": utcnow().isoformat(), "actor": p.email, "user_id": p.user_id,
                                   "action": action, "target": target, "detail": detail})


@app.get("/api/account/privacy")
def get_privacy(p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    return {**_privacy_settings(p, a), "choices": RETENTION_CHOICES}


class PrivacyPatch(BaseModel):
    retention_days: int | None


@app.patch("/api/account/privacy")
def patch_privacy(body: PrivacyPatch, p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    if body.retention_days not in RETENTION_CHOICES:
        raise HTTPException(400, "Choose 7, 30, 90 or 365 days, or keep everything.")
    data = a.storage.get_settings("user", p.user_id)
    data["_privacy"] = {"retention_days": body.retention_days}
    a.storage.put_settings("user", p.user_id, data)
    audit(a, p, "privacy.retention", str(body.retention_days or "forever"))
    _enforce_retention(p, a)
    return get_privacy(p, a)


@app.get("/api/account/export")
def export_data(p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    """Everything Sift holds about the caller, in one JSON file (data portability)."""
    audit(a, p, "data.export")
    body = {
        "exported_at": utcnow().isoformat(),
        "user": p.model_dump(),
        "conversations": [c.model_dump(mode="json") for c in a.storage.list_conversations(p.org_id, p.user_id, 10_000)],
        "traces": [t.model_dump(mode="json") for t in a.storage.list_traces(p.org_id, user_id=p.user_id)],
        "prompt_skills": [s.model_dump(mode="json") for s in a.storage.list_prompt_skills(p.org_id, p.user_id)
                          if s.owner_id == p.user_id],
        "settings": a.storage.get_settings("user", p.user_id),
        "billing_ledger": a.storage.list_ledger(p.org_id, 10_000),
        "note": "Uploaded images are listed by id inside messages; download them from the app.",
    }
    return Response(json.dumps(body, indent=2, default=str), media_type="application/json",
                    headers={"Content-Disposition": 'attachment; filename="sift-export.json"'})


class DeleteRequest(BaseModel):
    confirm: str


@app.post("/api/account/delete")
def delete_data(body: DeleteRequest, p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    if body.confirm != "DELETE":
        raise HTTPException(400, 'Type DELETE to confirm.')
    counts = a.storage.delete_user_data(p.org_id, p.user_id)
    audit(a, p, "data.delete", "all chats, traces, images and skills", **counts)
    return {"deleted": counts,
            "kept": "Billing records are kept as required for accounting; they hold no message content."}


@app.get("/api/audit")
def audit_log(p: Principal = Depends(current_principal), a: App = Depends(get_app)):
    if p.role != "admin":
        raise HTTPException(403, "Only admins can see the audit log.")
    return a.storage.list_audit(p.org_id, 200)


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
    audit(a, p, "skill.update", skill_id, scope="user", **body.model_dump(exclude_none=True))
    return _skills_view(p, a)


@app.patch("/api/workspace/skills/{skill_id}")
def patch_workspace_skill(skill_id: str, body: SkillPatch, p: Principal = Depends(current_principal),
                          a: App = Depends(get_app)):
    if p.role != "admin":
        raise HTTPException(403, "Only workspace admins can change workspace policy.")
    if not a.billing.has_feature(p.org_id, "workspace_policy"):
        raise _plan_error(PlanError("Workspace policies are part of the Team plan.", "feature_not_in_plan"))
    _apply_patch("org", p.org_id, skill_id, body, a)
    audit(a, p, "workspace_policy.update", skill_id, **body.model_dump(exclude_none=True))
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
        acct = a.billing.complete_checkout(p.org_id, checkout_id)
        audit(a, p, "billing.checkout", acct.plan.name, credit_usd=acct.credit_usd)
    except PaymentError as exc:
        raise HTTPException(400, {"message": str(exc), "code": "checkout"}) from exc
    return billing(p, a)
