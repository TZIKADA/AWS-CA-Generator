variable "name" { type = string }
variable "region" { type = string }
variable "vpc_cidr" { type = string }
variable "az_count" {
  type    = number
  default = 2
}
variable "single_nat_gateway" {
  type        = bool
  default     = true
  description = "true = one shared NAT (cheap, dev). false = one per AZ (HA, prod)."
}
variable "enable_interface_endpoints" {
  type        = bool
  default     = false
  description = "PrivateLink endpoints for ECR/Logs/KMS/Secrets Manager. Keeps traffic off the NAT; costs roughly 7 USD/month each per AZ."
}
variable "flow_log_kms_key_arn" {
  type    = string
  default = null
}
variable "flow_log_retention_days" {
  type    = number
  default = 90
}
