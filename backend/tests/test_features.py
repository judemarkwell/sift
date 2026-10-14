import io
from datetime import timedelta

from PIL import Image

from app.images import image_tokens, process
from app.schema import utcnow
from app.styles import parse_styles, style_budget
from tests.conftest import stream


def last(events, name):
    return next(d for n, d in reversed(events) if n == name)


def png(w=3000, h=2000, exif=True) -> bytes:
    img = Image.new("RGB", (w, h), (40, 120, 200))
    buf = io.BytesIO()
    if exif:
        ex = Image.Exif()
        ex[0x010F] = "PhoneMaker"  # camera make
        ex[0x8825] = {2: (38.0, 15.0, 0.0)}  # GPS latitude
        img.save(buf, "JPEG", exif=ex.tobytes())
    else:
        img.save(buf, "PNG")
    return buf.getvalue()


# ---- styles ------------------------------------------------------------------


def test_parse_styles_strips_known_commands_only():
    text, styles = parse_styles("/tldr what changed in /usr/local? /formal")
    assert styles == ["tldr", "formal"]
    assert text == "what changed in /usr/local?"
    assert parse_styles("see /etc/hosts and /error")[1] == []


def test_style_budget_takes_the_largest_and_respects_cap():
    assert style_budget([], 8000, 32000) == 8000
    assert style_budget(["tldr"], 8000, 32000) == 400
    assert style_budget(["tldr", "long"], 8000, 32000) == 32000
    assert style_budget(["long"], 8000, 2048) == 2048


def test_styles_reach_the_model_and_trace(client, fake):
    code, events = stream(client, model="fake-live", message="/tldr explain DNS")
    trace = last(events, "done")["trace"]
    assert fake.last_sent[-1].content == "explain DNS"
    system = next(m.content for m in fake.last_sent if m.role == "system")
    assert "TL;DR" in system
    step = next(s for s in trace["pipeline"] if s["name"] == "Output style")
    assert "TL;DR" in step["detail"] and "400" in step["detail"]
    assert last(events, "done")["user_message"]["styles"] == ["tldr"]


def test_default_reply_budget_is_not_1024(client, fake):
    stream(client, model="fake-live", message="hello")
    assert fake.last_request.max_output_tokens == 8000


# ---- truncation and Continue ----------------------------------------------------


def test_cut_off_reply_can_be_continued(client):
    code, events = stream(client, model="mock-a", message="write a lot /cutoff")
    done = last(events, "done")
    assert done["message"]["truncated"] and done["trace"]["response"]["finish_reason"] == "length"
    conv_id = events[0][1]["conversation_id"]
    first_part = done["message"]["content"]

    code, events = stream(client, model="mock-a", conversation_id=conv_id, message="",
                          continue_message_id=done["message"]["id"])
    assert code == 200
    cont = last(events, "done")["message"]
    assert cont["id"] == done["message"]["id"] and cont["content"].startswith(first_part)
    assert "to finish the thought" in cont["content"] and not cont["truncated"]
    assert cont["previous_trace_ids"] == [done["trace"]["id"]]
    conv = client.get(f"/api/conversations/{conv_id}").json()
    assert len(conv["messages"]) == 2  # continued in place, no extra turns


def test_continue_only_for_cut_off_latest_reply(client):
    _, events = stream(client, model="mock-a", message="hi")
    msg = last(events, "done")["message"]
    code, body = stream(client, model="mock-a", conversation_id=events[0][1]["conversation_id"],
                        continue_message_id=msg["id"])
    assert code == 409


# ---- prompt skills ----------------------------------------------------------------


SKILL = {
    "name": "Status update",
    "instructions": "Write a weekly status update with Done, Next and Blockers.",
    "fields": [{"key": "notes", "label": "Notes", "required": True, "multiline": True},
               {"key": "audience", "label": "Audience"}],
    "starter": "My notes:\n{{notes}}",
    "styles": ["bullets"],
}


def test_prompt_skill_runs_and_keeps_context(client, fake):
    created = client.post("/api/prompt-skills", json=SKILL).json()
    code, events = stream(client, model="fake-live", message="", skill_id=created["id"],
                          skill_values={"notes": "shipped login, email jane@acme.com", "audience": "my manager"})
    assert code == 200
    first = fake.last_sent[-1].content
    assert first.startswith("My notes:\nshipped login") and "**Audience:** my manager" in first
    assert "[EMAIL_1]" in first  # field values still go through PII redaction
    system = next(m.content for m in fake.last_sent if m.role == "system")
    assert 'saved skill "Status update"' in system and "bullet" in system.lower()
    conv_id = events[0][1]["conversation_id"]
    # a follow-up turn still carries the skill's instructions
    stream(client, model="fake-live", conversation_id=conv_id, message="make it shorter")
    system = next(m.content for m in fake.last_sent if m.role == "system")
    assert "weekly status update" in system
    conv = client.get("/api/conversations").json()[0]
    assert conv["title"] == "Status update" and conv["skill_name"] == "Status update"
    assert client.get("/api/prompt-skills").json()["skills"][0]["use_count"] == 1


def test_editing_a_skill_doesnt_change_running_chats(client, fake):
    s = client.post("/api/prompt-skills", json=SKILL).json()
    _, events = stream(client, model="fake-live", skill_id=s["id"], skill_values={"notes": "x"})
    client.put(f"/api/prompt-skills/{s['id']}", json={**SKILL, "instructions": "Totally different."})
    stream(client, model="fake-live", conversation_id=events[0][1]["conversation_id"], message="again")
    system = next(m.content for m in fake.last_sent if m.role == "system")
    assert "weekly status update" in system and "Totally different" not in system


def test_free_plan_skill_limit_and_sharing_needs_team(client):
    co = client.post("/api/billing/checkout", json={"plan_id": "free"}).json()
    client.post(f"/api/billing/checkout/{co['id']}/complete")
    for i in range(3):
        assert client.post("/api/prompt-skills", json={**SKILL, "name": f"S{i}"}).status_code == 200
    r = client.post("/api/prompt-skills", json=SKILL)
    assert r.status_code == 402 and r.json()["detail"]["code"] == "skill_limit"
    r = client.post("/api/prompt-skills", json={**SKILL, "shared": True})
    assert r.status_code == 402


def test_templates_are_valid_skills(client):
    data = client.get("/api/prompt-skills").json()
    assert len(data["templates"]) >= 5
    for t in data["templates"]:
        body = {k: t[k] for k in ("name", "description", "icon", "instructions", "fields", "starter", "styles")}
        r = client.post("/api/prompt-skills", json=body)
        assert r.status_code == 200, (t["name"], r.text)


# ---- images ---------------------------------------------------------------------


def test_image_processing_resizes_and_strips_metadata():
    out = process(png())
    assert max(out.width, out.height) == 1568 and out.metadata_removed
    assert out.tokens == image_tokens(out.width, out.height) == 56 * 38
    again = Image.open(io.BytesIO(out.data))
    assert not again.getexif()  # GPS and camera data are gone


def test_upload_quota_and_images_reach_the_model(client, fake):
    co = client.post("/api/billing/checkout", json={"plan_id": "free"}).json()
    client.post(f"/api/billing/checkout/{co['id']}/complete")
    up = client.post("/api/uploads", files={"file": ("photo.jpg", png(800, 600), "image/jpeg")})
    assert up.status_code == 200
    meta = up.json()
    assert meta["tokens"] == 29 * 22 and meta["quota"]["remaining"] == 0
    second = client.post("/api/uploads", files={"file": ("b.png", png(10, 10, exif=False), "image/png")})
    assert second.status_code == 402 and second.json()["detail"]["code"] == "image_limit"

    # Free can't use fake-live, so use the mock for the chat itself.
    _, events = stream(client, model="mock-a", message="what is this?", image_ids=[meta["id"]])
    done = last(events, "done")
    assert done["user_message"]["attachments"][0]["id"] == meta["id"]
    assert "I can see 1 image" in done["message"]["content"]
    segs = {s["label"]: s["tokens"] for s in done["trace"]["context"]["segments"]}
    assert segs["Images"] == meta["tokens"]
    assert client.get(f"/api/uploads/{meta['id']}").headers["content-type"] == "image/jpeg"


def test_images_are_sent_as_bytes_to_live_models(client, fake):
    meta = client.post("/api/uploads", files={"file": ("a.png", png(56, 56, exif=False), "image/png")}).json()
    stream(client, model="fake-live", message="describe", image_ids=[meta["id"]])
    sent = fake.last_sent[-1]
    assert sent.images[0].tokens == 4
    assert fake.last_options["load_image"](meta["id"])[:8] == b"\x89PNG\r\n\x1a\n"


def test_bad_uploads_are_rejected(client):
    r = client.post("/api/uploads", files={"file": ("x.png", b"not an image", "image/png")})
    assert r.status_code == 400
    r = client.post("/api/chat/stream", json={"model": "mock-a", "message": "hi", "image_ids": ["img_nope"]})
    assert r.status_code == 404


# ---- privacy, data rights, audit -----------------------------------------------------


def test_retention_purges_old_data(client):
    _, events = stream(client, model="mock-a", message="old chat")
    conv_id = events[0][1]["conversation_id"]
    store = client.sift.storage
    conv = store.get_conversation("org_local", conv_id)
    conv.updated_at = utcnow() - timedelta(days=40)
    store.put_conversation(conv)
    assert client.patch("/api/account/privacy", json={"retention_days": 30}).status_code == 200
    assert client.get("/api/conversations").json() == []
    assert client.patch("/api/account/privacy", json={"retention_days": 3}).status_code == 400


def test_export_and_delete_everything(client):
    client.post("/api/prompt-skills", json=SKILL)
    stream(client, model="mock-a", message="keep me")
    export = client.get("/api/account/export")
    assert "attachment" in export.headers["content-disposition"]
    data = export.json()
    assert len(data["conversations"]) == 1 and len(data["prompt_skills"]) == 1
    assert client.post("/api/account/delete", json={"confirm": "nope"}).status_code == 400
    r = client.post("/api/account/delete", json={"confirm": "DELETE"}).json()
    assert r["deleted"]["conversations"] == 1 and r["deleted"]["prompt_skills"] == 1
    assert client.get("/api/conversations").json() == []
    actions = [e["action"] for e in client.get("/api/audit").json()]
    assert actions[:3] == ["data.delete", "data.export", "prompt_skill.create"]
