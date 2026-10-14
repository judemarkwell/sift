"""Secure folder: chats hidden behind a numeric PIN.

This is a privacy screen, not encryption. It keeps chosen chats out of the
sidebar, activity and usage pages so they can't be seen over a shoulder or
on a shared screen. The data itself is stored like any other chat.

The PIN is stored only as a salted scrypt hash in the user's settings. A
correct PIN returns an unlock token: an HMAC-signed (user, generation,
expiry) string sent back as the X-Sift-Unlock header. Tokens are stateless,
so they work across several API containers; locking bumps the generation,
which invalidates every token issued before it.

Brute force is limited server-side: after MAX_FAILURES wrong PINs, unlocking
pauses for LOCKOUT. (A 4-8 digit PIN is only strong because of that limit.)
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import time
from dataclasses import dataclass
from typing import Any

from app.storage.base import Storage

PIN_RE = re.compile(r"^\d{4,8}$")
MAX_FAILURES = 5
LOCKOUT_SECONDS = 5 * 60
# A backstop only: the app ends access when the user leaves the chat or the
# folder. There is deliberately no inactivity timer.
TOKEN_MAX_AGE_SECONDS = 12 * 60 * 60
SETTINGS_KEY = "_secure"


class PinError(Exception):
    def __init__(self, message: str, code: str, retry_after: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.retry_after = retry_after


def _hash(pin: str, salt: bytes) -> str:
    return base64.b64encode(hashlib.scrypt(pin.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)).decode()


@dataclass
class SecureStatus:
    pin_set: bool
    unlocked: bool
    retry_after_seconds: int


class SecureFolder:
    def __init__(self, storage: Storage, secret: str | None = None) -> None:
        self.storage = storage
        # Without a configured secret, tokens last until the API restarts.
        self._key = (secret or os.getenv("SIFT_SECRET_KEY") or os.urandom(32).hex()).encode()

    # ---- stored state ----

    def _state(self, user_id: str) -> dict[str, Any]:
        return self.storage.get_settings("user", user_id).get(SETTINGS_KEY, {})

    def _save(self, user_id: str, state: dict[str, Any]) -> None:
        data = self.storage.get_settings("user", user_id)
        data[SETTINGS_KEY] = state
        self.storage.put_settings("user", user_id, data)

    def pin_set(self, user_id: str) -> bool:
        return bool(self._state(user_id).get("hash"))

    def retry_after(self, user_id: str) -> int:
        return max(int(self._state(user_id).get("locked_until", 0) - time.time()), 0)

    # ---- tokens ----

    def _sign(self, payload: str) -> str:
        return hmac.new(self._key, payload.encode(), hashlib.sha256).hexdigest()[:32]

    def _issue(self, user_id: str, state: dict[str, Any]) -> str:
        payload = f"{user_id}.{state.get('generation', 0)}.{int(time.time()) + TOKEN_MAX_AGE_SECONDS}"
        return f"{payload}.{self._sign(payload)}"

    def is_unlocked(self, user_id: str, token: str | None) -> bool:
        if not token or token.count(".") != 3:
            return False
        payload, sig = token.rsplit(".", 1)
        if not hmac.compare_digest(sig, self._sign(payload)):
            return False
        uid, gen, exp = payload.split(".")
        state = self._state(user_id)
        return uid == user_id and gen == str(state.get("generation", 0)) and int(exp) > time.time()

    # ---- actions ----

    def set_pin(self, user_id: str, pin: str) -> str:
        if self.pin_set(user_id):
            raise PinError("A PIN is already set.", "pin_exists")
        if not PIN_RE.match(pin):
            raise PinError("Use 4 to 8 digits.", "pin_format")
        salt = os.urandom(16)
        state = {"salt": base64.b64encode(salt).decode(), "hash": _hash(pin, salt), "failures": 0,
                 "locked_until": 0, "generation": 0}
        self._save(user_id, state)
        return self._issue(user_id, state)

    def unlock(self, user_id: str, pin: str) -> str:
        state = self._state(user_id)
        if not state.get("hash"):
            raise PinError("Set a PIN first.", "pin_required")
        wait = self.retry_after(user_id)
        if wait:
            raise PinError(f"Too many wrong PINs. Try again in {wait // 60 + 1} min.", "pin_lockout", wait)
        ok = hmac.compare_digest(_hash(pin, base64.b64decode(state["salt"])), state["hash"])
        if not ok:
            state["failures"] = state.get("failures", 0) + 1
            if state["failures"] >= MAX_FAILURES:
                state["failures"] = 0
                state["locked_until"] = time.time() + LOCKOUT_SECONDS
                self._save(user_id, state)
                raise PinError("Too many wrong PINs. Try again in 5 min.", "pin_lockout", LOCKOUT_SECONDS)
            self._save(user_id, state)
            left = MAX_FAILURES - state["failures"]
            raise PinError(f"Wrong PIN. {left} tr{'y' if left == 1 else 'ies'} left.", "pin_wrong")
        state["failures"] = 0
        self._save(user_id, state)
        return self._issue(user_id, state)

    def lock(self, user_id: str) -> None:
        """End every unlock for this user (all tabs)."""
        state = self._state(user_id)
        if state.get("hash"):
            state["generation"] = state.get("generation", 0) + 1
            self._save(user_id, state)

    def status(self, user_id: str, token: str | None) -> SecureStatus:
        return SecureStatus(self.pin_set(user_id), self.is_unlocked(user_id, token), self.retry_after(user_id))
