# SigVault

SigVault is a proof-of-concept serverless document-signing service. Users sign in,
organize documents and signing keys, request an asynchronous detached PGP signature,
and download the result. It is not a production-ready certificate-management
service.

## Project layout

- `apps/api/` — FastAPI endpoints and the SQS-triggered Lambda signing worker.
- `apps/web/` — React and Vite single-page application.
- `infra/terraform/` — AWS serverless infrastructure and dev environment templates.
- `.github/workflows/` — application CI, dev deployment, and infrastructure checks.
- `ROADMAP.md` — current POC scope, validation status, and acceptance flow.
- `infra/README.md` — AWS bootstrap, configuration, deployment, cost, and limitations.

## Demonstrate the app

Use the deployed **dev** environment configured in [infra/README.md](infra/README.md).
Before the demo, prepare a non-sensitive file no larger than 5 MiB and a disposable,
unprotected PGP private key using one of the supported algorithms: RSA 2048/3072/4096
or ECDSA P-256/P-384. Never use a production key or confidential document.

1. Open the dev app and sign in with a Cognito test user.
2. Create an organization. Optionally demonstrate that the AI name suggestion only
   populates the form; it does not create the organization.
3. Register the disposable signing key, selecting its matching algorithm.
4. Upload the test file and request signing. Show the status progressing from
   `uploaded` to `queued` to `signed`.
5. Download the `.sig` file and verify it against the original file:

   ```bash
   gpg --verify <document>.sig <document>
   ```

6. If time permits, revoke the demo key and show that it cannot be used for a new
   signing request. Demonstrate organization isolation only with a separate,
   authorized test account.

Explain that the signing worker processes requests asynchronously and returns a
detached signature. Keep the optional Bedrock name suggestion out of the core proof.
Call out the POC limitations: keys use S3-managed encryption, stored documents and
signatures expire after 30 days, and there is no audit trail, invitation workflow,
WAF, or cost hard cap. Set an AWS Budget before deployment; a budget alerts but does
not stop spend.

## Local checks

API, from `apps/api`:

```bash
pip install -e ".[dev]"
ruff check .
mypy src
pytest -q --cov=sigvault --cov-fail-under=70
```

Web, from `apps/web`:

```bash
npm ci
npm run build
```
