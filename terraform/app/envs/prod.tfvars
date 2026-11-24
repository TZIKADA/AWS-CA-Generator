environment     = "prod"
aws_region      = "eu-west-1"
app_domain      = "app.example.com"      # REPLACE
route53_zone_id = "Z0000000000000000000" # REPLACE

github_repo              = "your-org/your-repo"                                                          # REPLACE
github_oidc_provider_arn = "arn:aws:iam::222222222222:oidc-provider/token.actions.githubusercontent.com" # prod account

vpc_cidr                   = "10.30.0.0/16"
az_count                   = 3
single_nat_gateway         = false
enable_interface_endpoints = true

db_min_acu               = 1
db_max_acu               = 16
db_instance_count        = 2
db_backup_retention_days = 35

api_desired_count = 2
api_min_count     = 2
api_max_count     = 10

deletion_protection   = true
force_destroy_buckets = false

alert_emails            = ["ops@example.com"] # REPLACE
monthly_budget_usd      = 1500
email_domain            = "example.com" # REPLACE
worker_desired_count    = 2
worker_min_count        = 2
worker_max_count        = 10
enable_account_security = true # CloudTrail + GuardDuty for the whole prod account
