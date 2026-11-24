# Role that GitHub Actions assumes (OIDC, no long-lived keys) to deploy the APPLICATION
# (push image, roll ECS, sync SPA, invalidate CDN). Infra changes (terraform apply) use a separate,
# more privileged role that you should create per account and protect with GitHub environment approvals.
variable "name" { type = string }
variable "github_repo" {
  type        = string
  description = "owner/repo"
}
variable "github_subject" {
  type        = string
  description = "OIDC sub claim allowed to assume the role, e.g. repo:owner/repo:environment:prod"
}
variable "oidc_provider_arn" { type = string }
variable "ecr_repository_arn" { type = string }
variable "ecs_service_arns" { type = list(string) }
variable "pass_role_arns" { type = list(string) }
variable "site_bucket_arn" { type = string }
variable "distribution_arn" { type = string }

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [var.github_subject]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "${var.name}-app-deploy"
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

data "aws_iam_policy_document" "deploy" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeImages"
    ]
    resources = [var.ecr_repository_arn]
  }
  statement {
    actions   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition", "ecs:ListTaskDefinitions"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecs:UpdateService", "ecs:DescribeServices"]
    resources = var.ecs_service_arns
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = var.pass_role_arns
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [var.site_bucket_arn]
  }
  statement {
    actions   = ["s3:PutObject", "s3:DeleteObject", "s3:GetObject"]
    resources = ["${var.site_bucket_arn}/*"]
  }
  statement {
    actions   = ["cloudfront:CreateInvalidation"]
    resources = [var.distribution_arn]
  }
}

resource "aws_iam_role_policy" "deploy" {
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

output "deploy_role_arn" { value = aws_iam_role.deploy.arn }
