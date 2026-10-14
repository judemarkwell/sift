# Sift

A model-agnostic AI chat that shows its work. Every reply comes with what it cost, how long it took and exactly what the model received. Personal data and secrets are caught before they leave, and every behavior is a **skill** you can switch on, tune, or (on Team) require for everyone.

## What's in it

- **Chat** with saved conversations, streaming replies, and switching models mid-conversation (the next model gets the whole history).
- **Traces.** Click the line under any reply to see each skill's step in order, the context window, and the exact messages the model received.
- **PII redaction.** Emails, phone numbers, card numbers, SSNs, IBANs, API and AWS keys, passwords, IPs, birthdays, addresses, and names (names via an AWS Comprehend–shaped detector, mocked locally). Each type can be *blocked*, *replaced* with a placeholder like `[EMAIL_1]`, *warned* about, or *allowed*, starting from four presets. Placeholders in replies are swapped back so you still see real values, even when a placeholder is split across stream chunks. The composer previews what will happen as you type.
- **Other skills.** Context trimmer (caps history), spend guard (per-message limit), prompt caching (with savings reported), reply check (flags PII in replies), and the always-on cost meter.
- **Usage dashboard.** Spend per day and per model, model averages (cost, first token, full reply), what redaction caught, and the most expensive messages.
- **Compare.** One prompt, two or three models side by side, with cost and speed.
- **Plans.** Free, Plus, Pro and Team, each showing how much of its price is model usage at cost and how much is Sift. Includes credits, top-ups and test-mode checkout.
- **Transparency report.** Export any chat as Markdown with costs and skill activity (redacted values stay redacted).

### Privacy rules the code enforces

- Traces (logs) store only what was sent after redaction, never the raw request.
- A blocked value is never sent, never logged, and is masked in the saved chat. Conversation titles use placeholders too.
- The placeholder-to-value map is stored per conversation (and per org), separately from traces.

## Run it

You need Docker, or Python 3.11+ and Node 20+.

```bash
docker compose up --build        # UI on http://localhost:5173, API on :8000
```

Or run the two parts yourself:

```bash
cd backend && python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload

cd frontend && npm install && npm run dev
```

### Real Claude models

Copy `backend/.env.example` to `backend/.env` and set `ANTHROPIC_API_KEY`. Claude Haiku, Sonnet and Opus 5.5 then appear above the free mock models. Real replies use the token counts Anthropic reports (including cache reads), and charges come out of the plan's included usage.

`SIFT_DAILY_BUDGET_USD` is a hard daily cap on real-model spend across everyone, separate from plans. Locally you start on Pro (`SIFT_DEFAULT_PLAN`) so every model can be tried; switch plans on the Plan & billing page (test mode, nothing is charged).

### Test prompts for the mock models

| Add to a message | What happens |
|---|---|
| `/long` | A longer reply with a table and code |
| `/error` | The provider fails partway through |
| an email, phone or card number | Watch it get replaced, sent as a placeholder, and restored in the reply |

## How it fits together

```
backend/app
  main.py            routes (chat stream, conversations, skills, usage, billing)
  gateway.py         the pipeline: pre-request skills -> provider -> post-response skills
  skills/            one module per skill; registry.py resolves settings in layers
    pii/             detectors, policy presets, reversible redaction, stream restore
  providers/         Anthropic adapter + mock providers (same interface)
  billing/           plans, allowance/credit ledger, payment provider (mock)
  storage/           Storage interface; SQLite now, DynamoDB design documented
  auth.py            the caller (local user now, Cognito later)
frontend/src
  components/chat    composer, thread, trace panel
  components/pages   compare, usage, skills, plans
infra/               AWS CDK stack (see infra/README.md)
```

**Skills.** Each skill has a manifest (stage, whether it may change the request, config schema). The Skills page is generated from the manifests, so a new skill needs no new settings screen. Settings resolve as *system defaults → workspace policy (can lock) → user preference*.

**Types** come from the backend: with the API running, `cd frontend && npm run gen:types`.

**Tests:** `cd backend && pytest` covers detectors, redaction and restore, the pipeline end to end, privacy guarantees, billing, plan gating and settings locks.

## Design rules (keep these)

- Nothing outside `app/providers/` sees provider-specific objects.
- `org_id` and `user_id` travel with every request and every storage call.
- Logs never contain anything a skill removed.
- Storage goes through `Storage`; no local-only shortcuts.

## Next

1. AWS: implement `DynamoDBStorage` and `CognitoVerifier`, then `cdk deploy` (see `infra/README.md`)
2. Real Comprehend client and Stripe Checkout behind the existing interfaces
3. Second real provider (OpenAI, or models via Bedrock), and Sign in with ChatGPT
4. File attachments with retrieval, and "what supported this answer" in the trace
5. Cross-model context hand-off (summarize a long chat before switching models)
