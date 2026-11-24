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
        import json

        payload = json.loads(record["body"])
        org_id = payload["org_id"]
        job_id = payload["job_id"]
        job = table.get_item(Key={"PK": f"ORG#{org_id}", "SK": f"JOB#{job_id}"}).get("Item")
        if not job:
            continue
        doc_id = job["doc_id"]
        key_id = job["key_id"]
        source = _s3.get_object(
            Bucket=bucket, Key=f"uploads/{org_id}/{doc_id}"
        )["Body"].read()
        armored = _s3.get_object(
            Bucket=bucket, Key=f"keys/{org_id}/{key_id}"
        )["Body"].read()
        key, _ = pgpy.PGPKey.from_blob(armored)
        message = pgpy.PGPMessage.new(source)
        signature = key.sign(message, detach=True)
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
        doc = table.get_item(Key={"PK": f"ORG#{org_id}", "SK": f"DOC#{doc_id}"}).get("Item")
        if doc:
            doc.update(status="signed", s3_signed_key=signature_key)
            table.put_item(Item=doc)
    return {"ok": True}
