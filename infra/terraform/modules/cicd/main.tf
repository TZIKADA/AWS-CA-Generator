# Role assumed by GitHub Actions using OIDC to publish Lambda images and the SPA.
variable "name" { type = string }
variable "github_subject" {
  type        = string
  description = "OIDC sub claim allowed to assume the role, e.g. repo:owner/repo:environment:prod"
}
variable "oidc_provider_arn" { type = string }
variable "ecr_repository_arn" { type = string }
variable "lambda_function_names" {
  type    = list(string)
  default = []
}
variable "site_bucket_arn" { type = string }
variable "distribution_arn" { type = string }

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

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
  dynamic "statement" {
    for_each = length(var.lambda_function_names) > 0 ? [1] : []
    content {
      actions = ["lambda:UpdateFunctionCode", "lambda:GetFunctionConfiguration"]
      resources = [
        for name in var.lambda_function_names :
        "arn:aws:lambda:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:function:${name}"
      ]
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
