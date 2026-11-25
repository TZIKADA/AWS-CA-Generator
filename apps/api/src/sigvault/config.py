from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    aws_region: str = Field(default="eu-west-1", validation_alias="APP_AWS_REGION")
    bedrock_model_id: str = "eu.amazon.nova-micro-v1:0"
    cognito_issuer: str = ""
    cognito_client_id: str = ""


settings = Settings()
