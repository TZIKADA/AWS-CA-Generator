variable "name" { type = string }
variable "region" { type = string }
variable "cognito_issuer" { type = string }
variable "cognito_client_id" { type = string }

data "aws_caller_identity" "current" {}

resource "aws_dynamodb_table" "this" {
  name         = "${var.name}-data"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }
  attribute {
    name = "GSI1PK"
    type = "S"
  }
  attribute {
    name = "GSI1SK"
    type = "S"
  }

  global_secondary_index {
    name            = "GSI1"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "ALL"
  }

  server_side_encryption { enabled = true }
}

resource "aws_s3_bucket" "documents" {
  bucket        = "${var.name}-documents-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    id     = "delete-old-files"
    status = "Enabled"
    filter {
      and {
        prefix = "uploads/"
      }
    }
    expiration { days = 30 }
  }
  rule {
    id     = "delete-old-signatures"
    status = "Enabled"
    filter {
      and {
        prefix = "signed/"
      }
    }
    expiration { days = 30 }
  }
}

resource "aws_s3_bucket_cors_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  cors_rule {
    allowed_methods = ["PUT", "GET"]
    allowed_origins = ["*"]
    allowed_headers = ["*"]
    max_age_seconds = 300
  }
}

resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name}-jobs-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "jobs" {
  name                       = "${var.name}-jobs"
  visibility_timeout_seconds = 300
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 3
  })
}

resource "aws_ecr_repository" "api" {
  name                 = "${var.name}-api"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_iam_role" "lambda" {
  name = "${var.name}-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "application" {
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
          "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"
        ]
        Resource = [
          aws_dynamodb_table.this.arn,
          "${aws_dynamodb_table.this.arn}/index/*"
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.documents.arn, "${aws_s3_bucket.documents.arn}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = [aws_sqs_queue.jobs.arn, aws_sqs_queue.dlq.arn]
      }
    ]
  })
}

locals {
  lambda_environment = {
    AWS_REGION        = var.region
    DYNAMODB_TABLE    = aws_dynamodb_table.this.name
    DOCUMENTS_BUCKET  = aws_s3_bucket.documents.id
    JOBS_QUEUE_URL    = aws_sqs_queue.jobs.id
    COGNITO_ISSUER    = var.cognito_issuer
    COGNITO_CLIENT_ID = var.cognito_client_id
  }
}

resource "aws_lambda_function" "api" {
  function_name = "${var.name}-api"
  role          = aws_iam_role.lambda.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.api.repository_url}:bootstrap"
  timeout       = 30
  memory_size   = 512
  architectures = ["arm64"]
  environment { variables = local.lambda_environment }
}

resource "aws_lambda_function" "worker" {
  function_name = "${var.name}-worker"
  role          = aws_iam_role.lambda.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.api.repository_url}:bootstrap"
  timeout       = 300
  memory_size   = 1024
  architectures = ["arm64"]
  image_config { command = ["sigvault.lambda_handler.worker_handler"] }
  environment { variables = local.lambda_environment }
}

resource "aws_lambda_event_source_mapping" "worker" {
  event_source_arn = aws_sqs_queue.jobs.arn
  function_name    = aws_lambda_function.worker.arn
  batch_size       = 1
  enabled          = true
}

resource "aws_apigatewayv2_api" "this" {
  name          = "${var.name}-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.this.id
  name             = "cognito"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  jwt_configuration {
    audience = [var.cognito_client_id]
    issuer   = var.cognito_issuer
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "health" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "GET /api/health"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_route" "api" {
  api_id             = aws_apigatewayv2_api.this.id
  route_key          = "ANY /api/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

output "api_endpoint" { value = aws_apigatewayv2_api.this.api_endpoint }
output "api_function_name" { value = aws_lambda_function.api.function_name }
output "worker_function_name" { value = aws_lambda_function.worker.function_name }
output "ecr_repository_url" { value = aws_ecr_repository.api.repository_url }
output "ecr_repository_arn" { value = aws_ecr_repository.api.arn }
output "documents_bucket" { value = aws_s3_bucket.documents.id }
output "jobs_queue_url" { value = aws_sqs_queue.jobs.id }
