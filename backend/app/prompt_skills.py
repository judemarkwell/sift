"""User-made prompt skills: reusable tasks that start a chat with the right
instructions, collect the details they need, and keep those instructions in
place for every turn of that chat.
"""

from __future__ import annotations

import re

from app.schema import PromptSkill, SkillField

ICONS = ["sparkles", "mail", "file-text", "list-checks", "code", "graduation-cap", "briefcase", "megaphone",
         "search", "pen", "calendar", "bug"]


def skill_note(skill: PromptSkill) -> str:
    """The system instructions for a chat running this skill."""
    asks = ""
    if skill.ask_for_missing and skill.fields:
        needed = ", ".join(f.label for f in skill.fields if f.required) or ", ".join(f.label for f in skill.fields)
        asks = (
            f"\n\nThis skill works from these details: {', '.join(f.label for f in skill.fields)}. "
            f"If anything essential ({needed}) is missing or unclear, ask for it in one short message "
            "before doing the task, rather than guessing."
        )
    return (
        f'You are running the user\'s saved skill "{skill.name}". Follow its instructions for this whole '
        f"conversation, including follow-up messages.\n\nInstructions:\n{skill.instructions.strip()}{asks}"
    )


_VAR = re.compile(r"\{\{\s*([a-z][a-z0-9_]*)\s*\}\}")


def first_message(skill: PromptSkill, values: dict[str, str], extra: str = "") -> str:
    """The opening message: the starter with fields filled in, then any
    details not already used, as a list. Values go in the user's message
    (not the system prompt) so PII redaction sees them."""
    values = {k: v.strip() for k, v in values.items() if v and v.strip()}
    used: set[str] = set()

    def fill(m: re.Match[str]) -> str:
        key = m.group(1)
        if key in values:
            used.add(key)
            return values[key]
        label = next((f.label for f in skill.fields if f.key == key), key)
        return f"[{label}: not given]"

    starter = _VAR.sub(fill, skill.starter).strip() if skill.starter else f"Let's do: {skill.name}."
    rest = [f for f in skill.fields if f.key in values and f.key not in used]
    parts = [starter]
    if rest:
        lines = []
        for f in rest:
            v = values[f.key]
            lines.append(f"**{f.label}:**\n{v}" if "\n" in v else f"**{f.label}:** {v}")
        parts.append("\n".join(lines))
    if extra.strip():
        parts.append(extra.strip())
    return "\n\n".join(parts)


def _f(key: str, label: str, placeholder: str = "", required: bool = False, multiline: bool = False) -> SkillField:
    return SkillField(key=key, label=label, placeholder=placeholder, required=required, multiline=multiline)


# Starting points users can add with one click, then edit.
TEMPLATES: list[dict] = [
    {
        "name": "Weekly status update",
        "description": "Turn rough notes into a clear update for your manager.",
        "icon": "briefcase",
        "instructions": (
            "Write a concise weekly status update from the user's notes. Structure: Done this week, "
            "In progress, Blockers (with what's needed to unblock), Next week. Keep each bullet to one line, "
            "lead with outcomes rather than activity, and don't invent work that isn't in the notes."
        ),
        "fields": [
            _f("notes", "What happened this week", "Rough notes, bullets, anything", True, True),
            _f("audience", "Who it's for", "e.g. my manager, the whole team"),
        ],
        "starter": "Here are my notes for this week's status update:\n\n{{notes}}",
        "styles": ["bullets"],
    },
    {
        "name": "Reply to an email",
        "description": "Draft a reply in the tone you choose.",
        "icon": "mail",
        "instructions": (
            "Draft a reply to the email the user pastes. Match the tone they ask for, answer every question "
            "the sender asked, and propose a clear next step. Give a subject line if it's a new thread. "
            "Offer one alternative phrasing only for the trickiest sentence."
        ),
        "fields": [
            _f("email", "The email you received", "Paste it here", True, True),
            _f("goal", "What you want to say", "e.g. politely decline, ask for a week's extension", True),
            _f("tone", "Tone", "e.g. warm, firm, brief"),
        ],
        "starter": "Help me reply to this email. I want to: {{goal}}\n\n---\n{{email}}",
        "styles": [],
    },
    {
        "name": "Meeting notes to actions",
        "description": "Pull decisions, owners and deadlines out of messy notes.",
        "icon": "list-checks",
        "instructions": (
            "From the meeting notes, extract: Decisions made; Action items as a table with Owner, Task and "
            "Due date (write 'unassigned' or 'no date' rather than guessing); Open questions. "
            "Finish with a two-sentence summary someone who missed the meeting could read."
        ),
        "fields": [_f("notes", "Meeting notes or transcript", "", True, True)],
        "starter": "Turn these meeting notes into actions:\n\n{{notes}}",
        "styles": ["table"],
    },
    {
        "name": "Step-by-step job aid",
        "description": "Write a how-to guide for a task in a business system.",
        "icon": "file-text",
        "instructions": (
            "Write a job aid: a step-by-step guide that a new employee could follow without help. Include "
            "a one-line purpose, who it's for, prerequisites (access, information needed), numbered steps "
            "that each name the exact screen, field or button, notes on common mistakes, and what 'done' "
            "looks like. Mark where a screenshot would help with [Screenshot: description]."
        ),
        "fields": [
            _f("task", "The task", "e.g. Submit a time-off request in Workday", True),
            _f("system", "System or tool", "e.g. Workday, SAP, Salesforce"),
            _f("details", "Steps or notes you already have", "Optional", False, True),
        ],
        "starter": "Write a job aid for this task: {{task}}",
        "styles": ["steps"],
    },
    {
        "name": "Code review",
        "description": "Review code for bugs, security and clarity.",
        "icon": "code",
        "instructions": (
            "Review the code like a senior engineer. List issues in order of severity: bugs and security "
            "problems first, then correctness edge cases, then readability. For each, quote the line, explain "
            "the problem in one sentence, and show the fix. Say clearly if the code looks good."
        ),
        "fields": [
            _f("code", "Code", "Paste the code or diff", True, True),
            _f("context", "What it's supposed to do", ""),
        ],
        "starter": "Please review this code.\n\n```\n{{code}}\n```",
        "styles": [],
    },
    {
        "name": "Study tutor",
        "description": "Learn a topic step by step, then get quizzed.",
        "icon": "graduation-cap",
        "instructions": (
            "Act as a patient tutor. Teach the topic in small steps, checking understanding after each one "
            "with a single question. Adapt to the user's level. When they ask, quiz them and explain any "
            "wrong answers."
        ),
        "fields": [
            _f("topic", "Topic", "e.g. how DynamoDB partition keys work", True),
            _f("level", "Your level", "e.g. beginner, I know the basics"),
        ],
        "starter": "Teach me about {{topic}}. My level: {{level}}.",
        "styles": ["explain"],
    },
]
