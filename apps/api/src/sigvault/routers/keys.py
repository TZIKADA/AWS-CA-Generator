import shutil
import tempfile
import uuid
from datetime import datetime, timezone

import gnupg
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import kms
from ..auth import current_claims
from ..db import get_db
from ..models import Membership, SigningKey, User
from ..schemas import SigningKeyCreate, SigningKeyRead

router = APIRouter(tags=["keys"])


async def _user(db: AsyncSession, claims: dict) -> User:
    user = (
        await db.execute(select(User).where(User.cognito_sub == claims["sub"]))
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(403, "user not provisioned; call GET /orgs first")
    return user


async def _membership(
    db: AsyncSession, user: User, org_id: uuid.UUID, roles=("admin", "member")
) -> Membership:
    m = (
        await db.execute(
            select(Membership).where(
                Membership.org_id == org_id,
                Membership.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if m is None or m.role not in roles:
        raise HTTPException(403, "not authorized for this org")
    return m


def _fingerprint(private_key_armored: bytes) -> str:
    d = tempfile.mkdtemp()
    try:
        gpg = gnupg.GPG(gnupghome=d)
        r = gpg.import_keys(private_key_armored)
        if not r.fingerprints:
            raise HTTPException(400, "could not import private key")
        return r.fingerprints[0]
    finally:
        shutil.rmtree(d, ignore_errors=True)


@router.get("/orgs/{org_id}/keys", response_model=list[SigningKeyRead])
async def list_keys(
    org_id: uuid.UUID, claims=Depends(current_claims), db: AsyncSession = Depends(get_db)
):
    user = await _user(db, claims)
    await _membership(db, user, org_id, roles=("admin", "member", "auditor"))
    rows = (await db.execute(select(SigningKey).where(SigningKey.org_id == org_id))).scalars().all()
    return rows


@router.post("/orgs/{org_id}/keys", response_model=SigningKeyRead, status_code=201)
async def create_key(
    org_id: uuid.UUID,
    body: SigningKeyCreate,
    claims=Depends(current_claims),
    db: AsyncSession = Depends(get_db),
):
    user = await _user(db, claims)
    await _membership(db, user, org_id, roles=("admin",))
    armored = body.private_key_armored.encode()
    fp = _fingerprint(armored)

    key = SigningKey(
        id=uuid.uuid4(),
        org_id=org_id,
        label=body.label,
        algorithm=body.algorithm,
        fingerprint=fp,
    )
    ct, wrapped = kms.encrypt_private_key(str(org_id), str(key.id), armored)
    key.wrapped_private_key = ct
    key.encrypted_data_key = wrapped
    db.add(key)
    await db.commit()
    return key


@router.delete("/orgs/{org_id}/keys/{key_id}", status_code=204)
async def revoke_key(
    org_id: uuid.UUID,
    key_id: uuid.UUID,
    claims=Depends(current_claims),
    db: AsyncSession = Depends(get_db),
):
    user = await _user(db, claims)
    await _membership(db, user, org_id, roles=("admin",))
    key = (
        await db.execute(
            select(SigningKey).where(
                SigningKey.id == key_id,
                SigningKey.org_id == org_id,
            )
        )
    ).scalar_one_or_none()
    if key is None:
        raise HTTPException(404, "key not found")
    key.revoked_at = datetime.now(timezone.utc)
    await db.commit()
