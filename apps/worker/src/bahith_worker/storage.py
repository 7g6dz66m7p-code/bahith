"""S3-compatible object storage for the worker (MinIO locally, S3/R2 in the cloud)."""

import base64
import hashlib
from typing import Protocol

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError


class StorageError(Exception):
    """Stable codes only; object keys and contents never appear in the message."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class ObjectStorage(Protocol):
    def get_bytes(self, key: str, max_bytes: int) -> bytes: ...

    def put(self, key: str, data: bytes, content_type: str) -> None: ...


class S3Storage:
    def __init__(
        self,
        *,
        bucket: str,
        region: str,
        access_key_id: str,
        secret_access_key: str,
        endpoint: str | None = None,
        force_path_style: bool = False,
    ) -> None:
        self._bucket = bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            config=Config(
                s3={"addressing_style": "path" if force_path_style else "auto"},
                retries={"max_attempts": 3, "mode": "standard"},
                connect_timeout=10,
                read_timeout=60,
            ),
        )

    def get_bytes(self, key: str, max_bytes: int) -> bytes:
        if max_bytes < 0:
            raise StorageError("STORAGE_TOO_LARGE")
        try:
            response = self._client.get_object(Bucket=self._bucket, Key=key)
            body = response["Body"]
            try:
                if int(response.get("ContentLength", 0)) > max_bytes:
                    raise StorageError("STORAGE_TOO_LARGE")
                data = body.read(max_bytes + 1)
                if len(data) > max_bytes:
                    raise StorageError("STORAGE_TOO_LARGE")
                return data
            finally:
                body.close()
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code", "")
            raise StorageError(
                "STORAGE_NOT_FOUND" if code in {"NoSuchKey", "404"} else "STORAGE_UNAVAILABLE"
            ) from None
        except (BotoCoreError, OSError):
            raise StorageError("STORAGE_UNAVAILABLE") from None

    def put(self, key: str, data: bytes, content_type: str) -> None:
        try:
            self._client.put_object(
                Bucket=self._bucket,
                Key=key,
                Body=data,
                ContentType=content_type,
                ChecksumSHA256=base64.b64encode(hashlib.sha256(data).digest()).decode(),
            )
        except (ClientError, BotoCoreError):
            raise StorageError("STORAGE_UNAVAILABLE") from None
