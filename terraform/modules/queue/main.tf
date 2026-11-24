variable "name" { type = string }
variable "kms_key_arn" { type = string }
variable "visibility_timeout_seconds" {
  type        = number
  default     = 300
  description = "Must exceed the longest expected signing job."
}
variable "max_receive_count" {
  type    = number
  default = 5
}

resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name}-jobs-dlq"
  kms_master_key_id         = var.kms_key_arn
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "jobs" {
  name                       = "${var.name}-jobs"
  kms_master_key_id          = var.kms_key_arn
  visibility_timeout_seconds = var.visibility_timeout_seconds
  receive_wait_time_seconds  = 20
  message_retention_seconds  = 345600
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

data "aws_iam_policy_document" "tls_only" {
  for_each = { jobs = aws_sqs_queue.jobs, dlq = aws_sqs_queue.dlq }
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sqs:*"]
    resources = [each.value.arn]
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

resource "aws_sqs_queue_policy" "jobs" {
  queue_url = aws_sqs_queue.jobs.id
  policy    = data.aws_iam_policy_document.tls_only["jobs"].json
}

resource "aws_sqs_queue_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.id
  policy    = data.aws_iam_policy_document.tls_only["dlq"].json
}

output "url" { value = aws_sqs_queue.jobs.id }
output "arn" { value = aws_sqs_queue.jobs.arn }
output "name" { value = aws_sqs_queue.jobs.name }
output "dlq_name" { value = aws_sqs_queue.dlq.name }
output "dlq_arn" { value = aws_sqs_queue.dlq.arn }
