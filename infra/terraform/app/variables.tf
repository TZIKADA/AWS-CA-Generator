variable "project" {
  type    = string
  default = "sigvault"
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "aws_region" {
  type    = string
  default = "eu-west-1"
}

variable "deletion_protection" {
  type    = bool
  default = false
}

variable "extra_callback_urls" {
  type        = list(string)
  default     = []
  description = "Additional Cognito callback URLs, such as the deployed CloudFront app URL."
}

variable "extra_logout_urls" {
  type        = list(string)
  default     = []
  description = "Additional Cognito logout URLs, such as the deployed CloudFront app URL."
}

variable "github_repo" {
  type        = string
  description = "GitHub repository in owner/repo format."
}

variable "github_oidc_provider_arn" {
  type        = string
  description = "GitHub OIDC provider ARN created by the bootstrap stack."
}
