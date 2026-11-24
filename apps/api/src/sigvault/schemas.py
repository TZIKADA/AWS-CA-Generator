import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class OrgCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class OrgRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    created_at: datetime


class SigningKeyCreate(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    algorithm: str = Field(pattern="^(RSA_2048|RSA_3072|RSA_4096|ECDSA_P256|ECDSA_P384)$")
    private_key_armored: str


class SigningKeyRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    org_id: uuid.UUID
    label: str
    algorithm: str
    fingerprint: str
    created_at: datetime
    revoked_at: datetime | None


class DocumentCreate(BaseModel):
    filename: str = Field(min_length=1, max_length=400)
    content_type: str = "application/octet-stream"


class DocumentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    org_id: uuid.UUID
    filename: str
    status: str
    created_at: datetime


class DocumentUploadResponse(BaseModel):
    document_id: uuid.UUID
    upload_url: str


class SignRequest(BaseModel):
    key_id: uuid.UUID
