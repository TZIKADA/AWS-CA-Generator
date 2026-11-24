from fastapi.testclient import TestClient

from sigvault import main


class FakeTable:
    def __init__(self, items):
        self.items = items

    def get_item(self, *, Key):
        return {"Item": self.items.get(Key["SK"])}


def _authorize(monkeypatch, table):
    monkeypatch.setattr(main, "_table", table)
    monkeypatch.setattr(main, "_ensure_user", lambda claims: "user-1")
    monkeypatch.setattr(main, "_org_for_user", lambda *args, **kwargs: {})
    main.app.dependency_overrides[main._claims] = lambda: {"sub": "user-1"}


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
        lambda *args, **kwargs: "https://example.test/download",
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
