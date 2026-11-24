variable "name" { type = string }
variable "kms_key_arn" { type = string }
variable "cors_allowed_origins" { type = list(string) }
variable "upload_retention_days" {
  type    = number
  default = 1
}
variable "signed_retention_days" {
  type    = number
  default = 30
}
variable "force_destroy" {
  type    = bool
  default = false
}

data "aws_caller_identity" "current" {}

# Document flow: browser PUTs to uploads/<org>/<id> via presigned URL -> API signs -> writes signed/<org>/<id>
# -> browser GETs via presigned URL. This avoids the 10 MB API Gateway payload limit.
resource "aws_s3_bucket" "documents" {
  bucket        = "${var.name}-documents-${data.aws_caller_identity.current.account_id}"
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_ownership_controls" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket     = aws_s3_bucket.documents.id
  depends_on = [aws_s3_bucket_versioning.documents]

  rule {
    id     = "expire-uploads"
    status = "Enabled"
    filter { prefix = "uploads/" }
    expiration { days = var.upload_retention_days }
    noncurrent_version_expiration { noncurrent_days = 1 }
  }

  rule {
    id     = "expire-signed"
    status = "Enabled"
    filter { prefix = "signed/" }
    expiration { days = var.signed_retention_days }
    noncurrent_version_expiration { noncurrent_days = 7 }
  }

  rule {
    id     = "abort-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

resource "aws_s3_bucket_cors_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  cors_rule {
    allowed_methods = ["PUT", "GET"]
    allowed_origins = var.cors_allowed_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

data "aws_iam_policy_document" "documents" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.documents.arn, "${aws_s3_bucket.documents.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "documents" {
  bucket = aws_s3_bucket.documents.id
  policy = data.aws_iam_policy_document.documents.json
}

output "documents_bucket_name" { value = aws_s3_bucket.documents.id }
output "documents_bucket_arn" { value = aws_s3_bucket.documents.arn }
