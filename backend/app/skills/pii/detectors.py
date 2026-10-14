"""PII detectors.

Two detectors ship today:

* PatternDetector: regular expressions plus validation (Luhn for cards,
  IBAN mod-97, SSN area rules, IPv4 ranges). Runs locally, costs nothing,
  never sends text anywhere.
* ComprehendDetector: the shape of AWS Comprehend's DetectPiiEntities.
  Until AWS is wired up it runs MockComprehendClient, a local heuristic for
  the thing regexes can't do well: people's names. Swap in boto3 later by
  passing a real client.

Both return Spans; the redactor merges overlaps and applies the policy.
"""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Span:
    kind: str
    start: int
    end: int
    text: str
    detector: str
    score: float = 1.0


class Detector(Protocol):
    id: str
    name: str

    def detect(self, text: str) -> list[Span]: ...


# ---- validators -------------------------------------------------------------


def luhn_ok(digits: str) -> bool:
    total, alt = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return total % 10 == 0


def iban_ok(raw: str) -> bool:
    s = re.sub(r"\s+", "", raw).upper()
    if not 15 <= len(s) <= 34:
        return False
    rearranged = s[4:] + s[:4]
    numeric = "".join(str(int(c, 36)) for c in rearranged)
    return int(numeric) % 97 == 1


def ssn_ok(raw: str) -> bool:
    area, group, serial = re.findall(r"\d+", raw)
    if area in ("000", "666") or area.startswith("9"):
        return False
    return group != "00" and serial != "0000"


def ipv4_ok(raw: str) -> bool:
    try:
        ip = ipaddress.IPv4Address(raw)
    except ValueError:
        return False
    # Version-number lookalikes such as 1.2.3.4 are rarely PII.
    return not ip.is_unspecified and raw.count(".") == 3


# ---- pattern detector ---------------------------------------------------------

_PATTERNS: list[tuple[str, re.Pattern[str], object]] = [
    (
        "PRIVATE_KEY",
        re.compile(
            r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"
        ),
        None,
    ),
    (
        "API_KEY",
        re.compile(
            r"\b(?:sk-ant-[A-Za-z0-9_\-]{20,}|sk-(?:proj-)?[A-Za-z0-9_\-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}"
            r"|xox[abposr]-[A-Za-z0-9\-]{10,}|AIza[0-9A-Za-z_\-]{35}|sk_live_[0-9A-Za-z]{20,}"
            r"|rk_live_[0-9A-Za-z]{20,})\b"
        ),
        None,
    ),
    ("AWS_ACCESS_KEY", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), None),
    (
        "PASSWORD",
        re.compile(r"(?i)\b(?:password|passwd|pwd|passcode)\s*(?:is|[:=])\s*(\S{4,})"),
        "group1",
    ),
    ("EMAIL", re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"), None),
    (
        "CREDIT_CARD",
        re.compile(r"\b(?:\d[ \-]?){12,18}\d\b"),
        lambda m: luhn_ok(re.sub(r"\D", "", m)) and 13 <= len(re.sub(r"\D", "", m)) <= 19,
    ),
    (
        "IBAN",
        re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b"),
        iban_ok,
    ),
    ("SSN", re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), ssn_ok),
    (
        "DATE_OF_BIRTH",
        re.compile(
            r"(?i)\b(?:dob|d\.o\.b\.|date of birth|born(?: on)?|birthday(?: is)?)\s*[:\-]?\s*"
            r"((?:\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})|(?:\d{4}-\d{2}-\d{2})"
            r"|(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2},? \d{4}))"
        ),
        "group1",
    ),
    (
        "PHONE",
        re.compile(
            r"(?<![\w-])(?:\+?1[ .\-]?)?\(?\d{3}\)?[ .\-]?\d{3}[ .\-]\d{4}(?![\w-])"
            r"|(?<![\w-])\+\d{1,3}[ .\-]?\d{2,4}[ .\-]\d{3,4}[ .\-]\d{3,4}(?![\w-])"
        ),
        None,
    ),
    (
        "ADDRESS",
        re.compile(
            r"\b\d{1,6}\s+(?:[A-Z][a-z]+\.?\s){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln"
            r"|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Parkway|Pkwy|Circle|Cir)\b\.?"
            r"(?:,?\s*(?:Apt|Suite|Unit|#)\s*[\w\-]+)?"
        ),
        None,
    ),
    ("IP_ADDRESS", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), ipv4_ok),
]


class PatternDetector:
    id = "patterns"
    name = "Built-in patterns"

    def detect(self, text: str) -> list[Span]:
        spans: list[Span] = []
        for kind, pattern, check in _PATTERNS:
            for m in pattern.finditer(text):
                if check == "group1":
                    start, end = m.span(1)
                else:
                    start, end = m.span()
                value = text[start:end]
                if callable(check) and not check(value):
                    continue
                spans.append(Span(kind, start, end, value, self.id))
        return spans


# ---- AWS Comprehend (mocked) ----------------------------------------------------


class ComprehendClient(Protocol):
    def detect_pii_entities(self, Text: str, LanguageCode: str) -> dict: ...


_COMPREHEND_TYPES = {
    "NAME": "PERSON",
    "EMAIL": "EMAIL",
    "PHONE": "PHONE",
    "ADDRESS": "ADDRESS",
    "SSN": "SSN",
    "CREDIT_DEBIT_NUMBER": "CREDIT_CARD",
    "DATE_TIME": "DATE_OF_BIRTH",
    "IP_ADDRESS": "IP_ADDRESS",
    "AWS_ACCESS_KEY": "AWS_ACCESS_KEY",
    "PASSWORD": "PASSWORD",
    "INTERNATIONAL_BANK_ACCOUNT_NUMBER": "IBAN",
}

_NAME_CUES = re.compile(
    r"(?:\b(?:my name is|i am|i'm|this is|named|called|contact|cc|from|dear|hi|hello|thanks,?|regards,?|sincerely,?)\s+"
    r"|\b(?:Mr|Mrs|Ms|Mx|Dr|Prof)\.?\s+)"
    r"((?:[A-Z][a-z'’\-]+)(?:\s+[A-Z][a-z'’\-]+){0,2})",
    re.IGNORECASE,
)
_NOT_NAMES = {
    "I", "The", "A", "An", "Sift", "Claude", "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday", "Sunday", "Team", "Everyone", "All", "There", "Sir", "Madam",
}


class MockComprehendClient:
    """Mimics comprehend.detect_pii_entities() for local development.

    It only adds what the pattern detector can't: names, found from context
    cues ("my name is …", "Dr. …", "Regards, …"). Real Comprehend uses an ML
    model and finds names anywhere.
    """

    def detect_pii_entities(self, Text: str, LanguageCode: str = "en") -> dict:
        entities = []
        for m in _NAME_CUES.finditer(Text):
            name = m.group(1)
            words = name.split()
            # The cue match is case-insensitive, but a name must look like one.
            while words and (words[0] in _NOT_NAMES or not words[0][0].isupper()):
                words = words[1:]
            words = [w for w in words if w[0].isupper()]
            if not words or words[0] in _NOT_NAMES:
                continue
            start = m.start(1) + name.index(words[0])
            text = " ".join(words)
            entities.append(
                {"Type": "NAME", "Score": 0.91, "BeginOffset": start, "EndOffset": start + len(text)}
            )
        return {"Entities": entities}


class ComprehendDetector:
    id = "comprehend"
    name = "AWS Comprehend (mock)"

    def __init__(self, client: ComprehendClient | None = None, min_score: float = 0.8) -> None:
        self._client = client or MockComprehendClient()
        self._min_score = min_score

    def detect(self, text: str) -> list[Span]:
        if not text.strip():
            return []
        result = self._client.detect_pii_entities(Text=text[:100_000], LanguageCode="en")
        spans = []
        for e in result.get("Entities", []):
            kind = _COMPREHEND_TYPES.get(e["Type"])
            if not kind or e.get("Score", 0) < self._min_score:
                continue
            s, t = e["BeginOffset"], e["EndOffset"]
            spans.append(Span(kind, s, t, text[s:t], self.id, e.get("Score", 1.0)))
        return spans


DETECTORS: dict[str, Detector] = {
    PatternDetector.id: PatternDetector(),
    ComprehendDetector.id: ComprehendDetector(),
}
