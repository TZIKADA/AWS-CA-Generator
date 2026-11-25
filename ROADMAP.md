# SigVault POC Roadmap

## POC direction

The current POC is a **serverless document-signing service**, not an AI certificate
manager. Its narrow end-to-end proof is: a user signs in, creates an organization,
registers a PGP signing key, uploads a document, requests a detached signature, and
downloads that signature. A Bedrock-assisted organization-name suggestion is also
implemented, but is optional and not part of the signing proof.

The deployed path is API Gateway + Lambda, Cognito, DynamoDB, S3, SQS, and a
Lambda signing worker. Keep the POC to one `dev` environment and one signing flow.
Do not add ACM/Private CA certificate lifecycle, AI policy enforcement,
password/keyring management, organization invitations, audit dashboards, extra
integrations, HA/DR, or production-scale deployment work.

## What exists today

- **API:** health check; Cognito JWT verification; Bedrock-assisted organization
  name suggestion; create/list organizations; list, register, and revoke signing
  keys; create/list documents; presigned upload and signature download URLs; and
  asynchronous signing requests.
- **Signing path:** an SQS-triggered Lambda worker uses PGPy to produce a detached
  signature. Uploads are limited to 5 MiB by default; signing keys must be unprotected
  PGP private keys. S3 lifecycle rules expire uploads and signatures after 30 days.
- **Web app:** Cognito sign-in/out; organization create/list and optional name
  suggestion; key registration/revocation; document upload, signing, status polling,
  and signature download.
- **Deployment:** Terraform provisions the dev serverless stack; GitHub Actions
  checks application code and deploys app changes to dev. See
  [infra/README.md](infra/README.md) for setup and deployment.

## POC schedule (3 working days)

### Day 1 — Establish a repeatable baseline

- [x] Run API tests, lint, type-check, and Terraform format/configuration checks.
- [ ] Confirm deployed dev Cognito/model configuration and complete one signing flow.

### Day 2 — Provide a usable signing workflow

- [x] Add key registration/revocation and document upload/sign/download to the web UI.
- [ ] Verify upload completion, queued/signing/signed states, key revocation, and
  organization isolation in the deployed dev environment.

### Day 3 — Validate and demo

- [ ] Complete the manual acceptance flow below and demonstrate it against dev.
- [ ] Record the remaining limitations, deployment/cost assumptions, and go/no-go.

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

These are configured in `.github/workflows/ci.yml`. `.github/workflows/infra.yml`
checks Terraform formatting, validates the bootstrap and application stacks, and
plans the dev application stack on infrastructure changes.

### Manual acceptance flow

Use the deployed dev app/API and a non-sensitive test document:

1. Sign in through Cognito and create an organization in the web app.
2. Optionally request a name suggestion; verify it only fills the organization
   name field and does not create the organization.
3. Register an unprotected PGP private key in the key vault.
4. Upload a non-sensitive file (5 MiB or smaller), select an active key, and request
   signing.
5. Wait for the document status to become `signed`, then download the `.sig` file.
6. Confirm a revoked key cannot sign and a user without organization membership is
   denied access.

## Known gaps and POC risks

- The API suite passes 20 tests at 83% coverage, but its S3, DynamoDB, SQS, Cognito,
  and PGP worker tests use fakes. A live signing acceptance run is still needed.
- Local Python checks pass; the web production build still needs to run in CI or an
  environment with Node.js/npm.
- The serverless path stores armored private keys in S3 with S3-managed encryption,
  not customer-managed KMS envelope encryption. Treat test keys as disposable and
  document this limitation in the demo.
- There is no organization invitation or membership-management flow, audit trail,
  or cost hard cap. Organization isolation and denial of unauthorized access remain
  required POC checks; multi-user role administration does not.
- The Bedrock name suggestion depends on model availability/permissions and can
  incur usage costs; the core signing demo should not depend on it.
- The infrastructure workflow plans/applies the dev stack only. The tracked prod
  configuration is not part of the current deployment path.
- Deployment requires the one-time Terraform bootstrap and dev configuration
  described in `infra/README.md`.

## Cost and safety

Deploy dev only. Set a low AWS Budget before deployment; a budget alerts but does not
stop spend. Use disposable keys and documents, never production secrets. The dev
stack uses S3-managed encryption and has 30-day document/signature lifecycle
expiration; do not represent the POC as production-ready.
