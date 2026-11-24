import os
import uuid
from datetime import UTC, datetime
from typing import Annotated

import boto3
import jwt
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient
from pydantic import BaseModel, Field

from .config import settings

app = FastAPI(title="sigvault-api", version="0.2.0", docs_url=None, redoc_url=None)
_bearer = HTTPBearer(auto_error=False)
_dynamodb = boto3.resource("dynamodb", region_name=settings.aws_region)
_table = _dynamodb.Table(os.environ["DYNAMODB_TABLE"]) if os.environ.get("DYNAMODB_TABLE") else None
_s3 = boto3.client("s3", region_name=settings.aws_region)
_sqs = boto3.client("sqs", region_name=settings.aws_region)
_jwks = (
    PyJWKClient(f"{settings.cognito_issuer}/.well-known/jwks.json", cache_keys=True)
    if settings.cognito_issuer
    else None
)


class OrgCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class KeyCreate(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    algorithm: str = Field(pattern="^(RSA_2048|RSA_3072|RSA_4096|ECDSA_P256|ECDSA_P384)$")
    private_key_armored: str


class DocumentCreate(BaseModel):
    filename: str = Field(min_length=1, max_length=400)
    content_type: str = "application/octet-stream"


class SignCreate(BaseModel):
    key_id: str


async def _claims(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> dict:
    if credentials is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")
    if _jwks is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Cognito is not configured")
    try:
        key = _jwks.get_signing_key_from_jwt(credentials.credentials).key
        return jwt.decode(
            credentials.credentials,
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


def _table_required():
    if _table is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "DynamoDB is not configured")
    return _table


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _org_for_user(user_sub: str, org_id: str, roles=("admin", "member")):
    table = _table_required()
    item = table.get_item(Key={"PK": f"ORG#{org_id}", "SK": f"MEMBER#{user_sub}"}).get("Item")
    if item is None or item["role"] not in roles:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "not authorized for this org")
    return item


def _ensure_user(claims: dict) -> str:
    sub = claims["sub"]
    table = _table_required()
    table.put_item(
        Item={
            "PK": f"USER#{sub}",
            "SK": "PROFILE",
            "email": claims.get("email", f"{sub}@unknown"),
            "created_at": _now(),
        }
    )
    return sub


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/api/orgs")
async def list_orgs(claims: dict = Depends(_claims)):
    sub = _ensure_user(claims)
    result = _table_required().query(
        IndexName="GSI1",
        KeyConditionExpression="GSI1PK = :u",
        ExpressionAttributeValues={":u": f"USER#{sub}"},
    )
    orgs = []
    for membership in result.get("Items", []):
        org_id = membership["org_id"]
        org = _table_required().get_item(
            Key={"PK": f"ORG#{org_id}", "SK": "METADATA"}
        ).get("Item")
        if org:
            orgs.append({"id": org_id, "name": org["name"], "created_at": org["created_at"]})
    return orgs


@app.post("/api/orgs", status_code=201)
async def create_org(body: OrgCreate, claims: dict = Depends(_claims)):
    sub = _ensure_user(claims)
    org_id = str(uuid.uuid4())
    now = _now()
    table = _table_required()
    table.put_item(
        Item={
            "PK": f"ORG#{org_id}",
            "SK": "METADATA",
            "name": body.name,
            "created_at": now,
        }
    )
    table.put_item(
        Item={
            "PK": f"ORG#{org_id}",
            "SK": f"MEMBER#{sub}",
            "org_id": org_id,
            "GSI1PK": f"USER#{sub}",
            "GSI1SK": f"ORG#{org_id}",
            "role": "admin",
        }
    )
    return {"id": org_id, "name": body.name, "created_at": now}


@app.get("/api/orgs/{org_id}/keys")
async def list_keys(org_id: str, claims: dict = Depends(_claims)):
    sub = _ensure_user(claims)
    _org_for_user(sub, org_id, ("admin", "member", "auditor"))
    result = _table_required().query(
        KeyConditionExpression="PK = :p AND begins_with(SK, :k)",
        ExpressionAttributeValues={":p": f"ORG#{org_id}", ":k": "KEY#"},
    )
    return [
        {
            "id": item["key_id"],
            "org_id": org_id,
            "label": item["label"],
            "algorithm": item["algorithm"],
            "fingerprint": item["fingerprint"],
            "created_at": item["created_at"],
            "revoked_at": item.get("revoked_at"),
        }
        for item in result.get("Items", [])
    ]


@app.post("/api/orgs/{org_id}/keys", status_code=201)
async def create_key(org_id: str, body: KeyCreate, claims: dict = Depends(_claims)):
    import pgpy

    sub = _ensure_user(claims)
    _org_for_user(sub, org_id, ("admin",))
    key_id = str(uuid.uuid4())
    key_obj, _ = pgpy.PGPKey.from_blob(body.private_key_armored)
    if key_obj.is_public:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "a private signing key is required")
    fingerprint = str(key_obj.fingerprint)
    bucket = os.environ["DOCUMENTS_BUCKET"]
    _s3.put_object(
        Bucket=bucket,
        Key=f"keys/{org_id}/{key_id}",
        Body=body.private_key_armored.encode(),
        ServerSideEncryption="AES256",
    )
    now = _now()
    item = {
        "PK": f"ORG#{org_id}",
        "SK": f"KEY#{key_id}",
        "key_id": key_id,
        "label": body.label,
        "algorithm": body.algorithm,
        "fingerprint": fingerprint,
        "created_at": now,
    }
    _table_required().put_item(Item=item)
    return {
        "id": key_id,
        "org_id": org_id,
        **{
            k: item[k]
            for k in ("label", "algorithm", "fingerprint", "created_at")
        },
        "revoked_at": None,
    }


@app.get("/api/orgs/{org_id}/documents")
async def list_documents(org_id: str, claims: dict = Depends(_claims)):
    sub = _ensure_user(claims)
    _org_for_user(sub, org_id, ("admin", "member", "auditor"))
    result = _table_required().query(
        KeyConditionExpression="PK = :p AND begins_with(SK, :k)",
        ExpressionAttributeValues={":p": f"ORG#{org_id}", ":k": "DOC#"},
    )
    return [
        {
            "id": item["doc_id"],
            "org_id": org_id,
            "filename": item["filename"],
            "status": item["status"],
            "created_at": item["created_at"],
        }
        for item in result.get("Items", [])
    ]


@app.post("/api/orgs/{org_id}/documents", status_code=201)
async def create_document(org_id: str, body: DocumentCreate, claims: dict = Depends(_claims)):
    sub = _ensure_user(claims)
    _org_for_user(sub, org_id, ("admin", "member"))
    doc_id = str(uuid.uuid4())
    now = _now()
    _table_required().put_item(
        Item={
            "PK": f"ORG#{org_id}",
            "SK": f"DOC#{doc_id}",
            "doc_id": doc_id,
            "filename": body.filename,
            "status": "uploaded",
            "created_at": now,
        }
    )
    bucket = os.environ["DOCUMENTS_BUCKET"]
    upload_url = _s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": bucket,
            "Key": f"uploads/{org_id}/{doc_id}",
            "ContentType": body.content_type,
        },
        ExpiresIn=900,
    )
    return {"document_id": doc_id, "upload_url": upload_url}


@app.post("/api/orgs/{org_id}/documents/{doc_id}/sign", status_code=202)
async def sign_document(
    org_id: str,
    doc_id: str,
    body: SignCreate,
    claims: dict = Depends(_claims),
):
    sub = _ensure_user(claims)
    _org_for_user(sub, org_id, ("admin", "member"))
    table = _table_required()
    doc = table.get_item(Key={"PK": f"ORG#{org_id}", "SK": f"DOC#{doc_id}"}).get("Item")
    key = table.get_item(Key={"PK": f"ORG#{org_id}", "SK": f"KEY#{body.key_id}"}).get("Item")
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")
    if key is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "signing key not found")
    job_id = str(uuid.uuid4())
    table.put_item(
        Item={
            "PK": f"ORG#{org_id}",
            "SK": f"JOB#{job_id}",
            "job_id": job_id,
            "doc_id": doc_id,
            "key_id": body.key_id,
            "status": "pending",
            "created_at": _now(),
        }
    )
    doc["status"] = "queued"
    table.put_item(Item=doc)
    _sqs.send_message(
        QueueUrl=os.environ["JOBS_QUEUE_URL"],
        MessageBody=f'{{"job_id":"{job_id}","org_id":"{org_id}"}}',
    )
    return {"job_id": job_id}
