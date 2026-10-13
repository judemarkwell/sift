# Sift

Model-agnostic AI chat with transparency built in. Every reply shows what it cost, how long it took, and exactly what was sent, and every request flows through a pipeline where privacy and policy plugins will plug in.

This is the MVP: a real chat UI on top of a **mock backend**. Three fake providers (OpenAI, Anthropic and Google lookalikes) stream simulated replies with realistic token counts, prices and latency, so you can build and test everything without spending anything on API calls.

## Run it

You need Python 3.11+ and Node 20+.

```bash
# Terminal 1: API on http://localhost:8000
cd backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload

# Terminal 2: UI on http://localhost:5173
cd frontend
npm install
npm run dev
```

Or run both with Docker: `docker compose up`.

The Vite dev server forwards `/api/*` to the backend, so the browser only talks to one origin.

### Test prompts

| Add to a message | What happens |
|---|---|
| `/long` | A much longer reply with a table and code, which moves the cost and context numbers |
| `/error` | The provider fails partway through, so you can see the error state and its trace |

## How it fits together

```
frontend/  React + Vite + TypeScript, Tailwind v4, shadcn/ui components
  src/hooks/useChat.ts         conversation state and streaming
  src/components/TracePanel    the per-reply trace, drawn as a pipeline
  src/lib/api-schema.ts        generated from the backend; don't edit by hand

backend/   FastAPI
  app/schema.py                provider-agnostic types: AIRequest, AIResponse, Trace
  app/gateway.py               the pipeline: pre-request -> provider -> post-response
  app/providers/               one adapter per provider (only mocks so far)
  app/store.py                 trace storage behind an interface (memory now, DynamoDB later)
```

**Request flow:** `POST /api/chat/stream` returns Server-Sent Events: `start` (trace ID and context breakdown), many `delta` events (text), then `done` (the full trace) or `error`.

**Keeping types in sync:** with the backend running, `cd frontend && npm run gen:types` regenerates the TypeScript types from FastAPI's OpenAPI spec.

**Adding shadcn components:** `components.json` is configured, so `npx shadcn@latest add <component>` works from `frontend/`.

## Design rules (keep these)

- Nothing outside `app/providers/` sees provider-specific objects.
- `org_id` and `user_id` travel with every request and every storage call, even though they're hardcoded until auth arrives.
- No local-only shortcuts in the backend (local files, global config). Storage goes through `TraceStore`.

## Next steps

1. Real provider adapter (OpenAI or Bedrock) next to the mocks, with keys in `backend/.env`
2. Plugin interface, then PII redaction (pre-request) and replacing the built-in cost step with a plugin
3. Use provider-reported token usage instead of estimates
4. Persist conversations (SQLite or DynamoDB Local)
5. AWS: Fargate, DynamoDB, Cognito, Secrets Manager via CDK in `infra/`
