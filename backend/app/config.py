"""Settings, read from the environment (and backend/.env for local dev).

Secrets never live in code or in git. In AWS these same variables are
filled from Secrets Manager / SSM by the task definition (see infra/).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_DIR / ".env")


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    anthropic_api_key: str | None
    # Hard ceiling on real-model spend per UTC day across everyone, so a bug
    # or abuse can't run up an unbounded bill. 0 disables the cap.
    daily_budget_usd: float
    max_output_tokens: int
    enable_mock_models: bool
    storage: str  # "sqlite" | "memory" | "dynamodb"
    sqlite_path: str
    # Plan a brand-new account starts on. "pro" locally so every model can be
    # tried; production would use "free".
    default_plan: str
    # Local stand-in for a signed-in Cognito user.
    dev_user_email: str


settings = Settings(
    anthropic_api_key=os.getenv("ANTHROPIC_API_KEY") or None,
    daily_budget_usd=_float("SIFT_DAILY_BUDGET_USD", 2.0),
    max_output_tokens=int(_float("SIFT_MAX_OUTPUT_TOKENS", 2048)),
    enable_mock_models=os.getenv("SIFT_ENABLE_MOCK_MODELS", "true").lower() != "false",
    storage=os.getenv("SIFT_STORAGE", "sqlite"),
    sqlite_path=os.getenv("SIFT_SQLITE_PATH", str(BACKEND_DIR / "data" / "sift.db")),
    default_plan=os.getenv("SIFT_DEFAULT_PLAN", "pro"),
    dev_user_email=os.getenv("SIFT_DEV_USER", "you@example.com"),
)
