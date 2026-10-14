from tests.conftest import stream


def last(events, name):
    return next(d for n, d in reversed(events) if n == name)


def test_mock_chat_round_trip_and_persistence(client):
    code, events = stream(client, model="mock-a", message="How do I plan a project?")
    assert code == 200
    names = [n for n, _ in events]
    assert names[0] == "conversation" and names[1] == "start" and names[-1] == "done"
    conv_id = events[0][1]["conversation_id"]
    done = last(events, "done")
    text = "".join(d["text"] for n, d in events if n == "delta")
    assert done["message"]["content"] == text and "plan a project" in text

    conv = client.get(f"/api/conversations/{conv_id}").json()
    assert [m["role"] for m in conv["messages"]] == ["user", "assistant"]
    assert client.get("/api/conversations").json()[0]["id"] == conv_id

    # second turn includes history
    code, events = stream(client, model="mock-a", conversation_id=conv_id, message="And then?")
    trace = last(events, "done")["trace"]
    assert len([m for m in trace["sent_messages"] if m["role"] != "system"]) == 3


def test_redaction_end_to_end_with_restore(client, fake):
    client.patch("/api/skills/pii-redaction", json={"config": {"preset": "customer_data"}})
    code, events = stream(client, model="fake-live", message="Email jane@acme.com about it")
    assert code == 200
    # the provider only ever saw the placeholder
    assert "jane@acme.com" not in fake.last_sent[-1].content
    assert "[EMAIL_1]" in fake.last_sent[-1].content
    assert any("placeholders" in m.content for m in fake.last_sent if m.role == "system")
    done = last(events, "done")
    # the user sees the real value, even though the placeholder was split across chunks
    assert done["message"]["content"].endswith("got it, jane@acme.com.")
    assert done["message"]["marks"][0]["placeholder"] == "[EMAIL_1]"
    assert done["user_message"]["marks"][0]["kind"] == "EMAIL"
    # the stored trace (a log) never contains the raw value
    assert "jane@acme.com" not in str(done["trace"])
    pii_step = next(s for s in done["trace"]["pipeline"] if s["skill_id"] == "pii-redaction")
    assert pii_step["status"] == "changed"


def test_blocked_message_never_reaches_provider_or_storage(client, fake):
    client.patch("/api/skills/pii-redaction", json={"config": {"preset": "small_team"}})
    secret = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx"
    code, events = stream(client, model="fake-live", message=f"debug this: {secret}")
    err = last(events, "error")
    assert err["blocked"] and fake.last_sent is None
    assert err["trace"]["response"]["cost"]["total_usd"] == 0
    conv = client.get(f"/api/conversations/{events[0][1]['conversation_id']}").json()
    assert secret not in str(conv) and conv["messages"][0]["status"] == "blocked"
    assert secret not in str(err)


def test_live_usage_is_priced_and_charged(client):
    before = client.get("/api/billing").json()["available_usd"]
    code, events = stream(client, model="fake-live", message="hi")
    trace = last(events, "done")["trace"]
    # 100 in + 20 out at $1000/M + 50 cache reads at $100/M
    assert round(trace["response"]["cost"]["total_usd"], 6) == 0.125
    assert round(trace["charged_usd"], 6) == 0.125
    assert not trace["response"]["usage"]["estimated"]
    after = client.get("/api/billing").json()["available_usd"]
    assert round(before - after, 6) == 0.125
    cache = next(s for s in trace["pipeline"] if s["skill_id"] == "prompt-cache" and s["stage"] == "post-response")
    assert "50 tokens read from cache" in cache["detail"]


def test_provider_error_is_not_charged_and_turn_excluded(client, fake):
    fake.fail = True
    code, events = stream(client, model="fake-live", message="hi")
    err = last(events, "error")
    assert not err["blocked"] and err["trace"]["charged_usd"] == 0
    conv_id = events[0][1]["conversation_id"]
    fake.fail = False
    code, events = stream(client, model="fake-live", conversation_id=conv_id, message="again")
    sent = [m for m in fake.last_sent if m.role != "system"]
    assert [m.content for m in sent] == ["again"]


def test_spend_guard_blocks_when_configured(client, fake):
    client.patch("/api/skills/spend-guard", json={"config": {"max_cost_per_message_usd": 0.0, "action": "block"}})
    code, events = stream(client, model="fake-live", message="hi")
    assert last(events, "error")["blocked"] and fake.last_sent is None


def test_disabling_a_skill_and_core_skills(client, fake):
    r = client.patch("/api/skills/prompt-cache", json={"enabled": False})
    assert r.status_code == 200
    stream(client, model="fake-live", message="hi")
    assert "prompt_cache" not in fake.last_options
    assert client.patch("/api/skills/cost-meter", json={"enabled": False}).status_code == 400


def test_workspace_lock_overrides_user(client):
    # Pro can't set workspace policy
    assert client.patch("/api/workspace/skills/pii-redaction", json={"enabled": True}).status_code == 402
    co = client.post("/api/billing/checkout", json={"plan_id": "team", "seats": 3}).json()
    assert co["amount_usd"] == 54 and co["test_mode"]
    client.post(f"/api/billing/checkout/{co['id']}/complete")
    r = client.patch("/api/workspace/skills/pii-redaction",
                     json={"enabled": True, "config": {"preset": "regulated"}, "locked": ["enabled", "config"]})
    assert r.status_code == 200
    assert client.patch("/api/skills/pii-redaction", json={"enabled": False}).status_code == 403
    pii = next(s for s in client.get("/api/skills").json()["skills"] if s["manifest"]["id"] == "pii-redaction")
    assert pii["resolved"]["config"]["preset"] == "regulated" and pii["resolved"]["locked"] == ["enabled", "config"]


def test_plan_gating(client):
    co = client.post("/api/billing/checkout", json={"plan_id": "free"}).json()
    client.post(f"/api/billing/checkout/{co['id']}/complete")
    code, body = stream(client, model="fake-live", message="hi")
    assert code == 402 and body["detail"]["code"] == "model_not_in_plan"
    code, body = stream(client, model="mock-a", message="hi", ephemeral=True)
    assert code == 402 and body["detail"]["code"] == "feature_not_in_plan"
    models = {m["id"]: m for m in client.get("/api/models").json()}
    assert not models["fake-live"]["allowed"] and models["mock-a"]["allowed"]
    # mocks always work
    assert stream(client, model="mock-a", message="hi")[0] == 200


def test_out_of_usage_then_topup(client):
    acct = client.sift.billing.account("org_local")
    acct.allowance_usd = 0
    client.sift.billing._save(acct)
    code, body = stream(client, model="fake-live", message="hi")
    assert body["detail"]["code"] == "out_of_usage"
    co = client.post("/api/billing/checkout", json={"topup_usd": 5}).json()
    assert co["amount_usd"] == 5.5
    b = client.post(f"/api/billing/checkout/{co['id']}/complete").json()
    assert b["credit_usd"] == 5
    assert stream(client, model="fake-live", message="hi")[0] == 200
    with_ledger = client.get("/api/billing").json()["ledger"]
    assert [e["kind"] for e in with_ledger[:2]] == ["usage", "topup"]


def test_compare_runs_are_not_saved_as_conversations(client):
    code, events = stream(client, model="mock-a", message="compare me", ephemeral=True)
    assert code == 200 and client.get("/api/conversations").json() == []
    assert last(events, "done")["trace"]["ephemeral"]


def test_scan_endpoint_and_usage(client):
    found = client.post("/api/pii/scan", json={"text": "card 4111 1111 1111 1111"}).json()
    assert found["findings"][0]["kind"] == "CREDIT_CARD" and found["findings"][0]["action"] == "redact"
    stream(client, model="fake-live", message="my card 4111 1111 1111 1111")
    u = client.get("/api/usage?days=7").json()
    assert u["totals"]["messages"] == 1 and u["privacy"]["redact"] == 1
    assert u["by_model"][0]["model_id"] == "fake-live" and len(u["daily"]) == 7


def test_report_has_no_raw_pii(client):
    client.patch("/api/skills/pii-redaction", json={"config": {"preset": "customer_data"}})
    code, events = stream(client, model="fake-live", message="Email jane@acme.com")
    conv_id = events[0][1]["conversation_id"]
    report = client.get(f"/api/conversations/{conv_id}/report").text
    assert "[EMAIL_1]" in report and "jane@acme.com" not in report
    assert client.get("/api/conversations").json()[0]["title"] == "Email [EMAIL_1]"


def test_context_trimmer(client, fake):
    client.patch("/api/skills/context-trimmer", json={"config": {"max_history_tokens": 1000}})
    conv_id = None
    for i in range(4):
        _, events = stream(client, model="fake-live", conversation_id=conv_id, message=("word " * 700) + str(i))
        conv_id = events[0][1]["conversation_id"]
    trace = last(events, "done")["trace"]
    step = next(s for s in trace["pipeline"] if s["skill_id"] == "context-trimmer")
    assert step["status"] == "changed"
    sent = [m for m in fake.last_sent if m.role != "system"]
    assert sent[0].role == "user" and len(sent) < 7
