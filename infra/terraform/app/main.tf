locals {
  name = "${var.project}-${var.environment}"
}

data "aws_caller_identity" "current" {}

module "auth" {
  source                  = "../modules/auth"
  name                    = local.name
  region                  = var.aws_region
  hosted_ui_domain_prefix = "${local.name}-${data.aws_caller_identity.current.account_id}"
  callback_urls           = var.extra_callback_urls
  logout_urls             = var.extra_logout_urls
  deletion_protection     = var.deletion_protection
}

module "serverless" {
  source            = "../modules/free_serverless"
  name              = local.name
  region            = var.aws_region
  cognito_issuer    = module.auth.issuer
  cognito_client_id = module.auth.client_id
}

module "frontend" {
  source            = "../modules/frontend"
  name              = local.name
  domain_name       = var.app_domain
  route53_zone_id   = var.route53_zone_id
  api_origin_domain = replace(module.serverless.api_endpoint, "https://", "")
}

module "cicd" {
  source             = "../modules/cicd"
  name               = local.name
  github_repo        = var.github_repo
  github_subject     = "repo:${var.github_repo}:environment:${var.environment}"
  oidc_provider_arn  = var.github_oidc_provider_arn
  ecr_repository_arn = module.serverless.ecr_repository_arn
  ecs_service_arns   = []
  pass_role_arns     = []
  site_bucket_arn    = module.frontend.site_bucket_arn
  distribution_arn   = module.frontend.distribution_arn
  lambda_function_names = [
    module.serverless.api_function_name,
    module.serverless.worker_function_name,
  ]
}
