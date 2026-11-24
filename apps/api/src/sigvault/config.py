from functools import cached_property
from urllib.parse import quote_plus

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    port: int = 8080
    aws_region: str = "eu-west-1"
    db_host: str | None = None
    db_port: int = 5432
    db_name: str = "app"
    db_username: str | None = None
    db_password: str | None = None
    documents_bucket: str | None = None
    keywrap_kms_key_id: str | None = None
    cognito_issuer: str = ""
    cognito_client_id: str = ""
    gnupghome: str = "/tmp/gnupg"
    jobs_queue_url: str | None = None
    ses_from_domain: str | None = None
    ses_configuration_set: str | None = None
    worker_mode: bool = False

    @cached_property
    def db_dsn(self) -> str:
        if not all((self.db_host, self.db_username, self.db_password)):
            raise RuntimeError("PostgreSQL settings are not configured")
        assert self.db_host is not None
        assert self.db_username is not None
        assert self.db_password is not None
        username = quote_plus(self.db_username)
        password = quote_plus(self.db_password)
        return (
            f"postgresql+asyncpg://{username}:{password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
        )


settings = Settings.model_validate({})
