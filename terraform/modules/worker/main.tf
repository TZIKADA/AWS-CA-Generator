# Same image as the API, no load balancer. Pulls signing jobs from SQS (large files, batch signing, cert generation).
# The app switches behaviour on WORKER_MODE=true (or set `command` to run a different entrypoint).
variable "name" { type = string }
variable "region" { type = string }
variable "cluster_arn" { type = string }
variable "cluster_name" { type = string }
variable "subnet_ids" { type = list(string) }
variable "security_group_id" { type = string }
variable "ecr_repository_url" { type = string }
variable "execution_role_arn" { type = string }
variable "task_role_arn" { type = string }
variable "log_group_name" { type = string }
variable "container_environment" { type = map(string) }
variable "container_secrets" { type = list(map(string)) }
variable "image_tag" {
  type    = string
  default = "bootstrap"
}
variable "command" {
  type    = list(string)
  default = []
}
variable "cpu_architecture" {
  type    = string
  default = "ARM64"
}
variable "cpu" {
  type    = number
  default = 1024
}
variable "memory" {
  type    = number
  default = 2048
}
variable "desired_count" {
  type    = number
  default = 1
}
variable "min_count" {
  type    = number
  default = 1
}
variable "max_count" {
  type    = number
  default = 5
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  volume { name = "scratch" }

  container_definitions = jsonencode([merge({
    name                   = "worker"
    image                  = "${var.ecr_repository_url}:${var.image_tag}"
    essential              = true
    readonlyRootFilesystem = true
    stopTimeout            = 120 # let in-flight signing jobs finish on scale-in / deploy
    mountPoints            = [{ sourceVolume = "scratch", containerPath = "/tmp", readOnly = false }]
    linuxParameters = {
      initProcessEnabled = true
      capabilities       = { drop = ["ALL"] }
    }
    environment = [for k, v in merge(var.container_environment, { WORKER_MODE = "true" }) : { name = k, value = v }]
    secrets     = var.container_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = var.log_group_name
        awslogs-region        = var.region
        awslogs-stream-prefix = "worker"
      }
    }
  }, length(var.command) > 0 ? { command = var.command } : {})])
}

resource "aws_ecs_service" "worker" {
  name                               = "worker"
  cluster                            = var.cluster_arn
  task_definition                    = aws_ecs_task_definition.worker.arn
  desired_count                      = var.desired_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [var.security_group_id]
    assign_public_ip = false
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}

resource "aws_appautoscaling_target" "worker" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${var.cluster_name}/${aws_ecs_service.worker.name}"
  min_capacity       = var.min_count
  max_capacity       = var.max_count
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "${var.name}-worker-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.worker.service_namespace
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  resource_id        = aws_appautoscaling_target.worker.resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

output "service_name" { value = aws_ecs_service.worker.name }
output "service_arn" { value = aws_ecs_service.worker.id }
output "task_family" { value = aws_ecs_task_definition.worker.family }
