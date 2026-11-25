locals {
  name = "${var.project}-${var.environment}"
}

data "aws_caller_identity" "current" {}

module "auth" {
  source                  = "../modules/auth"
  name                    = local.name
  region                  = var.aws_region
  hosted_ui_domain_prefix = "${local.name}-${data.aws_caller_identity.current.account_id}"
  callback_urls = concat(
    ["http://localhost:5173/auth/callback"],
    var.extra_callback_urls,
  )
  logout_urls         = concat(["http://localhost:5173/"], var.extra_logout_urls)
  deletion_protection = var.deletion_protection
}

module "backend" {
  source            = "../modules/backend"
  name              = local.name
  region            = var.aws_region
  cognito_issuer    = module.auth.issuer
  cognito_client_id = module.auth.client_id
}

moved {
  from = module.serverless
  to   = module.backend
}

moved {
  from = module.storage.aws_s3_bucket.documents
  to   = module.backend.aws_s3_bucket.documents
}

moved {
  from = module.storage.aws_s3_bucket_ownership_controls.documents
  to   = module.backend.aws_s3_bucket_ownership_controls.documents
}

moved {
  from = module.storage.aws_s3_bucket_public_access_block.documents
  to   = module.backend.aws_s3_bucket_public_access_block.documents
}

moved {
  from = module.storage.aws_s3_bucket_server_side_encryption_configuration.documents
  to   = module.backend.aws_s3_bucket_server_side_encryption_configuration.documents
}

moved {
  from = module.storage.aws_s3_bucket_versioning.documents
  to   = module.backend.aws_s3_bucket_versioning.documents
}

moved {
  from = module.storage.aws_s3_bucket_lifecycle_configuration.documents
  to   = module.backend.aws_s3_bucket_lifecycle_configuration.documents
}

moved {
  from = module.storage.aws_s3_bucket_cors_configuration.documents
  to   = module.backend.aws_s3_bucket_cors_configuration.documents
}

moved {
  from = module.backend.aws_s3_bucket_cors_configuration.documents
  to   = aws_s3_bucket_cors_configuration.documents
}

moved {
  from = module.storage.aws_s3_bucket_policy.documents
  to   = module.backend.aws_s3_bucket_policy.documents
}

module "frontend" {
  source            = "../modules/frontend"
  name              = local.name
  api_origin_domain = replace(module.backend.api_endpoint, "https://", "")
}

resource "aws_s3_bucket_cors_configuration" "documents" {
  bucket = module.backend.documents_bucket

  cors_rule {
    allowed_methods = ["PUT", "GET"]
    allowed_origins = [module.frontend.url, "http://localhost:5173"]
    allowed_headers = ["content-type"]
    max_age_seconds = 300
  }
}

module "cicd" {
  source             = "../modules/cicd"
  name               = local.name
  github_subject     = "repo:${var.github_repo}:environment:${var.environment}"
  oidc_provider_arn  = var.github_oidc_provider_arn
  ecr_repository_arn = module.backend.ecr_repository_arn
  site_bucket_arn    = module.frontend.site_bucket_arn
  distribution_arn   = module.frontend.distribution_arn
  lambda_function_names = [
    module.backend.api_function_name,
    module.backend.worker_function_name,
  ]
}
