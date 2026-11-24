import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import queue, storage
from ..auth import current_claims
from ..db import get_db
from ..models import Document, Job, Membership, SigningKey, User
from ..schemas import DocumentCreate, DocumentRead, DocumentUploadResponse, SignRequest

router = APIRouter(tags=["documents"])


async def _user(db: AsyncSession, claims: dict) -> User:
    user = (
        await db.execute(select(User).where(User.cognito_sub == claims["sub"]))
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(403, "user not provisioned")
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


@router.get("/orgs/{org_id}/documents", response_model=list[DocumentRead])
async def list_documents(
    org_id: uuid.UUID, claims=Depends(current_claims), db: AsyncSession = Depends(get_db)
):
    user = await _user(db, claims)
    await _membership(db, user, org_id, roles=("admin", "member", "auditor"))
    rows = (
        (
            await db.execute(
                select(Document)
                .where(Document.org_id == org_id)
                .order_by(Document.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return rows


@router.post("/orgs/{org_id}/documents", response_model=DocumentUploadResponse, status_code=201)
async def create_document(
    org_id: uuid.UUID,
    body: DocumentCreate,
    claims=Depends(current_claims),
    db: AsyncSession = Depends(get_db),
):
    user = await _user(db, claims)
    await _membership(db, user, org_id, roles=("admin", "member"))

    doc = Document(
        id=uuid.uuid4(),
        org_id=org_id,
        uploader_id=user.id,
        filename=body.filename,
        s3_upload_key="",
        status="uploaded",
    )
    doc.s3_upload_key = f"uploads/{org_id}/{doc.id}"
    db.add(doc)
    await db.commit()

    return DocumentUploadResponse(
        document_id=doc.id,
        upload_url=storage.upload_url(str(org_id), str(doc.id), body.content_type),
    )


@router.post("/orgs/{org_id}/documents/{doc_id}/sign", status_code=202)
async def sign_document(
    org_id: uuid.UUID,
    doc_id: uuid.UUID,
    body: SignRequest,
    claims=Depends(current_claims),
    db: AsyncSession = Depends(get_db),
):
    user = await _user(db, claims)
    await _membership(db, user, org_id, roles=("admin", "member"))

    doc = (
        await db.execute(
            select(Document).where(
                Document.id == doc_id,
                Document.org_id == org_id,
            )
        )
    ).scalar_one_or_none()
    if doc is None:
        raise HTTPException(404, "document not found")

    key = (
        await db.execute(
            select(SigningKey).where(
                SigningKey.id == body.key_id,
                SigningKey.org_id == org_id,
            )
        )
    ).scalar_one_or_none()
    if key is None:
        raise HTTPException(404, "signing key not found")
    if key.revoked_at is not None:
        raise HTTPException(400, "signing key is revoked")

    job = Job(id=uuid.uuid4(), org_id=org_id, document_id=doc.id, key_id=key.id, status="pending")
    db.add(job)
    doc.status = "queued"
    await db.commit()

    queue.enqueue({"job_id": str(job.id)})
    return {"job_id": str(job.id)}


@router.get("/orgs/{org_id}/documents/{doc_id}/download")
async def download_document(
    org_id: uuid.UUID,
    doc_id: uuid.UUID,
    claims=Depends(current_claims),
    db: AsyncSession = Depends(get_db),
):
    user = await _user(db, claims)
    await _membership(db, user, org_id, roles=("admin", "member", "auditor"))
    doc = (
        await db.execute(
            select(Document).where(
                Document.id == doc_id,
                Document.org_id == org_id,
            )
        )
    ).scalar_one_or_none()
    if doc is None:
        raise HTTPException(404, "document not found")
    if doc.s3_signed_key is None:
        raise HTTPException(409, "document is not signed yet")
    return {"download_url": storage.download_url(str(org_id), str(doc.id))}
