"""Skill registry and layered settings.

Settings resolve in three layers:

    system defaults (from each manifest)
      -> workspace policy (set by an admin; can LOCK enabled and/or config)
        -> user preference (ignored for anything the workspace locked)

So one app serves both an individual (org of one, nothing locked) and a team
whose admin requires PII redaction for everyone.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from app.skills.base import Skill
from app.skills.builtin import (
    ContextTrimmerSkill,
    CostMeterSkill,
    PromptCacheSkill,
    ResponseScanSkill,
    SpendGuardSkill,
)
from app.skills.pii.skill import PiiRedactionSkill
from app.skills.secure_folder import SecureFolderSkill

# Order matters. Before sending: trim first (less to scan), then redact, then
# estimate cost on what will actually be sent. After: price the reply first,
# since later skills read the cost.
SKILLS: list[Skill] = [
    ContextTrimmerSkill(),
    PiiRedactionSkill(),
    SpendGuardSkill(),
    CostMeterSkill(),
    PromptCacheSkill(),
    ResponseScanSkill(),
    SecureFolderSkill(),  # no request stage; an app feature with skill-style settings
]
SKILL_BY_ID: dict[str, Skill] = {s.manifest.id: s for s in SKILLS}

LOCKABLE_FIELDS = ("enabled", "config")


class SettingsError(ValueError):
    pass


class ResolvedSkill(BaseModel):
    id: str
    enabled: bool
    config: dict[str, Any]
    locked: list[str]  # which of LOCKABLE_FIELDS the workspace enforces
    workspace: dict[str, Any]  # the workspace layer, for the admin view


def _merge_config(skill: Skill, *layers: dict[str, Any] | None) -> dict[str, Any]:
    merged: dict[str, Any] = skill.Config().model_dump()
    for layer in layers:
        if layer:
            merged.update(layer)
    return skill.Config(**merged).model_dump()


def resolve(skill: Skill, org_layer: dict | None, user_layer: dict | None) -> ResolvedSkill:
    m = skill.manifest
    org_layer = org_layer or {}
    user_layer = user_layer or {}
    locked = [f for f in org_layer.get("locked", []) if f in LOCKABLE_FIELDS] if m.lockable else []

    enabled = m.default_enabled
    if "enabled" in org_layer:
        enabled = bool(org_layer["enabled"])
    if "enabled" in user_layer and "enabled" not in locked:
        enabled = bool(user_layer["enabled"])
    if m.core:
        enabled = True

    user_config = None if "config" in locked else user_layer.get("config")
    try:
        config = _merge_config(skill, org_layer.get("config"), user_config)
    except Exception:
        # A stored value that no longer validates must never break chat.
        config = _merge_config(skill, org_layer.get("config"))
    return ResolvedSkill(id=m.id, enabled=enabled, config=config, locked=locked, workspace=org_layer)


def validate_patch(skill: Skill, patch: dict[str, Any]) -> dict[str, Any]:
    """Check a settings change before it's stored."""
    clean: dict[str, Any] = {}
    if "enabled" in patch:
        if skill.manifest.core and not patch["enabled"]:
            raise SettingsError(f"{skill.manifest.name} is always on.")
        clean["enabled"] = bool(patch["enabled"])
    if "config" in patch:
        if not isinstance(patch["config"], dict):
            raise SettingsError("config must be an object")
        try:
            validated = skill.Config(**patch["config"]).model_dump()
        except Exception as exc:
            raise SettingsError(f"Invalid settings for {skill.manifest.name}: {exc}") from exc
        # Store only the keys the caller sent, in their validated form.
        clean["config"] = {k: v for k, v in validated.items() if k in patch["config"]}
    if "locked" in patch:
        locked = [f for f in patch["locked"] if f in LOCKABLE_FIELDS]
        if locked and not skill.manifest.lockable:
            raise SettingsError(f"{skill.manifest.name} can't be locked.")
        clean["locked"] = locked
    return clean
