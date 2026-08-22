"""API access control: the token check applied to every route, plus CORS origins.

A configured ZENBAR_API_TOKEN is required from any client (header, bearer, or
?token=). With no token configured, only local clients are allowed unless
ZENBAR_ALLOW_UNAUTHENTICATED_REMOTE is set.
"""

from __future__ import annotations

import os

from fastapi import HTTPException, Header, Query, Request, status


def is_truthy(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


def is_local_client(request: Request) -> bool:
    if request.client is None:
        return False
    return request.client.host in {"127.0.0.1", "::1", "localhost", "testclient"}


def extract_bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer":
        return None
    token = token.strip()
    return token or None


def verify_api_access(
    request: Request,
    x_zenbar_token: str | None = Header(default=None, alias="X-Zenbar-Token"),
    authorization: str | None = Header(default=None),
    token: str | None = Query(default=None),
) -> None:
    configured_token = os.getenv("ZENBAR_API_TOKEN", "").strip()
    provided_token = (x_zenbar_token or extract_bearer_token(authorization) or token or "").strip()
    if configured_token:
        if provided_token != configured_token:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")
        return
    if is_truthy(os.getenv("ZENBAR_ALLOW_UNAUTHENTICATED_REMOTE")):
        return
    if not is_local_client(request):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Remote access requires authentication")


def cors_origins() -> list[str]:
    raw = os.getenv("ZENBAR_CORS_ORIGINS")
    if raw:
        origins = [item.strip() for item in raw.split(",") if item.strip()]
        if origins:
            return origins
    return ["http://127.0.0.1:5173", "http://localhost:5173"]


def allow_credentials_for(origins: list[str]) -> bool:
    return "*" not in origins
