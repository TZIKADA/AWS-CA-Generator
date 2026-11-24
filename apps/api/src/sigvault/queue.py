import json

import boto3

from .config import settings

_sqs = boto3.client("sqs", region_name=settings.aws_region)


def enqueue(payload: dict) -> str:
    if not settings.jobs_queue_url:
        raise RuntimeError("JOBS_QUEUE_URL is not configured")
    r = _sqs.send_message(QueueUrl=settings.jobs_queue_url, MessageBody=json.dumps(payload))
    return r["MessageId"]


def receive(wait_seconds: int = 20, max_messages: int = 1) -> list[dict]:
    r = _sqs.receive_message(
        QueueUrl=settings.jobs_queue_url,
        MaxNumberOfMessages=max_messages,
        WaitTimeSeconds=wait_seconds,
        VisibilityTimeout=300,
        AttributeNames=["All"],
    )
    return r.get("Messages", [])


def delete(receipt_handle: str) -> None:
    _sqs.delete_message(QueueUrl=settings.jobs_queue_url, ReceiptHandle=receipt_handle)
