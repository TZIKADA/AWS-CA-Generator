variable "name" { type = string }
variable "region" { type = string }
variable "callback_urls" { type = list(string) }
variable "logout_urls" { type = list(string) }
variable "hosted_ui_domain_prefix" {
  type        = string
  description = "Globally unique prefix for <prefix>.auth.<region>.amazoncognito.com"
}
variable "deletion_protection" {
  type    = bool
  default = true
}

# Cognito handles identity only (sign-up, login, MFA). Organisations, memberships, invitations and roles
# live in the application database, so one user can belong to several orgs.
resource "aws_cognito_user_pool" "this" {
  name                     = var.name
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OPTIONAL"
  deletion_protection      = var.deletion_protection ? "ACTIVE" : "INACTIVE"

  software_token_mfa_configuration { enabled = true }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  admin_create_user_config {
    allow_admin_create_user_only = false
  }
}

resource "aws_cognito_user_pool_client" "spa" {
  name         = "${var.name}-web"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret                      = false
  explicit_auth_flows                  = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = var.callback_urls
  logout_urls                          = var.logout_urls
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 30
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_cognito_user_pool_domain" "this" {
  domain       = var.hosted_ui_domain_prefix
  user_pool_id = aws_cognito_user_pool.this.id
}

output "user_pool_id" { value = aws_cognito_user_pool.this.id }
output "user_pool_arn" { value = aws_cognito_user_pool.this.arn }
output "client_id" { value = aws_cognito_user_pool_client.spa.id }
output "issuer" { value = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.this.id}" }
output "hosted_ui_domain" { value = "${aws_cognito_user_pool_domain.this.domain}.auth.${var.region}.amazoncognito.com" }
