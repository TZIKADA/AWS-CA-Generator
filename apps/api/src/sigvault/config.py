from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import cached_property

class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    port: int = 8080
    aws_region: str
    db_host: str
    db_port: int = 5432
    db_name: str = "app"
    db_username: str
    db_password: str
    documents_bucket: str
    keywrap_kms_key_id: str
    cognito_issuer: str
    cognito_client_id: str
    gnupghome: str = "/tmp/gnupg"
    jobs_queue_url: str | None = None
    ses_from_domain: str | None = None
    ses_configuration_set: str | None = None
    worker_mode: bool = False

    @cached_property
    def db_dsn(self) -> str:
        return (f"postgresql+asyncpg://{self.db_username}:{self.db_password}"
                f"@{self.db_host}:{self.db_port}/{self.db_name}")

settings = Settings()
