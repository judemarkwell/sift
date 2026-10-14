"""Shape hints: safe facts about a redacted value.

The model can't see "sk-ant-api03-…", but it can still help if it knows the
value is an Anthropic key with the right prefix and length, or that an IP is
a private address. Hints never include any part of the secret itself beyond
a publicly documented prefix, and they go to the model (and the trace) in
the system prompt.
"""

from __future__ import annotations

import ipaddress
import re

# Publicly documented key prefixes -> (who issues them, normal total length).
# Sift compares lengths itself rather than trusting the model to remember
# them. Only formats with a fixed, well-known length get one; others are None.
# Verify a length against a real key before adding it here.
KEY_PREFIXES: list[tuple[str, str, int | None]] = [
    ("sk-ant-api03-", "an Anthropic API key", 108),
    ("sk-ant-admin01-", "an Anthropic admin key", None),
    ("sk-ant-", "an Anthropic key", None),
    ("sk-proj-", "an OpenAI project key", None),
    ("sk-", "an OpenAI-style secret key", None),
    ("ghp_", "a GitHub personal access token", 40),
    ("gho_", "a GitHub OAuth token", 40),
    ("ghs_", "a GitHub app token", 40),
    ("xoxb-", "a Slack bot token", None),
    ("xoxp-", "a Slack user token", None),
    ("AIza", "a Google API key", 39),
    ("sk_live_", "a Stripe live secret key", None),
    ("rk_live_", "a Stripe restricted key", None),
]


def _length_check(n: int, expected: int | None) -> str:
    if expected is None:
        return f"{n} characters long"
    if n == expected:
        return f"{n} characters long, the normal length for this kind of key"
    if n < expected:
        return (f"{n} characters long, {expected - n} shorter than the {expected} these keys normally have, "
                "so it was likely cut off when copied")
    return (f"{n} characters long, {n - expected} longer than the {expected} these keys normally have, "
            "so extra characters were likely pasted with it")


def _card_brand(digits: str) -> str:
    if digits.startswith("4"):
        return "Visa"
    if re.match(r"5[1-5]|2[2-7]", digits):
        return "Mastercard"
    if re.match(r"3[47]", digits):
        return "American Express"
    if digits.startswith("6"):
        return "Discover"
    return "card"


def hint(kind: str, value: str) -> str | None:
    """One clause describing the value's shape, or None if nothing safe and useful applies."""
    v = value
    if kind == "API_KEY":
        key = v.strip()
        what, prefix, expected = next(((w, p, n) for p, w, n in KEY_PREFIXES if key.startswith(p)),
                                      ("an API key", "", None))
        shown = f" with the `{prefix}` prefix" if prefix else ""
        return f"{what}{shown}, {_length_check(len(key), expected)}"
    if kind == "AWS_ACCESS_KEY":
        kind_ = "a long-term access key (AKIA)" if v.startswith("AKIA") else "a temporary STS key (ASIA)"
        ok = "the expected 20 characters" if len(v) == 20 else f"{len(v)} characters (expected 20)"
        return f"an AWS access key ID, {kind_}, {ok}"
    if kind == "PRIVATE_KEY":
        m = re.search(r"BEGIN ((?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY)", v)
        complete = "END" in v
        return f"a PEM {m.group(1) if m else 'private key'} block, {'complete' if complete else 'missing its END line'}"
    if kind == "PASSWORD":
        classes = [n for n, p in (("lowercase", r"[a-z]"), ("uppercase", r"[A-Z]"), ("digits", r"\d"),
                                  ("symbols", r"[^A-Za-z0-9]")) if re.search(p, v)]
        return f"a password of {len(v)} characters using {', '.join(classes) or 'no letters or digits'}"
    if kind == "CREDIT_CARD":
        digits = re.sub(r"\D", "", v)
        return f"a {_card_brand(digits)} number, {len(digits)} digits, valid checksum"
    if kind == "IP_ADDRESS":
        try:
            ip = ipaddress.ip_address(v)
        except ValueError:
            return None
        if ip.is_loopback:
            return "a loopback (localhost) address"
        if ip.is_private:
            return "a private (internal network) address"
        return "a public internet address"
    if kind == "EMAIL":
        return "an email address"
    if kind == "PHONE":
        m = re.match(r"\s*\+(\d{1,3})", v)
        return f"a phone number with country code +{m.group(1)}" if m else "a phone number"
    return None
