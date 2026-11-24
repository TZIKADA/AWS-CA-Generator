variable "project" {
  type    = string
  default = "sigvault" # placeholder - rename to your product
}
variable "environment" { type = string }
variable "aws_region" {
  type    = string
  default = "eu-west-1"
}

# DNS
variable "app_domain" {
  type        = string
  description = "Full hostname for the app, e.g. app.example.com. API is served at https://<app_domain>/api"
}
variable "route53_zone_id" {
  type        = string
  description = "Hosted zone that contains app_domain"
}

# Network
variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}
variable "az_count" {
  type    = number
  default = 2
}
variable "single_nat_gateway" {
  type    = bool
  default = true
}
variable "enable_interface_endpoints" {
  type    = bool
  default = false
}

# Database
variable "db_min_acu" {
  type    = number
  default = 0.5
}
variable "db_max_acu" {
  type    = number
  default = 4
}
variable "db_instance_count" {
  type    = number
  default = 1
}
variable "db_backup_retention_days" {
  type    = number
  default = 7
}

# Protection toggles (true in prod)
variable "deletion_protection" {
  type    = bool
  default = false
}
variable "force_destroy_buckets" {
  type    = bool
  default = false
}

# API
variable "api_cpu_architecture" {
  type    = string
  default = "ARM64"
}
variable "api_cpu" {
  type    = number
  default = 512
}
variable "api_memory" {
  type    = number
  default = 1024
}
variable "api_desired_count" {
  type    = number
  default = 1
}
variable "api_min_count" {
  type    = number
  default = 1
}
variable "api_max_count" {
  type    = number
  default = 3
}
variable "api_image_tag" {
  type    = string
  default = "bootstrap"
}

# Auth
variable "extra_callback_urls" {
  type        = list(string)
  default     = []
  description = "e.g. http://localhost:5173/auth/callback for local dev"
}
variable "extra_logout_urls" {
  type    = list(string)
  default = []
}

# CI/CD
variable "github_repo" {
  type        = string
  description = "owner/repo allowed to deploy the app"
}
variable "github_oidc_provider_arn" {
  type        = string
  description = "From bootstrap output"
}

# Worker (async signing jobs)
variable "worker_command" {
  type        = list(string)
  default     = []
  description = "Optional command override. Empty = image default, with WORKER_MODE=true set in the environment."
}
variable "worker_cpu" {
  type    = number
  default = 1024
}
variable "worker_memory" {
  type    = number
  default = 2048
}
variable "worker_desired_count" {
  type    = number
  default = 1
}
variable "worker_min_count" {
  type    = number
  default = 1
}
variable "worker_max_count" {
  type    = number
  default = 5
}

# E-mail (invitations)
variable "email_domain" {
  type        = string
  default     = null
  description = "Sending domain inside route53_zone_id's zone (e.g. example.com). null disables SES."
}

# Monitoring / cost
variable "alert_emails" {
  type    = list(string)
  default = []
}
variable "monthly_budget_usd" {
  type    = number
  default = 0
}

# Account-level security services. Enable in exactly ONE stack per AWS account.
variable "enable_account_security" {
  type    = bool
  default = false
}
