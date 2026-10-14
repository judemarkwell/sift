"""SQLite storage for local development (and tests, with ":memory:")."""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from app.schema import Conversation, Trace

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
  updated_at TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conv_by_user ON conversations(org_id, user_id, updated_at);

CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL, created_at TEXT NOT NULL, model TEXT NOT NULL,
  cost REAL NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trace_by_org ON traces(org_id, created_at);
CREATE INDEX IF NOT EXISTS trace_by_conv ON traces(org_id, conversation_id);

CREATE TABLE IF NOT EXISTS vaults (
  org_id TEXT NOT NULL, conversation_id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (org_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS settings (
  scope TEXT NOT NULL, scope_id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id)
);

CREATE TABLE IF NOT EXISTS accounts (org_id TEXT PRIMARY KEY, data TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL,
  created_at TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_by_org ON ledger(org_id, id);
"""


class SqliteStorage:
    def __init__(self, path: str = ":memory:") -> None:
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.executescript(SCHEMA)
            self._db.execute("PRAGMA journal_mode=WAL")

    def _exec(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            cur = self._db.execute(sql, args)
            rows = cur.fetchall()
            self._db.commit()
            return rows

    # ---- conversations ----

    def put_conversation(self, conv: Conversation) -> None:
        self._exec(
            "INSERT OR REPLACE INTO conversations VALUES (?,?,?,?,?)",
            (conv.id, conv.org_id, conv.user_id, conv.updated_at.isoformat(), conv.model_dump_json()),
        )

    def get_conversation(self, org_id: str, conv_id: str) -> Conversation | None:
        rows = self._exec("SELECT data FROM conversations WHERE org_id=? AND id=?", (org_id, conv_id))
        return Conversation.model_validate_json(rows[0]["data"]) if rows else None

    def list_conversations(self, org_id: str, user_id: str, limit: int = 100) -> list[Conversation]:
        rows = self._exec(
            "SELECT data FROM conversations WHERE org_id=? AND user_id=? ORDER BY updated_at DESC LIMIT ?",
            (org_id, user_id, limit),
        )
        return [Conversation.model_validate_json(r["data"]) for r in rows]

    def delete_conversation(self, org_id: str, conv_id: str) -> None:
        self._exec("DELETE FROM conversations WHERE org_id=? AND id=?", (org_id, conv_id))
        self._exec("DELETE FROM vaults WHERE org_id=? AND conversation_id=?", (org_id, conv_id))

    # ---- traces ----

    def put_trace(self, trace: Trace) -> None:
        self._exec(
            "INSERT OR REPLACE INTO traces VALUES (?,?,?,?,?,?,?,?)",
            (
                trace.id,
                trace.org_id,
                trace.user_id,
                trace.conversation_id,
                trace.created_at.isoformat(),
                trace.model,
                trace.response.cost.total_usd,
                trace.model_dump_json(),
            ),
        )

    def get_trace(self, org_id: str, trace_id: str) -> Trace | None:
        rows = self._exec("SELECT data FROM traces WHERE org_id=? AND id=?", (org_id, trace_id))
        return Trace.model_validate_json(rows[0]["data"]) if rows else None

    def list_traces(
        self,
        org_id: str,
        *,
        user_id: str | None = None,
        conversation_id: str | None = None,
        since: datetime | None = None,
    ) -> list[Trace]:
        sql, args = "SELECT data FROM traces WHERE org_id=?", [org_id]
        if user_id:
            sql += " AND user_id=?"
            args.append(user_id)
        if conversation_id:
            sql += " AND conversation_id=?"
            args.append(conversation_id)
        if since:
            sql += " AND created_at>=?"
            args.append(since.isoformat())
        rows = self._exec(sql + " ORDER BY created_at", tuple(args))
        return [Trace.model_validate_json(r["data"]) for r in rows]

    def spend_since(self, since: datetime, live_models: set[str]) -> float:
        if not live_models:
            return 0.0
        marks = ",".join("?" * len(live_models))
        rows = self._exec(
            f"SELECT COALESCE(SUM(cost),0) AS s FROM traces WHERE created_at>=? AND model IN ({marks})",
            (since.isoformat(), *live_models),
        )
        return float(rows[0]["s"])

    # ---- vaults ----

    def get_vault(self, org_id: str, conv_id: str) -> dict[str, str]:
        rows = self._exec("SELECT data FROM vaults WHERE org_id=? AND conversation_id=?", (org_id, conv_id))
        return json.loads(rows[0]["data"]) if rows else {}

    def put_vault(self, org_id: str, conv_id: str, data: dict[str, str]) -> None:
        self._exec("INSERT OR REPLACE INTO vaults VALUES (?,?,?)", (org_id, conv_id, json.dumps(data)))

    # ---- settings ----

    def get_settings(self, scope: str, scope_id: str) -> dict[str, Any]:
        rows = self._exec("SELECT data FROM settings WHERE scope=? AND scope_id=?", (scope, scope_id))
        return json.loads(rows[0]["data"]) if rows else {}

    def put_settings(self, scope: str, scope_id: str, data: dict[str, Any]) -> None:
        self._exec("INSERT OR REPLACE INTO settings VALUES (?,?,?)", (scope, scope_id, json.dumps(data)))

    # ---- billing ----

    def get_account(self, org_id: str) -> dict[str, Any] | None:
        rows = self._exec("SELECT data FROM accounts WHERE org_id=?", (org_id,))
        return json.loads(rows[0]["data"]) if rows else None

    def put_account(self, org_id: str, data: dict[str, Any]) -> None:
        self._exec("INSERT OR REPLACE INTO accounts VALUES (?,?)", (org_id, json.dumps(data, default=str)))

    def add_ledger(self, org_id: str, entry: dict[str, Any]) -> None:
        self._exec(
            "INSERT INTO ledger (org_id, created_at, data) VALUES (?,?,?)",
            (org_id, str(entry.get("created_at")), json.dumps(entry, default=str)),
        )

    def list_ledger(self, org_id: str, limit: int = 50) -> list[dict[str, Any]]:
        rows = self._exec("SELECT data FROM ledger WHERE org_id=? ORDER BY id DESC LIMIT ?", (org_id, limit))
        return [json.loads(r["data"]) for r in rows]
