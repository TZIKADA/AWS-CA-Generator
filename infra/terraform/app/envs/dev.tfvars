environment     = "dev"
aws_region      = "eu-west-1"
app_domain      = "dev.example.com"      # REPLACE
route53_zone_id = "Z0000000000000000000" # REPLACE

github_repo              = "your-org/your-repo"                                                          # REPLACE
github_oidc_provider_arn = "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com" # from bootstrap output

vpc_cidr           = "10.20.0.0/16"
single_nat_gateway = true

db_min_acu        = 0.5
db_max_acu        = 2
db_instance_count = 1

api_desired_count = 1
api_min_count     = 1
api_max_count     = 2

extra_callback_urls = ["http://localhost:5173/auth/callback"]
extra_logout_urls   = ["http://localhost:5173/"]

deletion_protection   = false
force_destroy_buckets = true
