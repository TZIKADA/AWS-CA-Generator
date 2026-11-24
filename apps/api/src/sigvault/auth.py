import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient

from .config import settings

_bearer = HTTPBearer(auto_error=False)
_jwks = PyJWKClient(f"{settings.cognito_issuer}/.well-known/jwks.json", cache_keys=True)


async def current_claims(c: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> dict:
    if c is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")
    try:
        key = _jwks.get_signing_key_from_jwt(c.credentials).key
        return jwt.decode(
            c.credentials,
            key,
            algorithms=["RS256"],
            audience=settings.cognito_client_id,
            issuer=settings.cognito_issuer,
        )
    except Exception as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "invalid or expired bearer token",
        ) from exc
