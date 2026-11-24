terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }

  # Per-environment values come from envs/<env>.backend.hcl
  backend "s3" {}
}
