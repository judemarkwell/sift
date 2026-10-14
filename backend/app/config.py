"""Settings, read from the environment (and backend/.env for local dev).

Secrets never live in code or in git. In AWS these same variables will come
from Secrets Manager.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    anthropic_api_key: str | None
    # Hard ceiling on spend per UTC day across everyone, so a bug or abuse
    # can't run up an unbounded bill. 0 disables the cap.
    daily_budget_usd: float
    max_output_tokens: int
    enable_mock_models: bool


settings = Settings(
    anthropic_api_key=os.getenv("ANTHROPIC_API_KEY") or None,
    daily_budget_usd=_float("SIFT_DAILY_BUDGET_USD", 2.0),
    max_output_tokens=int(_float("SIFT_MAX_OUTPUT_TOKENS", 2048)),
    enable_mock_models=os.getenv("SIFT_ENABLE_MOCK_MODELS", "true").lower() != "false",
)
