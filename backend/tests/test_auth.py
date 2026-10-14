"""Cognito sign-in, tested with locally generated keys (no AWS needed)."""

import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app import main
from app.auth import AuthError, CognitoAuth, CognitoVerifier, LocalAuth
from app.deps import App
from app.storage.sqlite import SqliteStorage

REGION, POOL, CLIENT = "us-east-1", "us-east-1_TEST", "client123"
ISSUER = f"https://cognito-idp.{REGION}.amazonaws.com/{POOL}"


def _keypair(kid):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    return key, {**jwk, "kid": kid, "alg": "RS256", "use": "sig"}


KEY, JWK = _keypair("k1")
OTHER_KEY, _ = _keypair("k1")  # same key ID, different key: a forgery


class Jwks:
    def __init__(self):
        self.keys = [JWK]
        self.calls = 0

    def __call__(self, url):
        assert url == f"{ISSUER}/.well-known/jwks.json"
        self.calls += 1
        return {"keys": self.keys}


def token(sub="user-a", email="a@example.com", key=KEY, kid="k1", **over):
    now = int(time.time())
    claims = {"sub": sub, "email": email, "iss": ISSUER, "aud": CLIENT, "token_use": "id",
              "iat": now, "exp": now + 3600, **over}
    return jwt.encode({k: v for k, v in claims.items() if v is not None}, key, algorithm="RS256",
                      headers={"kid": kid})


@pytest.fixture()
def jwks():
    return Jwks()


@pytest.fixture()
def verifier(jwks):
    return CognitoVerifier(REGION, POOL, CLIENT, fetch_jwks=jwks)


@pytest.fixture()
def api(verifier):
    storage = SqliteStorage(":memory:")
    test_app = App(storage=storage, adapters=[], default_plan="free", daily_budget_usd=0,
                   auth=CognitoAuth(verifier, storage))
    main.app.dependency_overrides[main.get_app] = lambda: test_app
    with TestClient(main.app) as c:
        yield c
    main.app.dependency_overrides.clear()


def bearer(t):
    return {"Authorization": f"Bearer {t}"}


def test_valid_token_and_cached_keys(verifier, jwks):
    assert verifier.verify(token())["sub"] == "user-a"
    verifier.verify(token(sub="user-b"))
    assert jwks.calls == 1  # keys fetched once


@pytest.mark.parametrize(
    "bad,why",
    [
        (lambda: token(exp=int(time.time()) - 120), "expired"),
        (lambda: token(aud="someone-else"), "Invalid"),
        (lambda: token(iss="https://cognito-idp.us-east-1.amazonaws.com/other"), "Invalid"),
        (lambda: token(token_use="access"), "ID token"),
        (lambda: token(key=OTHER_KEY), "Invalid"),
        (lambda: token(sub=None), "Invalid"),
        (lambda: jwt.encode({"sub": "x"}, "secret", algorithm="HS256", headers={"kid": "k1"}), "algorithm"),
        (lambda: "not.a.token", "Malformed"),
    ],
)
def test_bad_tokens_are_refused(verifier, bad, why):
    with pytest.raises(AuthError, match=why):
        verifier.verify(bad())


def test_unknown_key_refetches_at_most_once_a_minute(verifier, jwks):
    for _ in range(5):
        with pytest.raises(AuthError, match="Unknown signing key"):
            verifier.verify(token(kid="rotated"))
    assert jwks.calls == 1
    # After a real rotation (and the cooldown), the new key is picked up.
    new_key, new_jwk = _keypair("rotated")
    jwks.keys = [JWK, new_jwk]
    verifier._fetched_at -= 61
    assert verifier.verify(token(key=new_key, kid="rotated"))["sub"] == "user-a"


def test_api_requires_sign_in(api):
    r = api.get("/api/me")
    assert r.status_code == 401 and r.json()["detail"]["code"] == "signed_out"
    assert r.headers["www-authenticate"] == "Bearer"
    assert api.get("/api/me", headers={"Authorization": "Basic abc"}).status_code == 401
    assert api.get("/api/me", headers=bearer(token(token_use="access"))).status_code == 401
    # health and the sign-in config stay public
    assert api.get("/api/health").status_code == 200
    assert api.get("/api/auth/config").json()["mode"] == "cognito"


def test_first_sign_in_creates_a_free_workspace_once(api):
    me = api.get("/api/me", headers=bearer(token())).json()
    assert me["principal"]["email"] == "a@example.com" and me["principal"]["role"] == "admin"
    assert me["plan_id"] == "free"
    org = me["principal"]["org_id"]
    assert api.get("/api/me", headers=bearer(token())).json()["principal"]["org_id"] == org
    # someone else gets their own workspace, and can't see the first user's data
    other = api.get("/api/me", headers=bearer(token(sub="user-b", email="b@example.com"))).json()
    assert other["principal"]["org_id"] != org


def test_workspaces_are_isolated(api):
    a, b = bearer(token()), bearer(token(sub="user-b", email="b@example.com"))
    api.post("/api/secure/pin", json={"pin": "2468"}, headers=a)
    assert api.get("/api/secure", headers=a).json()["pin_set"]
    assert not api.get("/api/secure", headers=b).json()["pin_set"]
    created = api.post("/api/prompt-skills", headers=a, json={"name": "Mine", "instructions": "x"}).json()
    assert [s["name"] for s in api.get("/api/prompt-skills", headers=b).json()["skills"]] == []
    assert api.delete(f"/api/prompt-skills/{created['id']}", headers=b).status_code == 404


def test_local_mode_refuses_tokens():
    with pytest.raises(AuthError):
        LocalAuth().principal("Bearer something")
    assert LocalAuth().principal(None).user_id == "user_local"
