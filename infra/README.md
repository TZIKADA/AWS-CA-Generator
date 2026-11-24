# Free-Tier AWS Deployment

The infrastructure uses only usage-based serverless services:

- CloudFront + private S3 SPA
- API Gateway HTTP API + Lambda
- Cognito
- DynamoDB on-demand
- S3 documents
- SQS + DLQ
- Amazon ECR for Lambda container images

It intentionally does not create NAT Gateways, Application Load Balancers, ECS/Fargate,
Aurora, customer-managed KMS keys, WAF, Route 53 zones, GuardDuty, or SES.
The account must remain on the applicable AWS Free Tier or free-credit plan and must
stay below service limits.

## First-time setup

1. Bootstrap the Terraform state bucket and GitHub OIDC provider:

```bash
cd infra/terraform/bootstrap
terraform init
terraform apply \
  -var state_bucket_name=<globally-unique-name> \
  -var github_repo=<owner/repo> \
  -var infra_environment=dev-infra
```

2. Fill `infra/terraform/app/envs/dev.tfvars` and `dev.backend.hcl`.
   Leave AWS credentials out of Terraform and GitHub variables.

3. Initialize and create the dev stack:

```bash
cd ../app
terraform init -backend-config=envs/dev.backend.hcl
terraform apply -var-file=envs/dev.tfvars
```

4. After the ECR repository is created, push the first image:

```bash
aws ecr get-login-password --region eu-west-1 |
  docker login --username AWS --password-stdin <ecr_repository_url>

docker buildx build --platform linux/arm64 \
  -f apps/api/Dockerfile.lambda \
  -t <ecr_repository_url>:bootstrap \
  --push apps/api
```

5. Update the Lambda functions with the bootstrap image or rerun Terraform.
   Deploy GitHub Actions then replaces both functions using the commit image.

## Required GitHub values

Repository variables:

- `DEV_TF_PLAN_ROLE_ARN`
- `PROD_TF_PLAN_ROLE_ARN`

Environment secret:

- `DEPLOY_ROLE_ARN`

Environment variables:

- `AWS_REGION`
- `ECR_REPOSITORY_URL`
- `SITE_BUCKET`
- `CF_DISTRIBUTION_ID`
- `API_FUNCTION_NAME`
- `WORKER_FUNCTION_NAME`
- `COGNITO_HOSTED_UI_DOMAIN`
- `COGNITO_CLIENT_ID`

Infrastructure apply environments need `TF_APPLY_ROLE_ARN`.

## Credential fields

- AWS credentials belong in the local AWS CLI profile or GitHub OIDC role.
- Do not put access keys in `.tfvars`, source files, or repository variables.
- Database credentials are no longer used; the serverless stack uses DynamoDB.
- Cognito hosted UI/domain and client ID are public configuration, not secrets.
- The private PGP signing key is supplied by the API request and stored in S3
  with S3-managed encryption. It must not be committed into Terraform or source.
