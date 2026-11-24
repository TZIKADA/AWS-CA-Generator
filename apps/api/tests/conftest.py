import os

# Must run before any test module imports `sigvault.*`. `config.Settings` is required at import
# time, so every env var the container expects must be present here.
for _k, _v in {
    "AWS_REGION": "eu-west-1",
    "DB_HOST": "localhost",
    "DB_PORT": "5432",
    "DB_NAME": "app",
    "DB_USERNAME": "test",
    "DB_PASSWORD": "test",
    "DOCUMENTS_BUCKET": "test-documents",
    "KEYWRAP_KMS_KEY_ID": "arn:aws:kms:eu-west-1:000000000000:key/test",
    "COGNITO_ISSUER": "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_test",
    "COGNITO_CLIENT_ID": "test-client",
    "GNUPGHOME": "/tmp/gnupg-tests",
    "JOBS_QUEUE_URL": "https://sqs.eu-west-1.amazonaws.com/000000000000/jobs",
}.items():
    os.environ.setdefault(_k, _v)
