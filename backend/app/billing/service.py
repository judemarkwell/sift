"""Accounts, usage allowance, credits and the ledger.

Each org has two balances:
  allowance  the plan's included usage; resets every billing period
  credit     top-ups; never expire

Live-model charges come out of the allowance first, then credit. Mock models
are free. The ledger is the human-readable history of every change.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from pydantic import BaseModel

from app.billing.payments import PaymentProvider
from app.billing.plans import PLANS, TOPUP_AMOUNTS, TOPUP_FEE, Plan
from app.schema import ModelInfo, Trace, new_id, utcnow
from app.storage.base import Storage

PERIOD = timedelta(days=30)


class PlanError(Exception):
    """A request the user's plan doesn't allow. Message is shown as-is."""

    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


class Account(BaseModel):
    org_id: str
    plan_id: str
    seats: int = 1
    period_start: datetime
    period_end: datetime
    allowance_usd: float
    credit_usd: float = 0.0

    @property
    def plan(self) -> Plan:
        return PLANS[self.plan_id]

    @property
    def included_usd(self) -> float:
        return self.plan.included_usage_usd * self.seats

    @property
    def available_usd(self) -> float:
        return max(self.allowance_usd, 0) + max(self.credit_usd, 0)


class Billing:
    def __init__(self, storage: Storage, payments: PaymentProvider, default_plan: str = "free") -> None:
        self.storage = storage
        self.payments = payments
        self.default_plan = default_plan if default_plan in PLANS else "free"

    # ---- accounts ----------------------------------------------------------

    def _ledger(self, org_id: str, kind: str, amount: float, description: str, **extra: Any) -> None:
        self.storage.add_ledger(
            org_id,
            {
                "id": new_id("led"),
                "created_at": utcnow().isoformat(),
                "kind": kind,
                "amount_usd": round(amount, 6),
                "description": description,
                **extra,
            },
        )

    def _save(self, acct: Account) -> None:
        self.storage.put_account(acct.org_id, acct.model_dump(mode="json"))

    def account(self, org_id: str) -> Account:
        raw = self.storage.get_account(org_id)
        now = utcnow()
        if raw is None:
            plan = PLANS[self.default_plan]
            acct = Account(
                org_id=org_id,
                plan_id=plan.id,
                period_start=now,
                period_end=now + PERIOD,
                allowance_usd=plan.included_usage_usd,
            )
            self._save(acct)
            self._ledger(org_id, "allowance", acct.allowance_usd, f"{plan.name} plan: monthly usage included")
            return acct
        acct = Account(**raw)
        if now >= acct.period_end:
            # New period: unused allowance expires, top-up credit carries over.
            while now >= acct.period_end:
                acct.period_start = acct.period_end
                acct.period_end = acct.period_start + PERIOD
            acct.allowance_usd = acct.included_usd
            self._save(acct)
            self._ledger(org_id, "allowance", acct.allowance_usd, f"{acct.plan.name} plan: new month of usage")
        return acct

    # ---- enforcement ---------------------------------------------------------

    def has_feature(self, org_id: str, feature: str) -> bool:
        return feature in self.account(org_id).plan.features

    def model_allowed(self, acct: Account, model: ModelInfo) -> bool:
        return not model.live or acct.plan.models is None or model.id in acct.plan.models

    def check(self, org_id: str, model: ModelInfo) -> Account:
        acct = self.account(org_id)
        if not model.live:
            return acct
        if not self.model_allowed(acct, model):
            needed = next(p for p in PLANS.values() if p.models is None or model.id in p.models)
            raise PlanError(f"{model.name} is available on the {needed.name} plan and above.", "model_not_in_plan")
        if acct.available_usd <= 0:
            raise PlanError(
                "You've used this month's included usage. Top up, upgrade, or keep using the free mock models.",
                "out_of_usage",
            )
        return acct

    def charge(self, trace: Trace, model: ModelInfo) -> float:
        cost = trace.response.cost.total_usd
        if not model.live or cost <= 0:
            return 0.0
        acct = self.account(trace.org_id)
        from_allowance = min(cost, max(acct.allowance_usd, 0))
        acct.allowance_usd -= from_allowance
        acct.credit_usd -= cost - from_allowance  # may dip slightly below 0 on the last message
        self._save(acct)
        self._ledger(
            trace.org_id,
            "usage",
            -cost,
            f"{model.name}",
            trace_id=trace.id,
            user_id=trace.user_id,
        )
        return cost

    # ---- checkout ---------------------------------------------------------

    def start_checkout(self, org_id: str, *, plan_id: str | None = None, topup_usd: float | None = None, seats: int = 1) -> dict:
        if plan_id:
            if plan_id not in PLANS:
                raise PlanError("Unknown plan.", "bad_plan")
            plan = PLANS[plan_id]
            amount = plan.price_usd * (seats if plan.per_seat else 1)
            item = {"type": "plan", "plan_id": plan_id, "seats": seats if plan.per_seat else 1}
            label = f"Sift {plan.name}" + (f" × {seats} seats" if plan.per_seat else "")
        elif topup_usd:
            acct = self.account(org_id)
            if "topups" not in acct.plan.features:
                raise PlanError("Top-ups are available on Plus and above.", "no_topups")
            if topup_usd not in TOPUP_AMOUNTS:
                raise PlanError(f"Top-ups come in {', '.join(f'${a}' for a in TOPUP_AMOUNTS)}.", "bad_amount")
            amount = round(topup_usd * (1 + TOPUP_FEE), 2)
            item = {"type": "topup", "credit_usd": topup_usd}
            label = f"${topup_usd} of usage credit"
        else:
            raise PlanError("Nothing to buy.", "bad_request")
        return self.payments.create_checkout(org_id, amount_usd=amount, label=label, item=item)

    def complete_checkout(self, org_id: str, checkout_id: str) -> Account:
        session = self.payments.confirm(org_id, checkout_id)
        item = session["item"]
        acct = self.account(org_id)
        now = utcnow()
        if item["type"] == "plan":
            plan = PLANS[item["plan_id"]]
            acct.plan_id = plan.id
            acct.seats = item["seats"]
            acct.period_start, acct.period_end = now, now + PERIOD
            acct.allowance_usd = acct.included_usd
            self._save(acct)
            self._ledger(
                org_id,
                "plan",
                acct.allowance_usd,
                f"Switched to {plan.name}: monthly usage included",
                paid_usd=session["amount_usd"],
            )
        else:
            acct.credit_usd += item["credit_usd"]
            self._save(acct)
            self._ledger(
                org_id, "topup", item["credit_usd"], "Usage credit top-up", paid_usd=session["amount_usd"]
            )
        return acct

    def summary(self, org_id: str) -> dict:
        acct = self.account(org_id)
        used = max(acct.included_usd - acct.allowance_usd, 0)
        return {
            "plan": acct.plan.model_dump() | {"sift_fee_usd": acct.plan.sift_fee_usd},
            "seats": acct.seats,
            "period_start": acct.period_start,
            "period_end": acct.period_end,
            "included_usd": round(acct.included_usd, 6),
            "allowance_remaining_usd": round(max(acct.allowance_usd, 0), 6),
            "allowance_used_usd": round(used, 6),
            "credit_usd": round(max(acct.credit_usd, 0), 6),
            "available_usd": round(acct.available_usd, 6),
            "test_mode": self.payments.test_mode,
        }

