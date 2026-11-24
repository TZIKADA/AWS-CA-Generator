import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import current_claims
from ..db import get_db
from ..models import Membership, Org, User
from ..schemas import OrgCreate, OrgRead

router = APIRouter(tags=["orgs"])


async def _user(db: AsyncSession, claims: dict) -> User:
    sub = claims["sub"]
    email = claims.get("email") or f"{sub}@unknown"
    user = (await db.execute(select(User).where(User.cognito_sub == sub))).scalar_one_or_none()
    if user is None:
        user = User(cognito_sub=sub, email=email)
        db.add(user)
        await db.flush()
    return user


@router.get("/orgs", response_model=list[OrgRead])
async def list_orgs(claims=Depends(current_claims), db: AsyncSession = Depends(get_db)):
    user = await _user(db, claims)
    await db.commit()
    rows = (
        (
            await db.execute(
                select(Org)
                .join(Membership, Membership.org_id == Org.id)
                .where(Membership.user_id == user.id)
            )
        )
        .scalars()
        .all()
    )
    return rows


@router.post("/orgs", response_model=OrgRead, status_code=201)
async def create_org(
    body: OrgCreate,
    claims=Depends(current_claims),
    db: AsyncSession = Depends(get_db),
):
    user = await _user(db, claims)
    org = Org(id=uuid.uuid4(), name=body.name)
    db.add(org)
    await db.flush()
    db.add(Membership(org_id=org.id, user_id=user.id, role="admin"))
    await db.commit()
    return org
