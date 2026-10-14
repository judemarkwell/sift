"""Who is calling.

Two modes, chosen by SIFT_AUTH:

- "local" (default): no sign-in. Every request runs as one local admin user,
  so the app works on a laptop with no AWS at all.
- "cognito": every request must carry `Authorization: Bearer <ID token>`
  from the Sift Cognito user pool (infra/lib/auth-stack.ts). The token's
  signature is checked against the pool's published keys, plus its issuer,
  audience (our app client), expiry and type. A user's first request creates
  their personal workspace; after that they always map to it.

The browser sends the ID token (not the access token) because it carries the
user's email and is issued to exactly our app client, which is what this
first-party API needs. Nothing else in the app changes between modes: every
route depends on `current_principal` in main.py, which calls `principal()`.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.request
from typing import Any, Callable, Protocol

import jwt

from app.config import settings
from app.schema import Principal, new_id, utcnow
from app.storage.base import Storage

LOCAL_PRINCIPAL = Principal(
    org_id="org_local",
    user_id="user_local",
    email=settings.dev_user_email,
    role="admin",
)


class AuthError(Exception):
    """The request isn't signed in (or the token isn't acceptable)."""


class Auth(Protocol):
    mode: str

    def principal(self, authorization: str | None) -> Principal: ...


class LocalAuth:
    mode = "local"

    def principal(self, authorization: str | None) -> Principal:
        if authorization:
            # A token was sent to a build that can't check it. Refuse rather
            # than silently ignore it, so this can't ship to production by accident.
            raise AuthError("Token sign-in isn't enabled in this build (SIFT_AUTH=local).")
        return LOCAL_PRINCIPAL


class CognitoVerifier:
    """Checks Cognito ID tokens. The pool's signing keys are fetched once and
    cached; an unknown key ID triggers at most one refetch a minute (Cognito
    rotates keys rarely, and this stops bad tokens from hammering the endpoint)."""

    REFETCH_AFTER_SECONDS = 60
    LEEWAY_SECONDS = 30  # clock skew between Cognito and this server

    def __init__(self, region: str, user_pool_id: str, client_id: str,
                 fetch_jwks: Callable[[str], dict[str, Any]] | None = None) -> None:
        if not (user_pool_id and client_id):
            raise ValueError("SIFT_AUTH=cognito needs SIFT_COGNITO_USER_POOL_ID and SIFT_COGNITO_CLIENT_ID.")
        self.issuer = f"https://cognito-idp.{region}.amazonaws.com/{user_pool_id}"
        self.client_id = client_id
        self._fetch = fetch_jwks or self._fetch_http
        self._keys: dict[str, Any] = {}
        self._fetched_at = 0.0
        self._lock = threading.Lock()

    @staticmethod
    def _fetch_http(url: str) -> dict[str, Any]:
        with urllib.request.urlopen(url, timeout=5) as resp:  # noqa: S310 (fixed https URL)
            return json.load(resp)

    def _key(self, kid: str) -> Any:
        with self._lock:
            if kid not in self._keys and time.time() - self._fetched_at > self.REFETCH_AFTER_SECONDS:
                self._fetched_at = time.time()
                jwks = jwt.PyJWKSet.from_dict(self._fetch(f"{self.issuer}/.well-known/jwks.json"))
                self._keys = {k.key_id: k.key for k in jwks.keys if k.key_id}
            if kid not in self._keys:
                raise AuthError("Unknown signing key.")
            return self._keys[kid]

    def verify(self, token: str) -> dict[str, Any]:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise AuthError("Malformed token.") from exc
        if header.get("alg") != "RS256" or not header.get("kid"):
            raise AuthError("Unexpected token algorithm.")
        try:
            claims = jwt.decode(
                token,
                self._key(header["kid"]),
                algorithms=["RS256"],
                audience=self.client_id,
                issuer=self.issuer,
                leeway=self.LEEWAY_SECONDS,
                options={"require": ["exp", "iat", "iss", "aud", "sub"]},
            )
        except jwt.ExpiredSignatureError as exc:
            raise AuthError("Your sign-in has expired.") from exc
        except jwt.PyJWTError as exc:
            raise AuthError("Invalid token.") from exc
        if claims.get("token_use") != "id":
            raise AuthError("Send the ID token, not the access token.")
        return claims


class CognitoAuth:
    mode = "cognito"

    def __init__(self, verifier: CognitoVerifier, storage: Storage) -> None:
        self.verifier = verifier
        self.storage = storage

    def principal(self, authorization: str | None) -> Principal:
        scheme, _, token = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not token.strip():
            raise AuthError("Sign in to continue.")
        claims = self.verifier.verify(token.strip())
        user_id = claims["sub"]
        email = claims.get("email") or ""
        member = self.storage.get_member(user_id)
        if member is None:
            # First sign-in: a personal workspace, with this user as its admin.
            member = self.storage.add_member_if_absent({
                "user_id": user_id,
                "org_id": new_id("org"),
                "role": "admin",
                "email": email,
                "created_at": utcnow().isoformat(),
            })
        return Principal(org_id=member["org_id"], user_id=user_id, email=email or member.get("email", ""),
                         role=member.get("role", "member"))


def make_auth(storage: Storage) -> Auth:
    if settings.auth_mode == "cognito":
        verifier = CognitoVerifier(settings.cognito_region, settings.cognito_user_pool_id, settings.cognito_client_id)
        return CognitoAuth(verifier, storage)
    if settings.auth_mode != "local":
        raise ValueError(f"Unknown SIFT_AUTH={settings.auth_mode!r}; use 'local' or 'cognito'.")
    return LocalAuth()
