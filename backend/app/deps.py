"""Application wiring: one place that builds the storage, billing, gateway."""

from __future__ import annotations

from app.billing.payments import MockPayments
from app.billing.service import Billing
from app.config import settings
from app.gateway import Gateway
from app.providers import build_adapters
from app.schema import Principal
from app.secure import SecureFolder
from app.skills.registry import SKILLS, ResolvedSkill, resolve
from app.storage.base import Storage


def make_storage() -> Storage:
    if settings.storage == "memory":
        from app.storage.sqlite import SqliteStorage

        return SqliteStorage(":memory:")
    if settings.storage == "dynamodb":
        from app.storage.dynamodb import DynamoDBStorage

        return DynamoDBStorage("sift")
    from app.storage.sqlite import SqliteStorage

    return SqliteStorage(settings.sqlite_path)


class App:
    def __init__(self, storage: Storage | None = None, adapters=None, default_plan: str | None = None,
                 daily_budget_usd: float | None = None) -> None:
        self.storage = storage or make_storage()
        self.secure = SecureFolder(self.storage)
        self.billing = Billing(self.storage, MockPayments(), default_plan or settings.default_plan)
        self.gateway = Gateway(
            storage=self.storage,
            adapters=adapters if adapters is not None else build_adapters(),
            settings_for=self.skill_settings,
            charge=self.billing.charge,
            daily_budget_usd=settings.daily_budget_usd if daily_budget_usd is None else daily_budget_usd,
            default_output_tokens=settings.default_output_tokens,
            max_output_tokens=settings.max_output_tokens,
        )

    def skill_settings(self, principal: Principal) -> dict[str, ResolvedSkill]:
        org = self.storage.get_settings("org", principal.org_id)
        user = self.storage.get_settings("user", principal.user_id)
        return {s.manifest.id: resolve(s, org.get(s.manifest.id), user.get(s.manifest.id)) for s in SKILLS}
