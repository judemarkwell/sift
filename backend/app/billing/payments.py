"""Payment provider interface, with a test-mode mock.

The real version wraps Stripe Checkout: create_checkout() makes a Checkout
Session and returns its URL; confirm() is driven by Stripe's
checkout.session.completed webhook instead of a button. Nothing here ever
handles card numbers: Stripe's hosted page does.
"""

from __future__ import annotations

from typing import Any, Protocol

from app.schema import new_id, utcnow


class PaymentError(Exception):
    pass


class PaymentProvider(Protocol):
    test_mode: bool

    def create_checkout(self, org_id: str, *, amount_usd: float, label: str, item: dict[str, Any]) -> dict: ...

    def confirm(self, org_id: str, checkout_id: str) -> dict: ...


class MockPayments:
    """Approves everything, charges nothing. For local development."""

    test_mode = True

    def __init__(self) -> None:
        self._sessions: dict[str, dict[str, Any]] = {}

    def create_checkout(self, org_id: str, *, amount_usd: float, label: str, item: dict[str, Any]) -> dict:
        cid = new_id("cs_test")
        session = {
            "id": cid,
            "org_id": org_id,
            "amount_usd": amount_usd,
            "label": label,
            "item": item,
            "status": "open",
            "created_at": utcnow().isoformat(),
            "test_mode": True,
        }
        self._sessions[cid] = session
        return session

    def confirm(self, org_id: str, checkout_id: str) -> dict:
        session = self._sessions.get(checkout_id)
        if not session or session["org_id"] != org_id:
            raise PaymentError("That checkout doesn't exist or has expired.")
        if session["status"] != "open":
            raise PaymentError("That checkout was already completed.")
        session["status"] = "complete"
        return session
