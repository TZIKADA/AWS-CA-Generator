import json
import os

import boto3
from mangum import Mangum

from .main import app

handler = Mangum(app)

_dynamodb = boto3.resource("dynamodb")
_s3 = boto3.client("s3")


def worker_handler(event, context):
    import pgpy

    table = _dynamodb.Table(os.environ["DYNAMODB_TABLE"])
    bucket = os.environ["DOCUMENTS_BUCKET"]
    for record in event.get("Records", []):
        payload = json.loads(record["body"])
        org_id = payload["org_id"]
        job_id = payload["job_id"]
        job = table.get_item(Key={"PK": f"ORG#{org_id}", "SK": f"JOB#{job_id}"}).get("Item")
        if not job or job.get("status") == "done":
            continue
        doc_id = job["doc_id"]
        key_id = job["key_id"]
        try:
            doc = table.get_item(
                Key={"PK": f"ORG#{org_id}", "SK": f"DOC#{doc_id}"}
            ).get("Item")
            key_item = table.get_item(
                Key={"PK": f"ORG#{org_id}", "SK": f"KEY#{key_id}"}
            ).get("Item")
            if not doc or not key_item:
                raise RuntimeError("job document or signing key is missing")
            if key_item.get("revoked_at"):
                raise RuntimeError("signing key has been revoked")
            uploaded = _s3.get_object(Bucket=bucket, Key=f"uploads/{org_id}/{doc_id}")
            max_bytes = int(os.environ.get("MAX_DOCUMENT_BYTES", 5 * 1024 * 1024))
            if uploaded["ContentLength"] > max_bytes:
                raise RuntimeError(f"document exceeds {max_bytes} byte signing limit")
            source = uploaded["Body"].read()
            armored = _s3.get_object(
                Bucket=bucket, Key=f"keys/{org_id}/{key_id}"
            )["Body"].read()
            key, _ = pgpy.PGPKey.from_blob(armored)
            if key.is_protected:
                raise RuntimeError("encrypted signing keys are not supported")
            message = pgpy.PGPMessage.new(source)
            signature = key.sign(message, detached=True)
            signature_key = f"signed/{org_id}/{doc_id}"
            _s3.put_object(
                Bucket=bucket,
                Key=signature_key,
                Body=str(signature).encode(),
                ServerSideEncryption="AES256",
                ContentType="application/pgp-signature",
            )
            job["status"] = "done"
            table.put_item(Item=job)
            doc.update(status="signed", s3_signed_key=signature_key)
            table.put_item(Item=doc)
        except Exception as exc:
            job.update(status="failed", error=str(exc)[:1000])
            table.put_item(Item=job)
            failed_doc = table.get_item(
                Key={"PK": f"ORG#{org_id}", "SK": f"DOC#{doc_id}"}
            ).get("Item")
            if failed_doc:
                failed_doc["status"] = "failed"
                table.put_item(Item=failed_doc)
            raise
    return {"ok": True}
