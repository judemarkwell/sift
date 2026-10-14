from tests.conftest import stream


def _chat(client, text="hello there", model="mock-a"):
    _, events = stream(client, model=model, message=text)
    return events[0][1]["conversation_id"]


def _set_pin(client, pin="2468"):
    r = client.post("/api/secure/pin", json={"pin": pin})
    assert r.status_code == 200
    return {"X-Sift-Unlock": r.json()["token"]}


def test_folder_shows_by_default_and_needs_a_pin_to_move_in(client):
    s = client.get("/api/secure").json()
    assert s["enabled"] and s["visible"] and not s["pin_set"] and not s["unlocked"]
    conv = _chat(client)
    r = client.patch(f"/api/conversations/{conv}", json={"secure": True})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "pin_required"


def test_moving_in_hides_everywhere_until_unlocked(client):
    conv = _chat(client, "my private thing", model="fake-live")
    unlock = _set_pin(client)
    client.post("/api/secure/lock")  # setting a PIN unlocks; start from locked
    assert client.patch(f"/api/conversations/{conv}", json={"secure": True}).status_code == 200  # no PIN needed

    assert client.get("/api/conversations").json() == []
    assert client.get(f"/api/conversations/{conv}").status_code == 423
    assert client.get(f"/api/conversations/{conv}/report").status_code == 423
    assert client.delete(f"/api/conversations/{conv}").status_code == 423
    assert client.get("/api/secure/conversations").status_code == 423
    assert stream(client, model="mock-a", conversation_id=conv, message="more")[0] == 423
    # moving out is changing a secure chat, so it needs the PIN
    assert client.patch(f"/api/conversations/{conv}", json={"secure": False}).status_code == 423
    # the old token died when the folder was locked
    assert client.get(f"/api/conversations/{conv}", headers=unlock).status_code == 423

    # activity names it only as "Secure chat", and it stays linkable
    usage = next(e for e in client.get("/api/billing").json()["ledger"] if e.get("source_id") == conv)
    assert usage["source_title"] == "Secure chat" and usage["source_secure"]
    assert "private" not in str(client.get("/api/billing").json())

    h = {"X-Sift-Unlock": client.post("/api/secure/unlock", json={"pin": "2468"}).json()["token"]}
    assert client.get("/api/secure").json()["pin_set"]
    assert client.get("/api/secure", headers=h).json()["unlocked"]
    assert [c["id"] for c in client.get("/api/secure/conversations", headers=h).json()] == [conv]
    assert client.get(f"/api/conversations/{conv}", headers=h).json()["secure"]
    trace_id = client.get(f"/api/conversations/{conv}", headers=h).json()["messages"][1]["trace_id"]
    assert client.get(f"/api/traces/{trace_id}").status_code == 423
    assert client.get(f"/api/traces/{trace_id}", headers=h).status_code == 200
    assert stream(client, headers=h, model="fake-live", conversation_id=conv, message="more")[0] == 200
    assert client.patch(f"/api/conversations/{conv}", json={"secure": False}, headers=h).status_code == 200
    assert [c["id"] for c in client.get("/api/conversations").json()] == [conv]


def test_new_secure_chat_needs_unlocked_folder(client):
    assert stream(client, model="mock-a", message="hi", secure=True)[1]["detail"]["code"] == "pin_required"
    h = _set_pin(client)
    client.post("/api/secure/lock")
    assert stream(client, model="mock-a", message="hi", secure=True)[0] == 423
    h = {"X-Sift-Unlock": client.post("/api/secure/unlock", json={"pin": "2468"}).json()["token"]}
    code, events = stream(client, headers=h, model="mock-a", message="hi", secure=True)
    assert code == 200 and client.get("/api/conversations").json() == []
    assert len(client.get("/api/secure/conversations", headers=h).json()) == 1


def test_wrong_pins_lock_out_and_are_audited(client):
    _set_pin(client)
    for i in range(4):
        r = client.post("/api/secure/unlock", json={"pin": "0000"})
        assert r.status_code == 401
    assert "1 try left" in r.json()["detail"]["message"]
    r = client.post("/api/secure/unlock", json={"pin": "0000"})
    assert r.status_code == 429
    # even the right PIN waits out the lockout
    assert client.post("/api/secure/unlock", json={"pin": "2468"}).status_code == 429
    assert client.get("/api/secure").json()["retry_after_seconds"] > 0
    actions = [e["action"] for e in client.get("/api/audit").json()]
    assert actions.count("secure.unlock_failed") == 6  # incl. the try during lockout


def test_pin_rules_and_export_never_holds_the_hash(client):
    assert client.post("/api/secure/pin", json={"pin": "12ab"}).status_code == 400
    assert client.post("/api/secure/pin", json={"pin": "123"}).status_code == 422
    _set_pin(client, "13579")
    assert client.post("/api/secure/pin", json={"pin": "11111"}).status_code == 409  # can't overwrite
    export = client.get("/api/account/export").text
    assert "_secure" not in export and "hash" not in export


def test_turning_the_skill_off_never_reveals_secure_chats(client):
    conv = _chat(client)
    _set_pin(client)
    client.patch(f"/api/conversations/{conv}", json={"secure": True})
    client.patch("/api/skills/secure-folder", json={"enabled": False})
    assert client.get("/api/conversations").json() == []
    s = client.get("/api/secure").json()
    assert not s["enabled"] and s["visible"]  # still shown while it holds chats
    other = _chat(client)
    assert client.patch(f"/api/conversations/{other}", json={"secure": True}).status_code == 400


def test_tokens_are_tamper_proof(client):
    h = _set_pin(client)
    tok = h["X-Sift-Unlock"]
    forged = tok.rsplit(".", 1)[0].rsplit(".", 1)[0] + ".9999999999." + tok.rsplit(".", 1)[1]
    assert not client.get("/api/secure", headers={"X-Sift-Unlock": forged}).json()["unlocked"]
    assert client.get("/api/secure", headers=h).json()["unlocked"]
