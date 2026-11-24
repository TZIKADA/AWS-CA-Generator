import os

import boto3
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .config import settings

_kms = boto3.client("kms", region_name=settings.aws_region)


def _ctx(org_id: str, key_id: str) -> dict[str, str]:
    return {"org_id": org_id, "key_id": key_id}


def encrypt_private_key(org_id: str, key_id: str, plaintext: bytes) -> tuple[bytes, bytes]:
    """Returns (aes_gcm_ciphertext, kms_wrapped_data_key). Store both in signing_keys."""
    resp = _kms.generate_data_key(
        KeyId=settings.keywrap_kms_key_id,
        KeySpec="AES_256",
        EncryptionContext=_ctx(org_id, key_id),
    )
    data_key, wrapped = resp["Plaintext"], resp["CiphertextBlob"]
    nonce = os.urandom(12)
    return nonce + AESGCM(data_key).encrypt(nonce, plaintext, None), wrapped


def decrypt_private_key(org_id: str, key_id: str, blob: bytes, wrapped: bytes) -> bytes:
    data_key = _kms.decrypt(
        CiphertextBlob=wrapped,
        EncryptionContext=_ctx(org_id, key_id),
    )["Plaintext"]
    nonce, ct = blob[:12], blob[12:]
    return AESGCM(data_key).decrypt(nonce, ct, None)
