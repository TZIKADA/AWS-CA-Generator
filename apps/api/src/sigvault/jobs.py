import uuid

import structlog
from sqlalchemy import select

from . import gnupg, kms
from .config import settings
from .db import SessionLocal
from .models import Document, Job, SigningKey
from .storage import _s3  # direct boto3 client for the worker path

log = structlog.get_logger()


async def process(payload: dict) -> None:
    job_id = uuid.UUID(payload["job_id"])
    async with SessionLocal() as db:
        job = (await db.execute(select(Job).where(Job.id == job_id))).scalar_one_or_none()
        if job is None:
            log.warning("job_missing", job_id=str(job_id))
            return
        if job.status == "done":
            log.info("job_already_done", job_id=str(job_id))
            return

        doc = (
            await db.execute(select(Document).where(Document.id == job.document_id))
        ).scalar_one()
        key = (await db.execute(select(SigningKey).where(SigningKey.id == job.key_id))).scalar_one()

        try:
            src = _s3.get_object(Bucket=settings.documents_bucket, Key=doc.s3_upload_key)[
                "Body"
            ].read()
            priv = kms.decrypt_private_key(
                str(job.org_id), str(job.key_id), key.wrapped_private_key, key.encrypted_data_key
            )
            sig = gnupg.sign_detached(priv, src)
            signed_key = f"signed/{job.org_id}/{doc.id}"
            _s3.put_object(
                Bucket=settings.documents_bucket,
                Key=signed_key,
                Body=sig,
                ContentType="application/pgp-signature",
            )
            doc.s3_signed_key = signed_key
            doc.status = "signed"
            job.status = "done"
            await db.commit()
            log.info("job_signed", job_id=str(job_id))
        except Exception as e:
            job.status = "failed"
            job.error = str(e)[:2000]
            doc.status = "failed"
            await db.commit()
            raise
