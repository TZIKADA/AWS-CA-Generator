from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    aws_region: str = "eu-west-1"
    bedrock_model_id: str = "amazon.nova-micro-v1:0"
    cognito_issuer: str = ""
    cognito_client_id: str = ""


settings = Settings()
