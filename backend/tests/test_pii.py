import pytest

from app.schema import Message
from app.skills.pii.detectors import ComprehendDetector, PatternDetector, iban_ok, luhn_ok
from app.skills.pii.entities import PRESETS
from app.skills.pii.redactor import StreamRestorer, Vault, detect, mask, redact_messages, restore, scan

P = PatternDetector()
C = ComprehendDetector()


def kinds(text, detectors=(P,)):
    return [s.kind for s in detect(text, list(detectors))]


@pytest.mark.parametrize(
    "text,kind",
    [
        ("mail me at jane.doe+work@acme.co.uk please", "EMAIL"),
        ("call (502) 555-0142 tomorrow", "PHONE"),
        ("or +44 20 7946 0958", "PHONE"),
        ("card 4111 1111 1111 1111 exp 04/27", "CREDIT_CARD"),
        ("ssn 123-45-6789", "SSN"),
        ("key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx", "API_KEY"),
        ("AKIAIOSFODNN7EXAMPLE is the id", "AWS_ACCESS_KEY"),
        ("server 10.20.30.40 is down", "IP_ADDRESS"),
        ("my password: hunter22", "PASSWORD"),
        ("DOB 04/12/1990", "DATE_OF_BIRTH"),
        ("ship to 1200 Main Street, Apt 4", "ADDRESS"),
        ("IBAN GB82 WEST 1234 5698 7654 32", "IBAN"),
    ],
)
def test_detects(text, kind):
    assert kind in kinds(text)


@pytest.mark.parametrize(
    "text",
    [
        "version 1.2.3 released",
        "order 1234 5678 9012 3456",  # fails Luhn
        "ssn 000-12-3456",  # invalid area
        "the year 2026 had 365 days",
        "pip install fastapi==0.143.0",
    ],
)
def test_no_false_positives(text):
    assert kinds(text) == []


def test_validators():
    assert luhn_ok("4111111111111111") and not luhn_ok("4111111111111112")
    assert iban_ok("GB82 WEST 1234 5698 7654 32") and not iban_ok("GB00 WEST 1234 5698 7654 32")


def test_mock_comprehend_finds_names_from_cues():
    spans = detect("Hi, my name is Jordan Ellis and I work with Dr. Priya Raman.", [C])
    names = [s.text for s in spans if s.kind == "PERSON"]
    assert names == ["Jordan Ellis", "Priya Raman"]
    assert detect("I think the plan is fine", [C]) == []


def test_overlaps_prefer_stronger_entity():
    # An API key that happens to contain an email-like fragment stays one key.
    spans = detect("token sk-proj-abcdefghijklmnopqrstuvwxyz123456", [P])
    assert [s.kind for s in spans] == ["API_KEY"]


def test_masks_never_contain_full_value():
    assert mask("EMAIL", "jane@acme.com") == "j•••@acme.com"
    assert mask("CREDIT_CARD", "4111 1111 1111 1111") == "•••• 1111"
    assert "6789" in mask("SSN", "123-45-6789") and "123" not in mask("SSN", "123-45-6789")


def test_redaction_is_stable_and_reversible():
    vault = Vault()
    policy = PRESETS["customer_data"]["policy"]
    msgs = [
        Message(role="user", content="Email jane@acme.com and JANE@acme.com, phone 502-555-0142"),
        Message(role="assistant", content="Sure, I'll email jane@acme.com"),
    ]
    res = redact_messages(msgs, policy, [P], vault)
    assert res.messages[0].content == "Email [EMAIL_1] and [EMAIL_1], phone [PHONE_1]"
    assert res.messages[1].content == "Sure, I'll email [EMAIL_1]"
    assert restore("Reply to [EMAIL_1] or [PHONE_1] ([X_9])", vault) == "Reply to jane@acme.com or 502-555-0142 ([X_9])"
    # vault survives a round trip through storage
    assert Vault.from_dict(vault.to_dict()).by_value == vault.by_value


def test_warn_and_allow_leave_text_alone():
    policy = PRESETS["personal"]["policy"]
    res = redact_messages([Message(role="user", content="I'm at jane@acme.com")], policy, [P], Vault())
    assert res.messages[0].content == "I'm at jane@acme.com"
    assert [f.action for f in res.findings] == ["warn"]


def test_block_still_replaces_value_for_logs():
    policy = PRESETS["small_team"]["policy"]
    res = redact_messages([Message(role="user", content="use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx")], policy, [P], Vault())
    assert res.blocked and "sk-ant" not in res.messages[0].content


def test_stream_restorer_handles_split_placeholders():
    vault = Vault()
    vault.placeholder_for("EMAIL", "jane@acme.com")
    r = StreamRestorer(vault)
    chunks = ["Send to [EM", "AIL_", "1] now [not a placeholder] and [EMAIL_1", "]."]
    out = "".join(r.feed(c) for c in chunks) + r.flush()
    assert out == "Send to jane@acme.com now [not a placeholder] and jane@acme.com."
    # recorded spans point at the restored values in the output
    assert [out[s:e] for _, s, e in r.restored] == ["jane@acme.com", "jane@acme.com"]


def test_stream_restorer_doesnt_hold_forever():
    r = StreamRestorer(Vault())
    assert r.feed("a [ bracket that never closes " + "x" * 40) .startswith("a [ bracket")


def test_scan_respects_policy():
    found = scan("jane@acme.com 10.0.0.1", PRESETS["personal"]["policy"], [P])
    assert [f.kind for f in found] == ["EMAIL"]  # IP is "allow" in Personal
