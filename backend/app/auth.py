"""Who is calling.

Locally there's one signed-in user, the admin of their own workspace. In AWS,
CognitoVerifier checks the JWT from the Authorization header against the user
pool's JWKS and maps its claims to a Principal; nothing else in the app
changes because every route already depends on `current_principal`.
"""

from __future__ import annotations

from fastapi import Header, HTTPException

from app.config import settings
from app.schema import Principal

LOCAL_PRINCIPAL = Principal(
    org_id="org_local",
    user_id="user_local",
    email=settings.dev_user_email,
    role="admin",
)


class CognitoVerifier:
    """Placeholder for the real verifier.

    To finish: fetch https://cognito-idp.<region>.amazonaws.com/<pool>/.well-known/jwks.json,
    verify the token's signature, `iss`, `aud`/`client_id` and expiry, then build
    Principal(org_id=claims["custom:org_id"], user_id=claims["sub"],
    email=claims["email"], role=claims.get("custom:role", "member")).
    """

    def __init__(self, user_pool_id: str, client_id: str, region: str) -> None:
        raise NotImplementedError("Cognito isn't set up yet; the app runs as the local user.")


def current_principal(authorization: str | None = Header(default=None)) -> Principal:
    if authorization:
        # A token was sent but there's no verifier yet. Refuse rather than
        # silently ignoring it, so this can't ship to production by accident.
        raise HTTPException(401, "Token sign-in isn't enabled in this build.")
    return LOCAL_PRINCIPAL
