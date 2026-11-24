import boto3

from .config import settings

_s3 = boto3.client("s3", region_name=settings.aws_region)


def upload_url(org_id: str, doc_id: str, content_type: str, expires: int = 86_400) -> str:
    return _s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.documents_bucket,
            "Key": f"uploads/{org_id}/{doc_id}",
            "ContentType": content_type,
        },
        ExpiresIn=expires,
    )


def download_url(org_id: str, doc_id: str, expires: int = 2_592_000) -> str:  # 30 days
    return _s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.documents_bucket, "Key": f"signed/{org_id}/{doc_id}"},
        ExpiresIn=expires,
    )
