"""The kinds of sensitive data Sift can find, and the built-in policy presets."""

from __future__ import annotations

from dataclasses import dataclass

from app.schema import PiiAction


@dataclass(frozen=True)
class Entity:
    kind: str
    label: str
    group: str  # used to group the policy table in the UI
    example: str


ENTITIES: list[Entity] = [
    Entity("API_KEY", "API key or token", "Secrets", "sk-ant-api03-…"),
    Entity("AWS_ACCESS_KEY", "AWS access key", "Secrets", "AKIA…"),
    Entity("PRIVATE_KEY", "Private key block", "Secrets", "-----BEGIN PRIVATE KEY-----"),
    Entity("PASSWORD", "Password in text", "Secrets", "password: hunter2"),
    Entity("CREDIT_CARD", "Payment card number", "Financial", "4111 1111 1111 1111"),
    Entity("IBAN", "Bank account (IBAN)", "Financial", "GB82 WEST 1234 5698 7654 32"),
    Entity("SSN", "US Social Security number", "Government ID", "123-45-6789"),
    Entity("EMAIL", "Email address", "Contact", "jane@acme.com"),
    Entity("PHONE", "Phone number", "Contact", "(502) 555-0142"),
    Entity("ADDRESS", "Street address", "Contact", "1200 Main St"),
    Entity("PERSON", "Person's name", "Identity", "Jane Doe"),
    Entity("DATE_OF_BIRTH", "Date of birth", "Identity", "DOB 04/12/1990"),
    Entity("IP_ADDRESS", "IP address", "Technical", "192.168.1.20"),
]

ENTITY_BY_KIND = {e.kind: e for e in ENTITIES}

Policy = dict[str, PiiAction]


def _policy(default: PiiAction, **overrides: PiiAction) -> Policy:
    return {e.kind: overrides.get(e.kind, default) for e in ENTITIES}


SECRETS = ("API_KEY", "AWS_ACCESS_KEY", "PRIVATE_KEY", "PASSWORD")

PRESETS: dict[str, dict] = {
    "personal": {
        "name": "Personal",
        "description": "Hide secrets and financial numbers. Point out contact details without changing them.",
        "policy": _policy(
            "warn",
            **{k: "redact" for k in SECRETS},
            CREDIT_CARD="redact",
            IBAN="redact",
            SSN="redact",
            PERSON="allow",
            IP_ADDRESS="allow",
        ),
    },
    "small_team": {
        "name": "Small team",
        "description": "Stop secrets from leaving at all. Replace contact details and IDs with placeholders.",
        "policy": _policy(
            "redact",
            **{k: "block" for k in SECRETS},
            PERSON="warn",
            IP_ADDRESS="warn",
        ),
    },
    "customer_data": {
        "name": "Handles customer data",
        "description": "Replace every kind of personal data, including names, before it reaches a model.",
        "policy": _policy("redact", **{k: "block" for k in SECRETS}),
    },
    "regulated": {
        "name": "Regulated",
        "description": "Health- or finance-style rules. Government IDs, cards and secrets are never sent.",
        "policy": _policy(
            "redact",
            **{k: "block" for k in SECRETS},
            CREDIT_CARD="block",
            IBAN="block",
            SSN="block",
        ),
    },
}

DEFAULT_PRESET = "personal"
