# Do not apply a second stack if your goal is to stay within free-tier usage.
environment              = "prod"
aws_region               = "eu-west-1"
github_repo              = "your-org/your-repo" # REPLACE with GitHub owner/repository
github_oidc_provider_arn = "REPLACE_WITH_BOOTSTRAP_GITHUB_OIDC_PROVIDER_ARN"
deletion_protection      = false
