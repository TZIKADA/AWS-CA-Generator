from fastapi.testclient import TestClient

from sigvault.config import Settings, settings
from sigvault.main import app


def test_health_returns_ok():
    client = TestClient(app)
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_settings_are_loaded_from_environment():
    assert settings.cognito_client_id == "test-client"


def test_aws_region_uses_non_reserved_environment_variable(monkeypatch):
    monkeypatch.setenv("APP_AWS_REGION", "us-west-2")
    configured = Settings(_env_file=None)
    assert configured.aws_region == "us-west-2"
