"""Sift's plans.

Pricing principle: every plan states how much of its price is model usage
(passed through at cost) and how much is Sift. A transparency product can't
hide its own margin.
"""

from __future__ import annotations

from pydantic import BaseModel


class Plan(BaseModel):
    id: str
    name: str
    tagline: str
    price_usd: float  # per month (per seat for team)
    included_usage_usd: float  # model usage at cost, per month (per seat for team)
    per_seat: bool = False
    models: list[str] | None  # live model ids allowed; None = all
    features: list[str]  # feature flags the app checks
    highlights: list[str]  # what the plans page lists

    @property
    def sift_fee_usd(self) -> float:
        return round(self.price_usd - self.included_usage_usd, 2)


HAIKU = "claude-haiku-5-5"
SONNET = "claude-sonnet-5-5"

PLANS: dict[str, Plan] = {
    p.id: p
    for p in [
        Plan(
            id="free",
            name="Free",
            tagline="Try every transparency and privacy feature.",
            price_usd=0,
            included_usage_usd=0.25,
            models=[HAIKU],
            features=[],
            highlights=[
                "$0.25 of Claude Haiku usage each month (hundreds of messages)",
                "Full traces, cost per message and PII redaction",
                "Free mock models for unlimited practice",
            ],
        ),
        Plan(
            id="plus",
            name="Plus",
            tagline="For everyday use with stronger models.",
            price_usd=9,
            included_usage_usd=6,
            models=[HAIKU, SONNET],
            features=["topups"],
            highlights=[
                "$6 of model usage at cost, $3 for Sift",
                "Claude Haiku and Sonnet",
                "Usage dashboard and per-message spend limits",
                "Top up anytime at cost plus 10%",
            ],
        ),
        Plan(
            id="pro",
            name="Pro",
            tagline="Every model, side-by-side comparison.",
            price_usd=24,
            included_usage_usd=18,
            models=None,
            features=["topups", "compare"],
            highlights=[
                "$18 of model usage at cost, $6 for Sift",
                "Every model, including Claude Opus",
                "Compare models side by side on the same prompt",
                "Top up anytime at cost plus 10%",
            ],
        ),
        Plan(
            id="team",
            name="Team",
            tagline="Shared rules for everyone in your workspace.",
            price_usd=18,
            included_usage_usd=12,
            per_seat=True,
            models=None,
            features=["topups", "compare", "workspace_policy"],
            highlights=[
                "Per seat: $12 of model usage at cost, $6 for Sift, pooled across the team",
                "Lock skills for everyone, such as required PII redaction",
                "Every model and side-by-side comparison",
                "Single sign-on (coming with AWS Cognito)",
            ],
        ),
    ]
}

TOPUP_FEE = 0.10
TOPUP_AMOUNTS = [5, 10, 25]
