import sys
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from sigvault import main


class FakeTable:
    def __init__(self, items):
        self.items = items
        self.query_items = []
        self.writes = []
        self.updates = []

    def get_item(self, *, Key):
        return {"Item": self.items.get(Key["SK"])}

    def query(self, **kwargs):
        return {"Items": self.query_items}

    def put_item(self, *, Item):
        self.writes.append(Item)

    def update_item(self, **kwargs):
        self.updates.append(kwargs)


def _authorize(monkeypatch, table):
    monkeypatch.setattr(main, "_table", table)
    monkeypatch.setattr(main, "_ensure_user", lambda _claims: "user-1")
    monkeypatch.setattr(main, "_org_for_user", lambda *_args, **_kwargs: {})
    main.app.dependency_overrides[main._claims] = lambda: {"sub": "user-1"}


def test_assistant_suggests_organization_name(monkeypatch):
    class FakeBedrock:
        def converse(self, **kwargs):
            assert kwargs["modelId"] == main.settings.bedrock_model_id
            assert kwargs["messages"][0]["content"][0]["text"] == "A company making bicycles"
            return {"output": {"message": {"content": [{"text": "  Pedal Works  "}]}}}

    monkeypatch.setattr(main, "_bedrock", FakeBedrock())
    main.app.dependency_overrides[main._claims] = lambda: {"sub": "user-1"}

    try:
        response = TestClient(main.app).post(
            "/api/assistant/organization-name",
            json={"prompt": "A company making bicycles"},
        )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json() == {"name": "Pedal Works"}


def test_assistant_rejects_empty_model_response(monkeypatch):
    class FakeBedrock:
        def converse(self, **_kwargs):
            return {"output": {"message": {"content": []}}}

    monkeypatch.setattr(main, "_bedrock", FakeBedrock())
    main.app.dependency_overrides[main._claims] = lambda: {"sub": "user-1"}

    try:
        response = TestClient(main.app).post(
            "/api/assistant/organization-name",
            json={"prompt": "A company making bicycles"},
        )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 502


@pytest.mark.parametrize(
    "claims",
    [
        {"sub": "user-1", "token_use": "access"},
        {"sub": "user-1"},
        {"token_use": "id"},
    ],
)
def test_auth_rejects_non_id_or_incomplete_cognito_claims(monkeypatch, claims):
    class FakeJwks:
        def get_signing_key_from_jwt(self, _token):
            return SimpleNamespace(key="test-key")

    monkeypatch.setattr(main, "_jwks", FakeJwks())
    monkeypatch.setattr(main.jwt, "decode", lambda *_args, **_kwargs: claims)

    response = TestClient(main.app).post(
        "/api/assistant/organization-name",
        headers={"Authorization": "Bearer test-token"},
        json={"prompt": "A company making bicycles"},
    )

    assert response.status_code == 401


def test_auth_accepts_id_token_claims(monkeypatch):
    class FakeJwks:
        def get_signing_key_from_jwt(self, _token):
            return SimpleNamespace(key="test-key")

    class FakeBedrock:
        def converse(self, **_kwargs):
            return {"output": {"message": {"content": [{"text": "Pedal Works"}]}}}

    monkeypatch.setattr(main, "_jwks", FakeJwks())
    monkeypatch.setattr(
        main.jwt,
        "decode",
        lambda *_args, **_kwargs: {"sub": "user-1", "token_use": "id"},
    )
    monkeypatch.setattr(main, "_bedrock", FakeBedrock())

    response = TestClient(main.app).post(
        "/api/assistant/organization-name",
        headers={"Authorization": "Bearer test-token"},
        json={"prompt": "A company making bicycles"},
    )

    assert response.status_code == 200
    assert response.json() == {"name": "Pedal Works"}


def test_org_authorization_checks_membership_and_role(monkeypatch):
    class MembershipTable:
        def get_item(self, *, Key):
            if Key == {"PK": "ORG#org-1", "SK": "MEMBER#user-1"}:
                return {"Item": {"role": "member"}}
            return {}

    monkeypatch.setattr(main, "_table", MembershipTable())

    assert main._org_for_user("user-1", "org-1", ("admin", "member")) == {
        "role": "member"
    }

    with pytest.raises(main.HTTPException) as denied_role:
        main._org_for_user("user-1", "org-1", ("admin",))
    assert denied_role.value.status_code == 403

    with pytest.raises(main.HTTPException) as denied_org:
        main._org_for_user("user-1", "org-2", ("admin", "member"))
    assert denied_org.value.status_code == 403


def test_list_and_create_organizations(monkeypatch):
    table = FakeTable({"METADATA": {"name": "Pedal Works", "created_at": "now"}})
    table.query_items = [{"org_id": "org-1"}]
    _authorize(monkeypatch, table)

    try:
        client = TestClient(main.app)
        listed = client.get("/api/orgs")
        created = client.post("/api/orgs", json={"name": "New Org"})
    finally:
        main.app.dependency_overrides.clear()

    assert listed.status_code == 200
    assert listed.json() == [{"id": "org-1", "name": "Pedal Works", "created_at": "now"}]
    assert created.status_code == 201
    assert created.json()["name"] == "New Org"
    assert len(table.writes) == 2


def test_list_keys_and_documents(monkeypatch):
    table = FakeTable({})
    table.query_items = [
        {
            "key_id": "key-1",
            "label": "Signing",
            "algorithm": "RSA_2048",
            "fingerprint": "fingerprint",
            "created_at": "now",
        }
    ]
    _authorize(monkeypatch, table)

    try:
        client = TestClient(main.app)
        keys = client.get("/api/orgs/org-1/keys")
        table.query_items = [
            {"doc_id": "doc-1", "filename": "file.txt", "status": "uploaded", "created_at": "now"}
        ]
        documents = client.get("/api/orgs/org-1/documents")
    finally:
        main.app.dependency_overrides.clear()

    assert keys.status_code == 200
    assert keys.json()[0]["id"] == "key-1"
    assert documents.status_code == 200
    assert documents.json()[0]["filename"] == "file.txt"


def test_create_key(monkeypatch):
    class FakeKey:
        is_public = False
        is_protected = False
        fingerprint = "fingerprint"
        key_algorithm = SimpleNamespace(name="RSAEncryptOrSign")
        key_size = 2048

    fake_pgpy = SimpleNamespace(
        PGPKey=SimpleNamespace(from_blob=lambda value: (FakeKey(), None))
    )
    monkeypatch.setitem(sys.modules, "pgpy", fake_pgpy)
    table = FakeTable({})
    _authorize(monkeypatch, table)
    monkeypatch.setenv("DOCUMENTS_BUCKET", "documents")
    uploads = []
    monkeypatch.setattr(main._s3, "put_object", lambda **kwargs: uploads.append(kwargs))

    try:
        response = TestClient(main.app).post(
            "/api/orgs/org-1/keys",
            json={
                "label": "Signing",
                "algorithm": "RSA_2048",
                "private_key_armored": "private-key",
            },
        )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 201
    assert response.json()["fingerprint"] == "fingerprint"
    assert uploads[0]["Key"].startswith("keys/org-1/")
    assert table.writes[0]["label"] == "Signing"


def test_create_key_rejects_mismatched_algorithm(monkeypatch):
    class FakeKey:
        is_public = False
        is_protected = False
        key_algorithm = SimpleNamespace(name="RSAEncryptOrSign")
        key_size = 4096

    fake_pgpy = SimpleNamespace(
        PGPKey=SimpleNamespace(from_blob=lambda _value: (FakeKey(), None))
    )
    monkeypatch.setitem(sys.modules, "pgpy", fake_pgpy)
    table = FakeTable({})
    _authorize(monkeypatch, table)
    uploads = []
    monkeypatch.setattr(main._s3, "put_object", lambda **kwargs: uploads.append(kwargs))

    try:
        response = TestClient(main.app).post(
            "/api/orgs/org-1/keys",
            json={
                "label": "Signing",
                "algorithm": "RSA_2048",
                "private_key_armored": "private-key",
            },
        )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 400
    assert response.json()["detail"] == "selected algorithm does not match PGP key (RSA_4096)"
    assert uploads == []
    assert table.writes == []


def test_create_key_accepts_matching_ecdsa_curve(monkeypatch):
    class FakeKey:
        is_public = False
        is_protected = False
        fingerprint = "fingerprint"
        key_algorithm = SimpleNamespace(name="ECDSA")
        key_size = SimpleNamespace(name="NIST_P256")

    fake_pgpy = SimpleNamespace(
        PGPKey=SimpleNamespace(from_blob=lambda _value: (FakeKey(), None))
    )
    monkeypatch.setitem(sys.modules, "pgpy", fake_pgpy)
    table = FakeTable({})
    _authorize(monkeypatch, table)
    monkeypatch.setenv("DOCUMENTS_BUCKET", "documents")
    monkeypatch.setattr(main._s3, "put_object", lambda **_kwargs: None)

    try:
        response = TestClient(main.app).post(
            "/api/orgs/org-1/keys",
            json={
                "label": "Signing",
                "algorithm": "ECDSA_P256",
                "private_key_armored": "private-key",
            },
        )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 201
    assert response.json()["algorithm"] == "ECDSA_P256"


def test_create_key_returns_bad_request_for_invalid_pgp_data(monkeypatch):
    def invalid_key(_value):
        raise ValueError("not a PGP key")

    monkeypatch.setitem(
        sys.modules,
        "pgpy",
        SimpleNamespace(PGPKey=SimpleNamespace(from_blob=invalid_key)),
    )
    _authorize(monkeypatch, FakeTable({}))

    try:
        response = TestClient(main.app).post(
            "/api/orgs/org-1/keys",
            json={
                "label": "Signing",
                "algorithm": "RSA_2048",
                "private_key_armored": "not a PGP key",
            },
        )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 400
    assert response.json()["detail"] == "invalid PGP private key"


def test_create_key_rejects_oversized_private_key(monkeypatch):
    _authorize(monkeypatch, FakeTable({}))

    try:
        response = TestClient(main.app).post(
            "/api/orgs/org-1/keys",
            json={
                "label": "Signing",
                "algorithm": "RSA_2048",
                "private_key_armored": "x" * 65_537,
            },
        )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 422


def test_revoke_key(monkeypatch):
    table = FakeTable({})
    _authorize(monkeypatch, table)
    monkeypatch.setenv("DOCUMENTS_BUCKET", "documents")
    deleted = []
    monkeypatch.setattr(main._s3, "delete_object", lambda **kwargs: deleted.append(kwargs))

    try:
        response = TestClient(main.app).delete("/api/orgs/org-1/keys/key-1")
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 204
    assert table.updates[0]["Key"]["SK"] == "KEY#key-1"
    assert deleted[0]["Key"] == "keys/org-1/key-1"


def test_create_document(monkeypatch):
    table = FakeTable({})
    _authorize(monkeypatch, table)
    monkeypatch.setenv("DOCUMENTS_BUCKET", "documents")
    monkeypatch.setattr(
        main._s3,
        "generate_presigned_url",
        lambda *args, **kwargs: "https://example.test/upload",
    )

    try:
        response = TestClient(main.app).post(
            "/api/orgs/org-1/documents",
            json={"filename": "file.txt", "content_type": "text/plain"},
        )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 201
    assert response.json()["upload_url"] == "https://example.test/upload"
    assert table.writes[0]["filename"] == "file.txt"


def test_sign_document_queues_uploaded_file(monkeypatch):
    table = FakeTable(
        {
            "DOC#doc-1": {"status": "uploaded"},
            "KEY#key-1": {},
        }
    )
    _authorize(monkeypatch, table)
    monkeypatch.setenv("DOCUMENTS_BUCKET", "documents")
    monkeypatch.setenv("JOBS_QUEUE_URL", "https://example.test/jobs")
    monkeypatch.setattr(main._s3, "head_object", lambda **kwargs: {"ContentLength": 10})
    queued = []
    monkeypatch.setattr(main._sqs, "send_message", lambda **kwargs: queued.append(kwargs))

    try:
        response = TestClient(main.app).post(
            "/api/orgs/org-1/documents/doc-1/sign",
            json={"key_id": "key-1"},
        )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 202
    assert table.updates[0]["ExpressionAttributeValues"][":queued"] == "queued"
    assert queued[0]["QueueUrl"] == "https://example.test/jobs"


def test_download_requires_signed_document_and_returns_presigned_url(monkeypatch):
    table = FakeTable(
        {
            "DOC#doc-1": {
                "status": "signed",
                "s3_signed_key": "signed/org-1/doc-1",
            }
        }
    )
    _authorize(monkeypatch, table)
    monkeypatch.setattr(
        main._s3,
        "generate_presigned_url",
        lambda *_args, **_kwargs: "https://example.test/download",
    )
    monkeypatch.setenv("DOCUMENTS_BUCKET", "documents")

    try:
        response = TestClient(main.app).get(
            "/api/orgs/org-1/documents/doc-1/download"
        )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json() == {"download_url": "https://example.test/download"}


def test_signing_rejects_revoked_key(monkeypatch):
    table = FakeTable(
        {
            "DOC#doc-1": {"status": "uploaded"},
            "KEY#key-1": {"revoked_at": "2026-01-01T00:00:00+00:00"},
        }
    )
    _authorize(monkeypatch, table)

    try:
        response = TestClient(main.app).post(
            "/api/orgs/org-1/documents/doc-1/sign",
            json={"key_id": "key-1"},
        )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 409
    assert response.json()["detail"] == "signing key is revoked"
