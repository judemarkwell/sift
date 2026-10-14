"""SQLite storage for local development (and tests, with ":memory:")."""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from app.schema import Comparison, Conversation, PromptSkill, Trace

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

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
  created_at TEXT NOT NULL, meta TEXT NOT NULL, data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_by_org ON uploads(org_id, created_at);

CREATE TABLE IF NOT EXISTS prompt_skills (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  shared INTEGER NOT NULL, data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comparisons (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
  created_at TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comparisons_by_user ON comparisons(org_id, user_id, created_at);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL,
  created_at TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_by_org ON audit(org_id, id);
CREATE TABLE IF NOT EXISTS members (
  user_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, data TEXT NOT NULL
);
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

    # ---- uploads ----

    def put_upload(self, meta: dict[str, Any], data: bytes) -> None:
        self._exec(
            "INSERT OR REPLACE INTO uploads VALUES (?,?,?,?,?,?)",
            (meta["id"], meta["org_id"], meta["user_id"], meta["created_at"], json.dumps(meta), data),
        )

    def get_upload(self, org_id: str, upload_id: str) -> dict[str, Any] | None:
        rows = self._exec("SELECT meta FROM uploads WHERE org_id=? AND id=?", (org_id, upload_id))
        return json.loads(rows[0]["meta"]) if rows else None

    def get_upload_bytes(self, org_id: str, upload_id: str) -> bytes:
        rows = self._exec("SELECT data FROM uploads WHERE org_id=? AND id=?", (org_id, upload_id))
        if not rows:
            raise KeyError(upload_id)
        return bytes(rows[0]["data"])

    def count_uploads_since(self, org_id: str, since: datetime, user_id: str | None = None) -> int:
        sql, args = "SELECT COUNT(*) AS n FROM uploads WHERE org_id=? AND created_at>=?", [org_id, since.isoformat()]
        if user_id:
            sql += " AND user_id=?"
            args.append(user_id)
        return int(self._exec(sql, tuple(args))[0]["n"])

    # ---- prompt skills ----

    def put_prompt_skill(self, skill: PromptSkill) -> None:
        self._exec(
            "INSERT OR REPLACE INTO prompt_skills VALUES (?,?,?,?,?)",
            (skill.id, skill.org_id, skill.owner_id, int(skill.shared), skill.model_dump_json()),
        )

    def get_prompt_skill(self, org_id: str, skill_id: str) -> PromptSkill | None:
        rows = self._exec("SELECT data FROM prompt_skills WHERE org_id=? AND id=?", (org_id, skill_id))
        return PromptSkill.model_validate_json(rows[0]["data"]) if rows else None

    def list_prompt_skills(self, org_id: str, user_id: str) -> list[PromptSkill]:
        rows = self._exec(
            "SELECT data FROM prompt_skills WHERE org_id=? AND (owner_id=? OR shared=1)", (org_id, user_id)
        )
        return [PromptSkill.model_validate_json(r["data"]) for r in rows]

    def delete_prompt_skill(self, org_id: str, skill_id: str) -> None:
        self._exec("DELETE FROM prompt_skills WHERE org_id=? AND id=?", (org_id, skill_id))

    # ---- comparisons ----

    def put_comparison(self, comparison: Comparison) -> None:
        self._exec(
            "INSERT OR REPLACE INTO comparisons VALUES (?,?,?,?,?)",
            (comparison.id, comparison.org_id, comparison.user_id, comparison.created_at.isoformat(),
             comparison.model_dump_json()),
        )

    def get_comparison(self, org_id: str, comparison_id: str) -> Comparison | None:
        rows = self._exec("SELECT data FROM comparisons WHERE org_id=? AND id=?", (org_id, comparison_id))
        return Comparison.model_validate_json(rows[0]["data"]) if rows else None

    def list_comparisons(self, org_id: str, user_id: str, limit: int = 50) -> list[Comparison]:
        rows = self._exec(
            "SELECT data FROM comparisons WHERE org_id=? AND user_id=? ORDER BY created_at DESC LIMIT ?",
            (org_id, user_id, limit),
        )
        return [Comparison.model_validate_json(r["data"]) for r in rows]

    def delete_comparison(self, org_id: str, comparison_id: str) -> None:
        self._exec("DELETE FROM comparisons WHERE org_id=? AND id=?", (org_id, comparison_id))

    # ---- workspace membership ----

    def get_member(self, user_id: str) -> dict[str, Any] | None:
        rows = self._exec("SELECT data FROM members WHERE user_id=?", (user_id,))
        return json.loads(rows[0]["data"]) if rows else None

    def add_member_if_absent(self, member: dict[str, Any]) -> dict[str, Any]:
        """Insert unless the user already has a workspace; return what's stored.
        Two first requests racing each other end up in the same workspace."""
        self._exec("INSERT OR IGNORE INTO members VALUES (?,?,?)",
                   (member["user_id"], member["org_id"], json.dumps(member, default=str)))
        return self.get_member(member["user_id"])  # type: ignore[return-value]

    # ---- audit ----

    def add_audit(self, org_id: str, entry: dict[str, Any]) -> None:
        self._exec(
            "INSERT INTO audit (org_id, created_at, data) VALUES (?,?,?)",
            (org_id, str(entry.get("created_at")), json.dumps(entry, default=str)),
        )

    def list_audit(self, org_id: str, limit: int = 100) -> list[dict[str, Any]]:
        rows = self._exec("SELECT data FROM audit WHERE org_id=? ORDER BY id DESC LIMIT ?", (org_id, limit))
        return [json.loads(r["data"]) for r in rows]

    # ---- retention and erasure ----

    def purge_user_before(self, org_id: str, user_id: str, before: datetime) -> dict[str, int]:
        cut = before.isoformat()
        old = self._exec(
            "SELECT id FROM conversations WHERE org_id=? AND user_id=? AND updated_at<?", (org_id, user_id, cut)
        )
        for r in old:
            self._exec("DELETE FROM vaults WHERE org_id=? AND conversation_id=?", (org_id, r["id"]))
        self._exec("DELETE FROM conversations WHERE org_id=? AND user_id=? AND updated_at<?", (org_id, user_id, cut))
        traces = self._exec("SELECT COUNT(*) AS n FROM traces WHERE org_id=? AND user_id=? AND created_at<?",
                            (org_id, user_id, cut))[0]["n"]
        self._exec("DELETE FROM traces WHERE org_id=? AND user_id=? AND created_at<?", (org_id, user_id, cut))
        ups = self._exec("SELECT COUNT(*) AS n FROM uploads WHERE org_id=? AND user_id=? AND created_at<?",
                         (org_id, user_id, cut))[0]["n"]
        self._exec("DELETE FROM uploads WHERE org_id=? AND user_id=? AND created_at<?", (org_id, user_id, cut))
        cmps = self._exec("SELECT COUNT(*) AS n FROM comparisons WHERE org_id=? AND user_id=? AND created_at<?",
                          (org_id, user_id, cut))[0]["n"]
        self._exec("DELETE FROM comparisons WHERE org_id=? AND user_id=? AND created_at<?", (org_id, user_id, cut))
        return {"conversations": len(old), "traces": int(traces), "uploads": int(ups), "comparisons": int(cmps)}

    def delete_user_data(self, org_id: str, user_id: str) -> dict[str, int]:
        counts = self.purge_user_before(org_id, user_id, datetime.max.replace(tzinfo=None))
        n = self._exec("SELECT COUNT(*) AS n FROM prompt_skills WHERE org_id=? AND owner_id=?",
                       (org_id, user_id))[0]["n"]
        self._exec("DELETE FROM prompt_skills WHERE org_id=? AND owner_id=?", (org_id, user_id))
        self._exec("DELETE FROM settings WHERE scope='user' AND scope_id=?", (user_id,))
        return {**counts, "prompt_skills": int(n)}
