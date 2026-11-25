import json
import sys
from types import SimpleNamespace

import pytest

from sigvault import lambda_handler


class FakeBody:
    def __init__(self, value):
        self.value = value

    def read(self):
        return self.value


class FakeTable:
    def __init__(self, items):
        self.items = items

    def get_item(self, *, Key):
        return {"Item": self.items.get(Key["SK"])}

    def put_item(self, *, Item):
        self.items[Item["SK"]] = Item


class FakeS3:
    def __init__(self):
        self.puts = []

    def get_object(self, *, Bucket, Key):
        if Key.startswith("uploads/"):
            return {"ContentLength": 5, "Body": FakeBody(b"document")}
        return {"Body": FakeBody(b"private-key")}

    def put_object(self, **kwargs):
        self.puts.append(kwargs)


def _fake_pgpy(monkeypatch, *, is_protected=False):
    class FakeKey:
        def __init__(self):
            self.is_protected = is_protected

        def sign(self, message, *, detached):
            assert message == b"document"
            assert detached
            return "signature"

    monkeypatch.setitem(
        sys.modules,
        "pgpy",
        SimpleNamespace(
            PGPKey=SimpleNamespace(from_blob=lambda value: (FakeKey(), None)),
            PGPMessage=SimpleNamespace(new=lambda value: value),
        ),
    )


def _invoke(monkeypatch, table, s3, job_id="job-1"):
    monkeypatch.setattr(lambda_handler, "_dynamodb", SimpleNamespace(Table=lambda name: table))
    monkeypatch.setattr(lambda_handler, "_s3", s3)
    monkeypatch.setenv("DYNAMODB_TABLE", "documents")
    monkeypatch.setenv("DOCUMENTS_BUCKET", "bucket")
    return lambda_handler.worker_handler(
        {"Records": [{"body": json.dumps({"org_id": "org-1", "job_id": job_id})}]},
        None,
    )


def test_worker_signs_document_and_updates_records(monkeypatch):
    table = FakeTable(
        {
            "JOB#job-1": {
                "SK": "JOB#job-1",
                "doc_id": "doc-1",
                "key_id": "key-1",
                "status": "pending",
            },
            "DOC#doc-1": {"SK": "DOC#doc-1", "status": "queued"},
            "KEY#key-1": {"SK": "KEY#key-1"},
        }
    )
    s3 = FakeS3()
    _fake_pgpy(monkeypatch)

    assert _invoke(monkeypatch, table, s3) == {"ok": True}

    assert table.items["JOB#job-1"]["status"] == "done"
    assert table.items["DOC#doc-1"]["status"] == "signed"
    assert table.items["DOC#doc-1"]["s3_signed_key"] == "signed/org-1/doc-1"
    assert s3.puts[0]["Key"] == "signed/org-1/doc-1"


def test_worker_skips_missing_and_completed_jobs(monkeypatch):
    table = FakeTable({"JOB#done": {"SK": "JOB#done", "status": "done"}})
    s3 = FakeS3()
    monkeypatch.setattr(lambda_handler, "_dynamodb", SimpleNamespace(Table=lambda name: table))
    monkeypatch.setattr(lambda_handler, "_s3", s3)
    monkeypatch.setenv("DYNAMODB_TABLE", "documents")
    monkeypatch.setenv("DOCUMENTS_BUCKET", "bucket")

    result = lambda_handler.worker_handler(
        {
            "Records": [
                {"body": json.dumps({"org_id": "org-1", "job_id": "missing"})},
                {"body": json.dumps({"org_id": "org-1", "job_id": "done"})},
            ]
        },
        None,
    )

    assert result == {"ok": True}
    assert s3.puts == []


@pytest.mark.parametrize(
    ("key_item", "content_length", "error"),
    [
        ({"revoked_at": "now"}, 5, "signing key has been revoked"),
        ({}, 6, "document exceeds 5 byte signing limit"),
    ],
)
def test_worker_marks_failed_job_and_document(monkeypatch, key_item, content_length, error):
    class OversizedS3(FakeS3):
        def get_object(self, *, Bucket, Key):
            result = super().get_object(Bucket=Bucket, Key=Key)
            if Key.startswith("uploads/"):
                result["ContentLength"] = content_length
            return result

    table = FakeTable(
        {
            "JOB#job-1": {
                "SK": "JOB#job-1",
                "doc_id": "doc-1",
                "key_id": "key-1",
                "status": "pending",
            },
            "DOC#doc-1": {"SK": "DOC#doc-1", "status": "queued"},
            "KEY#key-1": {"SK": "KEY#key-1", **key_item},
        }
    )
    s3 = OversizedS3()
    _fake_pgpy(monkeypatch)
    monkeypatch.setenv("MAX_DOCUMENT_BYTES", "5")

    with pytest.raises(RuntimeError, match=error):
        _invoke(monkeypatch, table, s3)

    assert table.items["JOB#job-1"]["status"] == "failed"
    assert table.items["DOC#doc-1"]["status"] == "failed"
