from __future__ import annotations

from app.skills.base import BaseSkill, SkillManifest


class SecureFolderSkill(BaseSkill):
    """Not a request step: it controls whether chats can be moved into the
    PIN-protected secure folder (see app/secure.py). Listed with the other
    skills so it can be switched off, or locked on by a workspace admin."""

    manifest = SkillManifest(
        id="secure-folder",
        name="Secure folder",
        summary="Hide chosen chats behind a PIN, out of the sidebar and activity.",
        description=(
            "Adds a Secure folder under your chats. Chats you move there are hidden from the sidebar, "
            "and show only as \"Secure chat\" in usage and billing, until you enter your PIN. Useful "
            "when you share your screen. It's a privacy screen, not encryption: the chats are stored "
            "like any other. Turning this off never reveals chats already in the folder."
        ),
        category="Privacy",
        stages=[],
        can_modify_request=False,
    )
