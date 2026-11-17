"""Sign-in check for the hosted demo.

When `SUPABASE_URL` is set, the server is in hosted mode. Each request then
carries a Supabase access token in place of the shared club token. The token is
a JWT signed with ES256. This module checks it locally with the public keys
that Supabase publishes, and then checks the email against `ALLOWED_EMAILS`.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any, Literal

import jwt

SUPABASE_URL_ENV = "SUPABASE_URL"
ALLOWED_EMAILS_ENV = "ALLOWED_EMAILS"
ALLOWED_ORIGINS_ENV = "ALLOWED_ORIGINS"

Verdict = Literal["ok", "invalid", "not_invited"]

# Returns the public key that signed `token`. The default asks the Supabase
# key endpoint; tests give a key that they generate.
KeyLookup = Callable[[str], Any]


def _env_list(name: str) -> list[str]:
    raw = os.environ.get(name, "")
    return [item.strip() for item in raw.split(",") if item.strip()]


def allowed_origins() -> list[str]:
    return [origin.rstrip("/") for origin in _env_list(ALLOWED_ORIGINS_ENV)]


def jwks_key_lookup(supabase_url: str) -> KeyLookup:
    client = jwt.PyJWKClient(
        f"{supabase_url}/auth/v1/.well-known/jwks.json", cache_keys=True
    )
    return lambda token: client.get_signing_key_from_jwt(token).key


class HostedAuth:
    def __init__(
        self,
        supabase_url: str,
        allowed_emails: list[str],
        *,
        key_lookup: KeyLookup | None = None,
    ) -> None:
        self.supabase_url = supabase_url.rstrip("/")
        self.allowed_emails = frozenset(e.lower() for e in allowed_emails)
        self._key_lookup = key_lookup or jwks_key_lookup(self.supabase_url)

    @classmethod
    def from_env(cls) -> HostedAuth | None:
        url = os.environ.get(SUPABASE_URL_ENV, "").strip()
        if not url:
            return None
        return cls(url, _env_list(ALLOWED_EMAILS_ENV))

    def check(self, token: str) -> Verdict:
        if not token:
            return "invalid"
        try:
            claims = jwt.decode(
                token,
                self._key_lookup(token),
                algorithms=["ES256"],
                audience="authenticated",
                issuer=self.supabase_url + "/auth/v1",
                options={"require": ["exp", "aud", "iss"]},
            )
        except Exception:
            return "invalid"
        email = (claims.get("email") or "").strip().lower()
        if email in self.allowed_emails:
            return "ok"
        return "not_invited"
