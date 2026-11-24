variable "name" { type = string }
variable "kms_key_arn" { type = string }
variable "alert_emails" {
  type    = list(string)
  default = []
}
variable "monthly_budget_usd" {
  type    = number
  default = 0
}
variable "cluster_name" { type = string }
variable "ecs_services" {
  type        = map(string)
  description = "label => ECS service name, e.g. { api = \"api\", worker = \"worker\" }"
}
variable "alb_arn_suffix" { type = string }
variable "target_group_arn_suffix" { type = string }
variable "api_id" { type = string }
variable "db_cluster_id" { type = string }
variable "db_max_acu" { type = number }
variable "queue_name" { type = string }
variable "dlq_name" { type = string }

resource "aws_sns_topic" "alerts" {
  name              = "${var.name}-alerts"
  kms_master_key_id = var.kms_key_arn
}

# Each recipient must click the confirmation link AWS e-mails them.
resource "aws_sns_topic_subscription" "email" {
  for_each  = toset(var.alert_emails)
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

locals {
  ecs_alarms = merge([
    for label, svc in var.ecs_services : {
      "${label}-cpu-high" = {
        namespace  = "AWS/ECS", metric = "CPUUtilization", stat = "Average", threshold = 85
        period     = 300, evaluation = 3, operator = "GreaterThanThreshold", treat_missing = "notBreaching"
        dimensions = { ClusterName = var.cluster_name, ServiceName = svc }
      }
      "${label}-memory-high" = {
        namespace  = "AWS/ECS", metric = "MemoryUtilization", stat = "Average", threshold = 85
        period     = 300, evaluation = 3, operator = "GreaterThanThreshold", treat_missing = "notBreaching"
        dimensions = { ClusterName = var.cluster_name, ServiceName = svc }
      }
    }
  ]...)

  alarms = merge(local.ecs_alarms, {
    "alb-unhealthy-targets" = {
      namespace  = "AWS/ApplicationELB", metric = "UnHealthyHostCount", stat = "Maximum", threshold = 0
      period     = 60, evaluation = 3, operator = "GreaterThanThreshold", treat_missing = "notBreaching"
      dimensions = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.target_group_arn_suffix }
    }
    "alb-target-5xx" = {
      namespace  = "AWS/ApplicationELB", metric = "HTTPCode_Target_5XX_Count", stat = "Sum", threshold = 10
      period     = 300, evaluation = 1, operator = "GreaterThanThreshold", treat_missing = "notBreaching"
      dimensions = { LoadBalancer = var.alb_arn_suffix }
    }
    "apigw-5xx" = {
      namespace  = "AWS/ApiGateway", metric = "5xx", stat = "Sum", threshold = 10
      period     = 300, evaluation = 1, operator = "GreaterThanThreshold", treat_missing = "notBreaching"
      dimensions = { ApiId = var.api_id }
    }
    "aurora-cpu-high" = {
      namespace  = "AWS/RDS", metric = "CPUUtilization", stat = "Average", threshold = 80
      period     = 300, evaluation = 3, operator = "GreaterThanThreshold", treat_missing = "notBreaching"
      dimensions = { DBClusterIdentifier = var.db_cluster_id }
    }
    "aurora-capacity-near-max" = {
      namespace  = "AWS/RDS", metric = "ServerlessDatabaseCapacity", stat = "Average", threshold = var.db_max_acu * 0.9
      period     = 300, evaluation = 3, operator = "GreaterThanThreshold", treat_missing = "notBreaching"
      dimensions = { DBClusterIdentifier = var.db_cluster_id }
    }
    "jobs-dlq-not-empty" = {
      namespace  = "AWS/SQS", metric = "ApproximateNumberOfMessagesVisible", stat = "Maximum", threshold = 0
      period     = 300, evaluation = 1, operator = "GreaterThanThreshold", treat_missing = "notBreaching"
      dimensions = { QueueName = var.dlq_name }
    }
    "jobs-oldest-message-age" = {
      namespace  = "AWS/SQS", metric = "ApproximateAgeOfOldestMessage", stat = "Maximum", threshold = 900
      period     = 300, evaluation = 2, operator = "GreaterThanThreshold", treat_missing = "notBreaching"
      dimensions = { QueueName = var.queue_name }
    }
  })
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each            = local.alarms
  alarm_name          = "${var.name}-${each.key}"
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  statistic           = each.value.stat
  threshold           = each.value.threshold
  period              = each.value.period
  evaluation_periods  = each.value.evaluation
  comparison_operator = each.value.operator
  treat_missing_data  = each.value.treat_missing
  dimensions          = each.value.dimensions
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_budgets_budget" "monthly" {
  count        = var.monthly_budget_usd > 0 && length(var.alert_emails) > 0 ? 1 : 0
  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.alert_emails
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.alert_emails
  }
}

output "alerts_topic_arn" { value = aws_sns_topic.alerts.arn }
