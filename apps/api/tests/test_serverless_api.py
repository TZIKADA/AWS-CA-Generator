import sys
from types import SimpleNamespace

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
