"""Reversible redaction.

`john@acme.com` becomes `[EMAIL_1]` before anything leaves Sift. The mapping
lives in a per-conversation vault, so:

* the same value always gets the same placeholder across turns (the model can
  still reason about "EMAIL_1" consistently), and
* placeholders in the model's reply are swapped back to the real values
  before the user sees them, even mid-stream.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.schema import Finding, Message, PiiAction
from app.skills.pii.detectors import Detector, Span
from app.skills.pii.entities import ENTITIES, ENTITY_BY_KIND, Policy

_PRIORITY = {e.kind: i for i, e in enumerate(ENTITIES)}
PLACEHOLDER_RE = re.compile(r"\[([A-Z_]+)_(\d+)\]")


@dataclass
class Vault:
    """value <-> placeholder for one conversation."""

    by_value: dict[str, str] = field(default_factory=dict)
    by_placeholder: dict[str, str] = field(default_factory=dict)

    @staticmethod
    def _key(kind: str, value: str) -> str:
        v = value.strip()
        if kind in ("EMAIL",):
            v = v.lower()
        if kind in ("CREDIT_CARD", "PHONE", "SSN", "IBAN"):
            v = re.sub(r"[\s\-().+]", "", v)
        return f"{kind}:{v}"

    def placeholder_for(self, kind: str, value: str) -> str:
        key = self._key(kind, value)
        if key not in self.by_value:
            n = sum(1 for k in self.by_value if k.startswith(f"{kind}:")) + 1
            ph = f"[{kind}_{n}]"
            self.by_value[key] = ph
            self.by_placeholder[ph] = value
        return self.by_value[key]

    def to_dict(self) -> dict[str, str]:
        return dict(self.by_placeholder)

    @classmethod
    def from_dict(cls, data: dict[str, str]) -> "Vault":
        v = cls()
        for ph, value in data.items():
            m = PLACEHOLDER_RE.fullmatch(ph)
            if not m:
                continue
            v.by_placeholder[ph] = value
            v.by_value[cls._key(m.group(1), value)] = ph
        return v


def mask(kind: str, value: str) -> str:
    """A safe-to-display hint of what was found. Never the full value."""
    v = value.strip()
    digits = re.sub(r"\D", "", v)
    if kind == "EMAIL" and "@" in v:
        local, domain = v.split("@", 1)
        return f"{local[:1]}•••@{domain}"
    if kind in ("CREDIT_CARD", "IBAN"):
        return f"•••• {re.sub(r'[^A-Za-z0-9]', '', v)[-4:]}"
    if kind == "SSN":
        return f"•••-••-{digits[-4:]}"
    if kind == "PHONE":
        return f"•••-•••-{digits[-4:]}"
    if kind in ("API_KEY", "AWS_ACCESS_KEY"):
        return f"{v[:6]}••••"
    if kind == "PRIVATE_KEY":
        return "-----BEGIN … KEY-----"
    if kind == "PERSON":
        return " ".join(f"{w[:1]}•••" for w in v.split())
    if kind == "IP_ADDRESS":
        return f"{v.split('.')[0]}.•••.•••.•••"
    return f"{v[:1]}•••" if len(v) > 1 else "•"


def resolve_overlaps(spans: list[Span]) -> list[Span]:
    """Keep the strongest span where detectors overlap: secrets beat contact
    details, longer beats shorter."""
    ordered = sorted(spans, key=lambda s: (_PRIORITY.get(s.kind, 99), -(s.end - s.start), s.start))
    kept: list[Span] = []
    for s in ordered:
        if all(s.end <= k.start or s.start >= k.end for k in kept):
            kept.append(s)
    return sorted(kept, key=lambda s: s.start)


def detect(text: str, detectors: list[Detector]) -> list[Span]:
    spans: list[Span] = []
    for d in detectors:
        spans.extend(d.detect(text))
    return resolve_overlaps(spans)


@dataclass
class RedactionResult:
    messages: list[Message]
    findings: list[Finding]
    blocked: list[Finding]


def _finding(span: Span, action: PiiAction, idx: int | None, placeholder: str | None) -> Finding:
    entity = ENTITY_BY_KIND.get(span.kind)
    return Finding(
        kind=span.kind,
        label=entity.label if entity else span.kind,
        action=action,
        placeholder=placeholder,
        preview=mask(span.kind, span.text),
        message_index=idx,
        start=span.start,
        end=span.end,
        detector=span.detector,
    )


def scan(text: str, policy: Policy, detectors: list[Detector]) -> list[Finding]:
    """Findings for one piece of text, without changing it (live preview)."""
    return [
        _finding(s, policy.get(s.kind, "allow"), None, None)
        for s in detect(text, detectors)
        if policy.get(s.kind, "allow") != "allow"
    ]


def redact_messages(
    messages: list[Message], policy: Policy, detectors: list[Detector], vault: Vault
) -> RedactionResult:
    out: list[Message] = []
    findings: list[Finding] = []
    blocked: list[Finding] = []
    for idx, msg in enumerate(messages):
        if msg.role == "system":
            out.append(msg)
            continue
        text = msg.content
        pieces: list[str] = []
        cursor = 0
        for span in detect(text, detectors):
            action = policy.get(span.kind, "allow")
            if action == "allow":
                continue
            # Placeholders for blocked values too, so even a blocked request's
            # log never contains the secret.
            ph = vault.placeholder_for(span.kind, span.text) if action in ("redact", "block") else None
            f = _finding(span, action, idx, ph)
            findings.append(f)
            if action == "block":
                blocked.append(f)
            if ph:
                pieces.append(text[cursor : span.start])
                pieces.append(ph)
                cursor = span.end
        pieces.append(text[cursor:])
        out.append(Message(role=msg.role, content="".join(pieces), images=msg.images))
    return RedactionResult(out, findings, blocked)


def restore(text: str, vault: Vault) -> str:
    return PLACEHOLDER_RE.sub(lambda m: vault.by_placeholder.get(m.group(0), m.group(0)), text)


class StreamRestorer:
    """Swap placeholders back to real values in a streamed reply.

    A placeholder can be split across chunks ("[EMA" + "IL_1]"), so text from
    an unclosed "[" is held back until it either closes or clearly isn't a
    placeholder.
    """

    MAX_HOLD = 32

    def __init__(self, vault: Vault) -> None:
        self._vault = vault
        self._buf = ""
        self._emitted = 0
        # (placeholder, start, end) in the text the user sees
        self.restored: list[tuple[str, int, int]] = []

    def _sub(self, text: str) -> str:
        out: list[str] = []
        cursor = 0
        for m in PLACEHOLDER_RE.finditer(text):
            value = self._vault.by_placeholder.get(m.group(0))
            if value is None:
                continue
            out.append(text[cursor : m.start()])
            start = self._emitted + sum(len(p) for p in out)
            out.append(value)
            self.restored.append((m.group(0), start, start + len(value)))
            cursor = m.end()
        out.append(text[cursor:])
        result = "".join(out)
        self._emitted += len(result)
        return result

    def feed(self, chunk: str) -> str:
        self._buf += chunk
        cut = self._buf.rfind("[")
        if cut != -1 and "]" not in self._buf[cut:] and len(self._buf) - cut <= self.MAX_HOLD:
            ready, self._buf = self._buf[:cut], self._buf[cut:]
        else:
            ready, self._buf = self._buf, ""
        return self._sub(ready)

    def flush(self) -> str:
        ready, self._buf = self._buf, ""
        return self._sub(ready)
