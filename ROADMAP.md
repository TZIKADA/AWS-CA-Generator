# SigVault POC Roadmap

## POC direction

The current POC is a **serverless document-signing service**, not an AI certificate
manager. Its narrow end-to-end proof is: a user signs in, creates an organization,
registers a PGP signing key, uploads a document, requests a detached signature, and
downloads that signature.

The deployed path is API Gateway + Lambda, Cognito, DynamoDB, S3, SQS, and a
Lambda signing worker. Keep the POC to one `dev` environment and one signing flow.
Do not add ACM/Private CA certificate lifecycle, Bedrock/AI, password/keyring
management, organization invitations, audit dashboards, extra integrations, HA/DR,
or production-scale deployment work.

## What exists today

- **API:** health check; Cognito JWT verification; create/list organizations; list,
  register, and revoke signing keys; create/list documents; presigned upload and
  signed-document download URLs; asynchronous signing requests.
- **Signing path:** an SQS-triggered Lambda worker uses PGPy to produce a detached
  signature. Uploads are limited to 5 MiB by default; signing keys must be unprotected
  PGP private keys. S3 lifecycle rules expire uploads and signatures after 30 days.
- **Web app:** health status, Cognito sign-in/out, and organization create/list only.
  Key and document workflows currently require direct API calls.
- **Deployment:** Terraform provisions the dev serverless stack; GitHub Actions
  checks application code and deploys app changes to dev. See
  [infra/README.md](infra/README.md) for setup and deployment.

The active serverless implementation is `apps/api/src/sigvault/main.py` and
`apps/api/src/sigvault/lambda_handler.py`. There is also a relational/FastAPI-worker
implementation (`routers/`, SQLAlchemy models, migrations, and `worker.py`) that
does not match the Terraform serverless stack. Do not mix the two paths in POC
testing; decide later whether the unused path should be removed or maintained.

## POC schedule (3 working days)

### Day 1 — Establish a repeatable baseline

- Confirm the dev stack and Cognito configuration are available, or follow the
  deployment steps in `infra/README.md`.
- Run the API and web checks below; record any failing checks and resolve only
  POC-blocking issues.
- Walk the API signing flow once with a test organization, test key, and
  non-sensitive sample document.

### Day 2 — Close the end-to-end usability gap

- Make the required key-registration and document-signing flow straightforward to
  operate for the demo. A small UI is useful, but a documented API/Postman flow is
  sufficient if time is tight.
- Verify upload completion, queued/signing/signed states, signature download, key
  revocation, and organization isolation.
- Add focused tests for any behavior fixed during the day, prioritizing the signing
  worker and authorization boundaries.

### Day 3 — Validate and demo

- Run the checks and manual acceptance flow below against dev.
- Demonstrate sign-in → organization → key → upload → sign → download; show a
  rejected unauthorized request and a revoked-key rejection.
- Capture known limitations, deployment/cost assumptions, and a go/no-go for any
  work beyond the POC.

## How to test

### Automated checks

API, from `apps/api`:

```bash
pip install -e ".[dev]"
ruff check .
mypy src
pytest -q --cov=sigvault --cov-fail-under=70
```

Web, from `apps/web`:

```bash
npm install
npm run build
```

These are the checks configured in `.github/workflows/ci.yml`. Infrastructure is
not currently covered by that workflow; after initializing the Terraform working
directory, run `terraform validate` for both `infra/terraform/app` and
`infra/terraform/bootstrap`.

### Manual acceptance flow

Use the deployed dev app/API and a non-sensitive test document:

1. Sign in through Cognito and create an organization in the web app.
2. Register an unprotected PGP private key using `POST /api/orgs/{org_id}/keys`.
3. Request an upload URL using `POST /api/orgs/{org_id}/documents`, then `PUT` the
   sample file to the returned URL.
4. Request signing with `POST /api/orgs/{org_id}/documents/{doc_id}/sign`.
5. Poll `GET /api/orgs/{org_id}/documents` until the document is signed; retrieve
   the detached signature URL from
   `GET /api/orgs/{org_id}/documents/{doc_id}/download`.
6. Confirm a user without membership cannot access the organization and that a
   revoked key cannot sign.

## Known gaps and POC risks

- The web UI cannot register keys, upload documents, request signing, or download
  signatures; only the backend flow exists.
- Automated coverage is narrow: current tests cover health/config, selected
  serverless download/revoked-key behavior, and KMS helper behavior. They do not
  establish the complete upload-to-worker-to-download flow, Cognito authorization,
  org isolation, or worker failure/retry behavior.
- The serverless path stores the armored private key in S3 with S3-managed
  encryption; it does not use the KMS envelope-encryption helper in the parallel
  relational implementation. Treat test keys as disposable and document this
  limitation in the demo.
- There is no organization invitation or membership-management flow, audit trail,
  or cost hard cap. Organization isolation and denial of unauthorized access remain
  required POC checks; multi-user role administration does not.
- CI triggers only for `apps/**`; Terraform changes are not automatically
  validated. Deployment requires manual Terraform/bootstrap configuration described
  in `infra/README.md`.

## Cost and safety

Deploy dev only. Set a low AWS Budget before deployment; a budget alerts but does not
stop spend. Use disposable keys and documents, never production secrets. The dev
stack uses S3-managed encryption and has 30-day document/signature lifecycle
expiration; do not represent the POC as production-ready.
