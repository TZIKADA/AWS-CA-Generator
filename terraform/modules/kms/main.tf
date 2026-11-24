variable "name" { type = string }
variable "region" { type = string }
variable "deletion_window_in_days" {
  type    = number
  default = 30
}

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
}

# Key 1: general data-at-rest (S3, Aurora, Secrets Manager, logs, ECR)
data "aws_iam_policy_document" "data" {
  statement {
    sid       = "EnableIAMPolicies"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }
  statement {
    sid       = "AllowCloudWatchLogs"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${var.region}:${local.account_id}:*"]
    }
  }
  statement {
    sid       = "AllowCloudTrail"
    actions   = ["kms:GenerateDataKey*", "kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:aws:cloudtrail:arn"
      values   = ["arn:aws:cloudtrail:*:${local.account_id}:trail/*"]
    }
  }
  statement {
    sid       = "AllowCloudWatchAlarmsToPublishToEncryptedSNS"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_kms_key" "data" {
  description             = "${var.name} data at rest"
  enable_key_rotation     = true
  deletion_window_in_days = var.deletion_window_in_days
  policy                  = data.aws_iam_policy_document.data.json
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

# Key 2: envelope encryption of customer private keys / certificates.
# The API calls GenerateDataKey/Decrypt with an EncryptionContext (e.g. {org_id, key_id}), encrypts the
# private key material with the data key, and stores only ciphertext + wrapped data key in the DB.
# No service principals are granted; only the API task role (see compute module) may use it.
resource "aws_kms_key" "keywrap" {
  description             = "${var.name} customer key-material wrapping"
  enable_key_rotation     = true
  deletion_window_in_days = var.deletion_window_in_days
}

resource "aws_kms_alias" "keywrap" {
  name          = "alias/${var.name}-keywrap"
  target_key_id = aws_kms_key.keywrap.key_id
}

output "data_key_arn" { value = aws_kms_key.data.arn }
output "keywrap_key_arn" { value = aws_kms_key.keywrap.arn }
