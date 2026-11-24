"""Bounded object reads release connections and expose stable retry codes only."""

import io
from typing import Any

import pytest

from bahith_worker.storage import S3Storage, StorageError


def storage_for(body: io.BytesIO, content_length: int | None = None) -> S3Storage:
    class Client:
        def get_object(self, **kwargs: Any) -> dict[str, Any]:
            response: dict[str, Any] = {"Body": body}
            if content_length is not None:
                response["ContentLength"] = content_length
            return response

    storage = object.__new__(S3Storage)
    storage._bucket = "test-bucket"
    storage._client = Client()
    return storage


@pytest.mark.parametrize("declared", [None, 1, 100])
def test_oversized_objects_are_rejected_and_closed(declared: int | None) -> None:
    body = io.BytesIO(b"x" * 100)
    with pytest.raises(StorageError, match=r"^STORAGE_TOO_LARGE$"):
        storage_for(body, declared).get_bytes("test-key", 4)
    assert body.closed


def test_bounded_success_closes_the_response() -> None:
    body = io.BytesIO(b"data")
    assert storage_for(body).get_bytes("test-key", 4) == b"data"
    assert body.closed


def test_transport_errors_during_read_are_retryable_and_body_is_closed() -> None:
    class BrokenBody(io.BytesIO):
        def read(self, size: int = -1) -> bytes:
            raise OSError("private network details")

    body = BrokenBody()
    with pytest.raises(StorageError, match=r"^STORAGE_UNAVAILABLE$"):
        storage_for(body).get_bytes("test-key", 4)
    assert body.closed
