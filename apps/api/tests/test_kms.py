from unittest.mock import MagicMock, patch

from sigvault import kms


def _fake_kms(data_key: bytes) -> MagicMock:
    m = MagicMock()
    m.generate_data_key.return_value = {"Plaintext": data_key, "CiphertextBlob": b"wrapped-key"}
    m.decrypt.return_value = {"Plaintext": data_key}
    return m


def test_encrypt_calls_generate_data_key_with_encryption_context():
    fake = _fake_kms(b"\x00" * 32)
    with patch.object(kms, "_kms", fake):
        ct, wrapped = kms.encrypt_private_key("org-a", "key-a", b"secret")

    kwargs = fake.generate_data_key.call_args.kwargs
    assert kwargs["KeyId"] == kms.settings.keywrap_kms_key_id
    assert kwargs["KeySpec"] == "AES_256"
    assert kwargs["EncryptionContext"] == {"org_id": "org-a", "key_id": "key-a"}
    assert wrapped == b"wrapped-key"
    assert ct.startswith(ct[:12])  # nonce prefix, length > 12


def test_decrypt_calls_kms_with_same_encryption_context():
    fake = _fake_kms(b"\x00" * 32)
    with patch.object(kms, "_kms", fake):
        ct, wrapped = kms.encrypt_private_key("org-b", "key-b", b"topsecret")
        plain = kms.decrypt_private_key("org-b", "key-b", ct, wrapped)

    assert plain == b"topsecret"
    kwargs = fake.decrypt.call_args.kwargs
    assert kwargs["CiphertextBlob"] == b"wrapped-key"
    assert kwargs["EncryptionContext"] == {"org_id": "org-b", "key_id": "key-b"}


def test_encryption_context_differs_per_tenant():
    fake = _fake_kms(b"\x00" * 32)
    with patch.object(kms, "_kms", fake):
        kms.encrypt_private_key("org-1", "k1", b"x")
        kms.encrypt_private_key("org-2", "k2", b"x")

    ctx1 = fake.generate_data_key.call_args_list[0].kwargs["EncryptionContext"]
    ctx2 = fake.generate_data_key.call_args_list[1].kwargs["EncryptionContext"]
    assert ctx1 != ctx2
    assert ctx1["org_id"] != ctx2["org_id"]
