variable "name" { type = string }
variable "region" { type = string }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }

variable "data_kms_key_arn" { type = string }
variable "keywrap_kms_key_arn" { type = string }
variable "documents_bucket_name" { type = string }
variable "documents_bucket_arn" { type = string }

variable "db_endpoint" { type = string }
variable "db_port" { type = number }
variable "db_name" { type = string }
variable "db_secret_arn" { type = string }

variable "cognito_issuer" { type = string }
variable "cognito_client_id" { type = string }

variable "image_tag" {
  type        = string
  default     = "bootstrap"
  description = "Only used for the first task definition; CI/CD registers new revisions afterwards."
}
variable "container_port" {
  type    = number
  default = 8080
}
variable "cpu_architecture" {
  type        = string
  default     = "ARM64"
  description = "ARM64 (Graviton, cheaper) or X86_64. Must match how CI builds the image."
}
variable "cpu" {
  type    = number
  default = 512
}
variable "memory" {
  type    = number
  default = 1024
}
variable "desired_count" {
  type    = number
  default = 2
}
variable "min_count" {
  type    = number
  default = 2
}
variable "max_count" {
  type    = number
  default = 6
}
variable "log_retention_days" {
  type    = number
  default = 90
}
variable "api_throttle_rate" {
  type    = number
  default = 50
}
variable "api_throttle_burst" {
  type    = number
  default = 100
}
variable "extra_environment" {
  type    = map(string)
  default = {}
}

variable "queue_arn" {
  type        = string
  default     = null
  description = "Jobs queue the API produces to (and the worker consumes from)."
}
variable "ses_identity_arn" {
  type    = string
  default = null
}
