environment = "dev"
aws_region  = "eu-west-1"

github_repo              = "your-org/your-repo" # REPLACE with GitHub owner/repository
github_oidc_provider_arn = "REPLACE_WITH_BOOTSTRAP_GITHUB_OIDC_PROVIDER_ARN"

extra_callback_urls = ["http://localhost:5173/auth/callback"]
extra_logout_urls   = ["http://localhost:5173/"]

deletion_protection = false
