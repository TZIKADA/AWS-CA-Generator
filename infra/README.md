# Infrastructure

Terraform for the signing/PKI SaaS on AWS. Dev and prod should be **separate AWS accounts**; each uses its own state key.

```
Browser ─▶ CloudFront (+WAF, TLS) ─┬─ /*      ─▶ S3 (SPA, private, OAC)
                                   └─ /api/*  ─▶ API Gateway HTTP API (Cognito JWT, throttling)
                                                   └─ VPC link ─▶ internal ALB ─▶ ECS Fargate (private subnets)
                                                                                   ├─▶ Aurora PostgreSQL Serverless v2 (data subnets)
                                                                                   ├─▶ KMS keywrap key (envelope-encrypts customer private keys)
                                                                                   └─▶ S3 documents bucket (presigned upload/download, KMS)
Auth: Cognito user pool (identity only). Orgs / invitations / roles live in the app DB.

Async:   API ─▶ SQS jobs queue (+DLQ, KMS) ─▶ ECS "worker" service (same image, WORKER_MODE=true)
Email:   SES domain identity (DKIM) + configuration set, used for invitations
Audit:   CloudTrail (mgmt events incl. every KMS call + S3 data events on documents) + GuardDuty   [enable_account_security]
Alerts:  CloudWatch alarms -> SNS -> e-mail; monthly AWS Budget
```

## First-time setup

```bash
# 1. Per account: state bucket + GitHub OIDC provider
cd infra/terraform/bootstrap
terraform init && terraform apply \
  -var state_bucket_name=<unique-name> -var github_repo=<owner/repo> -var infra_environment=dev-infra   # prod-infra in the prod account

# 2. Fill in app/envs/<env>.backend.hcl and <env>.tfvars (REPLACE markers)

# 3. ECR must exist before the first image can be pushed
cd ../app
terraform init -backend-config=envs/dev.backend.hcl
terraform apply -var-file=envs/dev.tfvars -target=module.compute.aws_ecr_repository.api

# 4. Build + push the API image (tag "bootstrap" matches api_image_tag) for the same CPU arch as api_cpu_architecture
# 5. Full apply
terraform apply -var-file=envs/dev.tfvars
```

Switching environment: `terraform init -reconfigure -backend-config=envs/prod.backend.hcl` and use `envs/prod.tfvars`
(with credentials for the prod account).

## GitHub configuration

Create four GitHub **environments**: `dev`, `prod` (app deploys), `dev-infra`, `prod-infra` (terraform apply).
Put required reviewers on `prod` and `prod-infra`.

| Where                          | Name                                                                                                              | Value (source)                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| env `dev-infra` / `prod-infra` | `TF_APPLY_ROLE_ARN`                                                                                               | bootstrap output `terraform_apply_role_arn` of that account |
| repo variables                 | `DEV_TF_PLAN_ROLE_ARN`, `PROD_TF_PLAN_ROLE_ARN`                                                                   | bootstrap output `terraform_plan_role_arn`                  |
| env `dev` / `prod`             | `AWS_REGION`, `DEPLOY_ROLE_ARN`                                                                                   | `github_deploy_role_arn`                                    |
| env `dev` / `prod`             | `ECR_REPOSITORY_URL`, `ECS_CLUSTER`, `SITE_BUCKET`, `CF_DISTRIBUTION_ID`, `API_TASK_FAMILY`, `WORKER_TASK_FAMILY` | matching `terraform output` values                          |
| env `dev` / `prod` | `MIGRATIONS_TASK_FAMILY`, `PRIVATE_SUBNET_IDS`, `ECS_SECURITY_GROUP_ID`                                           | matching `terraform output` values                          |
| env `dev` / `prod` | `COGNITO_HOSTED_UI_DOMAIN`, `COGNITO_CLIENT_ID`                                                                    | matching `terraform output` values                          |

## Fields that require credentials or deployment-specific values

- `infra/terraform/app/envs/*.tfvars`: set `app_domain`, `route53_zone_id`, `github_repo`, `github_oidc_provider_arn`, and account-specific alert/SES values. These are not AWS credentials and must not contain secrets.
- AWS credentials: provide them to Terraform and GitHub OIDC by configuring `aws configure`, an IAM role/profile, or `aws-actions/configure-aws-credentials`. Never add access keys to `.tfvars` or GitHub repository variables.
- Aurora database username/password: generated and stored in AWS Secrets Manager by Terraform; no source field should contain a database password.
- GitHub environment secret: `DEPLOY_ROLE_ARN`; GitHub environment variables: `AWS_REGION`, `ECR_REPOSITORY_URL`, `ECS_CLUSTER`, `SITE_BUCKET`, `CF_DISTRIBUTION_ID`, `API_TASK_FAMILY`, `WORKER_TASK_FAMILY`, `MIGRATIONS_TASK_FAMILY`, `PRIVATE_SUBNET_IDS`, `ECS_SECURITY_GROUP_ID`.
- Terraform plan/apply roles: set `DEV_TF_PLAN_ROLE_ARN`, `PROD_TF_PLAN_ROLE_ARN`, and `TF_APPLY_ROLE_ARN` from bootstrap outputs.
- Cognito web values: build the SPA with `VITE_COGNITO_DOMAIN` and `VITE_COGNITO_CLIENT_ID`; they are public configuration, not secrets.

Run `terraform fmt -recursive infra/terraform` once before opening the first PR (the plan job enforces `fmt -check`).

## Contract with the application

Env vars injected into the container: `PORT, AWS_REGION, DB_HOST, DB_PORT, DB_NAME, DB_USERNAME, DB_PASSWORD,
DOCUMENTS_BUCKET, KEYWRAP_KMS_KEY_ID, COGNITO_ISSUER, COGNITO_CLIENT_ID, GNUPGHOME, JOBS_QUEUE_URL`,
plus `SES_FROM_DOMAIN, SES_CONFIGURATION_SET` when `email_domain` is set, and `WORKER_MODE=true` in the worker only.

- Worker: long-poll `JOBS_QUEUE_URL`, delete the message only after the result is persisted, and handle SIGTERM
  (tasks get 120 s to drain). Jobs must be idempotent: messages move to the DLQ after 5 failed receives.
- Health check: `GET /api/health` -> 200 (unauthenticated). All other `/api/**` require a Cognito JWT.
- Read-only root filesystem: write only to `/tmp`.
- Every KMS keywrap call **must** pass an EncryptionContext (IAM enforces it), e.g. `{org_id, key_id}`.

## Workflows (`.github/workflows`)

- `infra.yml`: PR -> `fmt/validate/plan` for dev and prod (read-only role, plan posted as a PR comment). Merge to main -> apply dev, then apply prod after approval.
- `deploy.yml` / `_deploy.yml`: merge to main -> dev, then prod after approval: build arm64 image -> push -> register new task definitions for `api` and `worker` -> wait for stable -> build SPA -> sync to S3 -> invalidate `index.html`.
- `ci.yml`: PR checks for `apps/**`.
  All use GitHub OIDC; the deploy role is scoped to ECR push, ECS update, the SPA bucket, and one CloudFront invalidation.
  Terraform ignores `task_definition` and `desired_count` on the service, so infra applies never roll back a deploy.

## Still not included (recommended next)

AWS Config / Security Hub, AWS Backup with cross-region copy, multi-region DR, DB migration task + workflow step, a CloudWatch dashboard,
WAF in front of the API Gateway URL (it is reachable directly, bypassing CloudFront), Cognito custom domain, per-tenant S3 prefixes
with IAM session policies, and a split of the API and worker task roles (the worker currently shares the API role).
