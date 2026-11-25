# AWS Free-Tier-Oriented Deployment

The default stack uses API Gateway + Lambda, Cognito, DynamoDB on-demand, S3, SQS,
ECR, and CloudFront. It does not create VPC/NAT, ALB, ECS, Aurora, customer-managed
KMS keys, WAF, Route 53, GuardDuty, or SES resources.

This is designed for very low usage, not a guarantee of a $0 AWS bill. Eligibility,
included quotas, and credits depend on account age, plan, region, and current AWS
terms. Check Billing → Free Tier and set a low AWS Budget before deploying.
Deploy **dev only**; deploying a second environment doubles resource usage.

## Fields to fill in

1. `infra/terraform/app/envs/dev.backend.hcl`
   - `bucket`: the globally unique Terraform state bucket created by bootstrap.
   - Keep `key` as `app/dev/terraform.tfstate`; region must match the bucket.
2. `infra/terraform/app/envs/dev.tfvars`
   - `github_repo`: your GitHub `owner/repository`.
   - `github_oidc_provider_arn`: bootstrap output `github_oidc_provider_arn`.
   - AWS region is `eu-west-1` by default; change only if desired and supported.
   - `extra_callback_urls` / `extra_logout_urls`: fill after the first apply with the
     CloudFront URL printed as `app_url` (see below).
3. AWS credentials:
   - Locally, configure an AWS CLI profile with permission to create the stack.
   - GitHub uses OIDC; do not put AWS access keys in `.tfvars`, source, or GitHub variables.
4. GitHub `dev-infra` environment:
   - Secret `TF_APPLY_ROLE_ARN`: bootstrap output `terraform_apply_role_arn`.
5. GitHub repository variables:
   - `DEV_TF_PLAN_ROLE_ARN`: bootstrap output `terraform_plan_role_arn`.
6. GitHub `dev` environment:
   - Secret `DEPLOY_ROLE_ARN`: Terraform output `github_deploy_role_arn`.
   - Variables `AWS_REGION`, `ECR_REPOSITORY_URL`, `SITE_BUCKET`,
     `CF_DISTRIBUTION_ID`, `API_FUNCTION_NAME`, `WORKER_FUNCTION_NAME`,
     `COGNITO_HOSTED_UI_DOMAIN`, `COGNITO_CLIENT_ID`: matching Terraform outputs.

Database credentials are not used; the app stores records in DynamoDB. Cognito's
hosted UI domain and client ID are public configuration, not credentials.

The optional organization-name suggestion calls Amazon Bedrock using the
`bedrock_model_id` configured by the backend module (default:
`eu.amazon.nova-micro-v1:0`). It requires model access in the selected region and
incurs Bedrock usage charges; document signing does not depend on Bedrock.

## First deployment

Bootstrap creates the state bucket and GitHub OIDC roles. Run it once in the AWS
account using an appropriately privileged local AWS profile:

```bash
cd infra/terraform/bootstrap
terraform init
terraform apply \
  -var state_bucket_name=<globally-unique-state-bucket> \
  -var github_repo=<owner/repository> \
  -var infra_environment=dev-infra
```

Then configure `dev.backend.hcl` and `dev.tfvars`, and initialize the application
stack. Lambda image functions cannot be created until their ECR image exists, so
create the repository first, push a bootstrap image, then apply the full stack:

```bash
cd ../app
terraform init -backend-config=envs/dev.backend.hcl
terraform apply -target=module.backend.aws_ecr_repository.api \
  -var-file=envs/dev.tfvars

cd ../../../
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=eu-west-1
REPOSITORY=$(terraform -chdir=infra/terraform/app output -raw ecr_repository_url)
aws ecr get-login-password --region "$REGION" |
  docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
docker buildx build --platform linux/arm64 \
  -f apps/api/Dockerfile.lambda \
  -t "${REPOSITORY}:bootstrap" \
  --push apps/api
cd infra/terraform/app
terraform apply -var-file=envs/dev.tfvars
```

Terraform outputs `app_url`. Add these values to `extra_callback_urls` and
`extra_logout_urls` in `dev.tfvars`, then run `terraform apply` again:

```hcl
extra_callback_urls = ["https://<cloudfront-host>/auth/callback"]
extra_logout_urls   = ["https://<cloudfront-host>/"]
```

The localhost callback URLs remain enabled for local web development. The deployed
SPA then signs in through Cognito at the CloudFront URL.

Use the outputs to configure GitHub values. Subsequent application pushes deploy
the Lambda image and SPA through `.github/workflows/deploy.yml`.

If upgrading an already-deployed relational/ECS stack, inspect the Terraform plan
before applying: ECS, Aurora, NAT, WAF, and other paid resources are removed. Back
up any Aurora data first. The documents bucket has explicit state moves to retain
its contents; the Lambda ECR repository is renamed to avoid colliding with the
former ECS image repository.

## Data/security limitations

- Document uploads and detached signatures expire after 30 days.
- Documents and signing keys use S3-managed encryption to avoid customer-managed
  KMS charges. Signing keys are sensitive; restrict AWS account access and never
  submit a key you cannot safely store there.
- Signing currently accepts unprotected PGP private keys only. Keep document
  uploads at or below 5 MiB for the worker's memory/runtime limit.
- The optional organization-name suggestion depends on Bedrock model availability
  and permissions in the configured region.
- This POC has no organization invitation workflow, audit trail, production WAF,
  multi-region recovery, or cost hard cap. Budgets alert; they do not stop usage.
