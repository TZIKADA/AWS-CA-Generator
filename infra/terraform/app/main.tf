locals {
  name = "${var.project}-${var.environment}"
}

data "aws_caller_identity" "current" {}

module "kms" {
  source = "../modules/kms"
  name   = local.name
  region = var.aws_region
}

module "network" {
  source                     = "../modules/network"
  name                       = local.name
  region                     = var.aws_region
  vpc_cidr                   = var.vpc_cidr
  az_count                   = var.az_count
  single_nat_gateway         = var.single_nat_gateway
  enable_interface_endpoints = var.enable_interface_endpoints
  flow_log_kms_key_arn       = module.kms.data_key_arn
}

module "storage" {
  source               = "../modules/storage"
  name                 = local.name
  kms_key_arn          = module.kms.data_key_arn
  cors_allowed_origins = concat(["https://${var.app_domain}"], [for u in var.extra_callback_urls : regex("^https?://[^/]+", u)])
  force_destroy        = var.force_destroy_buckets
}

module "auth" {
  source                  = "../modules/auth"
  name                    = local.name
  region                  = var.aws_region
  hosted_ui_domain_prefix = "${local.name}-${data.aws_caller_identity.current.account_id}"
  callback_urls           = concat(["https://${var.app_domain}/auth/callback"], var.extra_callback_urls)
  logout_urls             = concat(["https://${var.app_domain}/"], var.extra_logout_urls)
  deletion_protection     = var.deletion_protection
}

module "database" {
  source                   = "../modules/database"
  name                     = local.name
  vpc_id                   = module.network.vpc_id
  data_subnet_ids          = module.network.data_subnet_ids
  client_security_group_id = module.compute.ecs_security_group_id
  kms_key_arn              = module.kms.data_key_arn
  min_acu                  = var.db_min_acu
  max_acu                  = var.db_max_acu
  instance_count           = var.db_instance_count
  backup_retention_days    = var.db_backup_retention_days
  deletion_protection      = var.deletion_protection
}

module "compute" {
  source             = "../modules/compute"
  name               = local.name
  region             = var.aws_region
  vpc_id             = module.network.vpc_id
  private_subnet_ids = module.network.private_subnet_ids

  data_kms_key_arn      = module.kms.data_key_arn
  keywrap_kms_key_arn   = module.kms.keywrap_key_arn
  documents_bucket_name = module.storage.documents_bucket_name
  documents_bucket_arn  = module.storage.documents_bucket_arn

  db_endpoint   = module.database.endpoint
  db_port       = module.database.port
  db_name       = module.database.database_name
  db_secret_arn = module.database.master_secret_arn

  cognito_issuer    = module.auth.issuer
  cognito_client_id = module.auth.client_id

  cpu_architecture = var.api_cpu_architecture
  cpu              = var.api_cpu
  memory           = var.api_memory
  desired_count    = var.api_desired_count
  min_count        = var.api_min_count
  max_count        = var.api_max_count
  image_tag        = var.api_image_tag

  queue_arn        = module.queue.arn
  ses_identity_arn = try(module.email[0].identity_arn, null)
  extra_environment = merge(
    { JOBS_QUEUE_URL = module.queue.url },
    var.email_domain == null ? {} : {
      SES_FROM_DOMAIN       = var.email_domain
      SES_CONFIGURATION_SET = module.email[0].configuration_set_name
    }
  )
}

module "frontend" {
  source = "../modules/frontend"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }
  name              = local.name
  domain_name       = var.app_domain
  route53_zone_id   = var.route53_zone_id
  api_origin_domain = module.compute.api_origin_domain
}

module "cicd" {
  source             = "../modules/cicd"
  name               = local.name
  github_repo        = var.github_repo
  github_subject     = "repo:${var.github_repo}:environment:${var.environment}"
  oidc_provider_arn  = var.github_oidc_provider_arn
  ecr_repository_arn = module.compute.ecr_repository_arn
  ecs_service_arns   = [module.compute.service_arn, module.worker.service_arn]
  pass_role_arns     = [module.compute.execution_role_arn, module.compute.task_role_arn]
  site_bucket_arn    = module.frontend.site_bucket_arn
  distribution_arn   = module.frontend.distribution_arn
}

module "queue" {
  source      = "../modules/queue"
  name        = local.name
  kms_key_arn = module.kms.data_key_arn
}

module "worker" {
  source             = "../modules/worker"
  name               = local.name
  region             = var.aws_region
  cluster_arn        = module.compute.cluster_arn
  cluster_name       = module.compute.cluster_name
  subnet_ids         = module.network.private_subnet_ids
  security_group_id  = module.compute.ecs_security_group_id
  ecr_repository_url = module.compute.ecr_repository_url
  execution_role_arn = module.compute.execution_role_arn
  task_role_arn      = module.compute.task_role_arn
  log_group_name     = module.compute.log_group_name

  container_environment = module.compute.container_environment
  container_secrets     = module.compute.container_secrets

  image_tag        = var.api_image_tag
  command          = var.worker_command
  cpu_architecture = var.api_cpu_architecture
  cpu              = var.worker_cpu
  memory           = var.worker_memory
  desired_count    = var.worker_desired_count
  min_count        = var.worker_min_count
  max_count        = var.worker_max_count
}

module "email" {
  count           = var.email_domain == null ? 0 : 1
  source          = "../modules/email"
  name            = local.name
  domain          = var.email_domain
  route53_zone_id = var.route53_zone_id
}

module "security" {
  count                = var.enable_account_security ? 1 : 0
  source               = "../modules/security"
  name                 = local.name
  kms_key_arn          = module.kms.data_key_arn
  documents_bucket_arn = module.storage.documents_bucket_arn
}

module "observability" {
  source                  = "../modules/observability"
  name                    = local.name
  kms_key_arn             = module.kms.data_key_arn
  alert_emails            = var.alert_emails
  monthly_budget_usd      = var.monthly_budget_usd
  cluster_name            = module.compute.cluster_name
  ecs_services            = { api = module.compute.service_name, worker = module.worker.service_name }
  alb_arn_suffix          = module.compute.alb_arn_suffix
  target_group_arn_suffix = module.compute.target_group_arn_suffix
  api_id                  = module.compute.api_id
  db_cluster_id           = module.database.cluster_id
  db_max_acu              = var.db_max_acu
  queue_name              = module.queue.name
  dlq_name                = module.queue.dlq_name
}
