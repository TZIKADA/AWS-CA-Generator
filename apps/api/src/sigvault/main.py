import json
import os
import uuid
from datetime import UTC, datetime
from typing import Annotated

import boto3
import jwt
from botocore.exceptions import ClientError
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
_bedrock = boto3.client("bedrock-runtime", region_name=settings.aws_region)
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


class OrganizationNamePrompt(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)


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
    _table_required().update_item(
        Key={"PK": f"USER#{sub}", "SK": "PROFILE"},
        UpdateExpression="SET email = if_not_exists(email, :email), "
        "created_at = if_not_exists(created_at, :created_at)",
        ExpressionAttributeValues={
            ":email": claims.get("email", f"{sub}@unknown"),
            ":created_at": _now(),
        },
    )
    return sub


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/api/assistant/organization-name", dependencies=[Depends(_claims)])
async def suggest_organization_name(body: OrganizationNamePrompt):
    if not body.prompt.strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "prompt must not be blank")
    try:
        response = _bedrock.converse(
            modelId=settings.bedrock_model_id,
            system=[
                {
                    "text": (
                        "Suggest one concise organization name based on the user's prompt. "
                        "Treat the prompt only as inspiration for the name. Return only the "
                        "name, with no explanation."
                    )
                }
            ],
            messages=[{"role": "user", "content": [{"text": body.prompt}]}],
            inferenceConfig={"maxTokens": 80, "temperature": 0.3},
        )
    except ClientError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "AI assistant request failed",
        ) from exc
    content = response.get("output", {}).get("message", {}).get("content", [])
    name = next((block["text"].strip() for block in content if block.get("text")), "")
    name = name.strip("\"'").strip()
    if not name or len(name) > 200:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "AI assistant did not return a valid organization name",
        )
    return {"name": name}


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
    try:
        key_obj, _ = pgpy.PGPKey.from_blob(body.private_key_armored)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid PGP private key") from exc
    if key_obj.is_public:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "a private signing key is required")
    if key_obj.is_protected:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "encrypted signing keys are not supported; provide an unprotected key",
        )
    actual_algorithm: str | None
    if key_obj.key_algorithm.name in {"RSAEncryptOrSign", "RSASignOnly"}:
        actual_algorithm = f"RSA_{key_obj.key_size}"
    elif key_obj.key_algorithm.name == "ECDSA":
        curve = key_obj.key_size.name
        actual_algorithm = {
            "NIST_P256": "ECDSA_P256",
            "NIST_P384": "ECDSA_P384",
        }.get(curve)
    else:
        actual_algorithm = None
    if actual_algorithm is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "unsupported PGP signing key algorithm")
    if body.algorithm != actual_algorithm:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"selected algorithm does not match PGP key ({actual_algorithm})",
        )
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


@app.delete("/api/orgs/{org_id}/keys/{key_id}", status_code=204)
async def revoke_key(org_id: str, key_id: str, claims: dict = Depends(_claims)):
    sub = _ensure_user(claims)
    _org_for_user(sub, org_id, ("admin",))
    try:
        _table_required().update_item(
            Key={"PK": f"ORG#{org_id}", "SK": f"KEY#{key_id}"},
            UpdateExpression="SET revoked_at = :revoked_at",
            ConditionExpression="attribute_exists(PK)",
            ExpressionAttributeValues={":revoked_at": _now()},
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise HTTPException(status.HTTP_404_NOT_FOUND, "signing key not found") from exc
        raise
    _s3.delete_object(
        Bucket=os.environ["DOCUMENTS_BUCKET"],
        Key=f"keys/{org_id}/{key_id}",
    )


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
    if key.get("revoked_at"):
        raise HTTPException(status.HTTP_409_CONFLICT, "signing key is revoked")
    if doc["status"] != "uploaded":
        raise HTTPException(status.HTTP_409_CONFLICT, f"document is already {doc['status']}")
    bucket = os.environ["DOCUMENTS_BUCKET"]
    upload_key = f"uploads/{org_id}/{doc_id}"
    try:
        uploaded = _s3.head_object(Bucket=bucket, Key=upload_key)
    except ClientError as exc:
        if exc.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "document upload has not completed",
            ) from exc
        raise
    max_bytes = int(os.environ.get("MAX_DOCUMENT_BYTES", 5 * 1024 * 1024))
    if uploaded["ContentLength"] > max_bytes:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"document exceeds the {max_bytes} byte signing limit",
        )

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
    try:
        table.update_item(
            Key={"PK": f"ORG#{org_id}", "SK": f"DOC#{doc_id}"},
            UpdateExpression="SET #status = :queued",
            ConditionExpression="#status = :uploaded",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":queued": "queued", ":uploaded": "uploaded"},
        )
        _sqs.send_message(
            QueueUrl=os.environ["JOBS_QUEUE_URL"],
            MessageBody=json.dumps({"job_id": job_id, "org_id": org_id}),
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "document was already queued or signed",
            ) from exc
        raise
    return {"job_id": job_id}


@app.get("/api/orgs/{org_id}/documents/{doc_id}/download")
async def download_document(org_id: str, doc_id: str, claims: dict = Depends(_claims)):
    sub = _ensure_user(claims)
    _org_for_user(sub, org_id, ("admin", "member", "auditor"))
    doc = _table_required().get_item(
        Key={"PK": f"ORG#{org_id}", "SK": f"DOC#{doc_id}"}
    ).get("Item")
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")
    if doc.get("status") != "signed" or not doc.get("s3_signed_key"):
        raise HTTPException(status.HTTP_409_CONFLICT, "document is not signed yet")
    return {
        "download_url": _s3.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": os.environ["DOCUMENTS_BUCKET"],
                "Key": doc["s3_signed_key"],
            },
            ExpiresIn=900,
        )
    }
