"""sanad.extract handler: contracts shared with TypeScript, integrity, failures, OCR path."""

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from bahith_worker.jobs.extract import (
    ExtractPayload,
    IngestExtracted,
    IngestFailed,
    make_extract_handler,
    manifest_key,
)
from bahith_worker.sanad.ocr import ocr_available
from bahith_worker.storage import StorageError

CONTRACTS = Path(__file__).resolve().parents[3] / "packages" / "pipeline" / "contracts"
OCR_FIXTURES = Path(__file__).parent / "fixtures" / "ocr"


class MemoryStorage:
    def __init__(self, objects: dict[str, bytes] | None = None) -> None:
        self.objects = dict(objects or {})
        self.unavailable = False

    def get_bytes(self, key: str, max_bytes: int) -> bytes:
        if self.unavailable:
            raise StorageError("STORAGE_UNAVAILABLE")
        if key not in self.objects:
            raise StorageError("STORAGE_NOT_FOUND")
        return self.objects[key]

    def put(self, key: str, data: bytes, content_type: str) -> None:
        assert content_type == "application/json"
        self.objects[key] = data


def contract(name: str) -> dict[str, Any]:
    return json.loads((CONTRACTS / name).read_text(encoding="utf-8"))


def test_python_models_accept_the_typescript_canonical_contracts() -> None:
    assert (
        ExtractPayload.model_validate(contract("sanad-extract.json")).mime_type == "application/pdf"
    )
    extracted = IngestExtracted.model_validate(contract("sanad-ingest-extracted.json"))
    failed = IngestFailed.model_validate(contract("sanad-ingest-failed.json"))
    # And what Python publishes serialises to exactly the canonical shape.
    assert extracted.model_dump(by_alias=True) == contract("sanad-ingest-extracted.json")
    assert failed.model_dump(by_alias=True) == contract("sanad-ingest-failed.json")
    assert (
        manifest_key(ExtractPayload.model_validate(contract("sanad-extract.json")))
        == contract("sanad-ingest-extracted.json")["manifestKey"]
    )


def job_for(content: bytes, mime: str, **overrides: Any) -> dict[str, Any]:
    base = contract("sanad-extract.json")
    base.update(mimeType=mime, sha256=hashlib.sha256(content).hexdigest(), **overrides)
    return base


async def run(
    storage: MemoryStorage, job: dict[str, Any]
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    published: list[dict[str, Any]] = []

    async def publish(data: dict[str, Any]) -> None:
        published.append(data)

    result = await make_extract_handler(storage, publish)(job)
    return result, published


async def test_text_file_is_extracted_and_handed_to_ingestion() -> None:
    content = "تعتمد الدراسة على تحليل المصادر الأصلية".encode()
    job = job_for(content, "text/plain")
    storage = MemoryStorage({job["storageKey"]: content})

    result, published = await run(storage, job)

    assert result["outcome"] == "extracted"
    assert result["chunkCount"] == 1
    assert published == [
        {
            "userId": job["userId"],
            "workspaceId": job["workspaceId"],
            "projectId": job["projectId"],
            "fileId": job["fileId"],
            "outcome": "extracted",
            "manifestKey": manifest_key(ExtractPayload.model_validate(job)),
        }
    ]
    manifest = json.loads(storage.objects[published[0]["manifestKey"]])
    assert manifest["units"][0]["content"] == content.decode()
    assert manifest["fileSha256"] == job["sha256"]


@pytest.mark.skipif(not ocr_available(), reason="Tesseract with ara+eng is not installed")
async def test_scanned_image_goes_through_ocr() -> None:
    content = (OCR_FIXTURES / "arabic-page.png").read_bytes()
    job = job_for(content, "image/png")
    storage = MemoryStorage({job["storageKey"]: content})
    result, published = await run(storage, job)
    assert result["outcome"] == "extracted"
    manifest = json.loads(storage.objects[published[0]["manifestKey"]])
    assert manifest["units"][0]["method"] == "ocr"
    assert "المصادر الأصلية" in manifest["units"][0]["content"]


async def test_changed_bytes_are_refused_as_an_integrity_mismatch() -> None:
    job = job_for(b"original", "text/plain")
    storage = MemoryStorage({job["storageKey"]: b"tampered"})
    result, published = await run(storage, job)
    assert result == {"outcome": "failed", "code": "FILE_INTEGRITY_MISMATCH"}
    assert published[0]["outcome"] == "failed"
    assert published[0]["code"] == "FILE_INTEGRITY_MISMATCH"


async def test_unreadable_document_reports_the_extractor_code() -> None:
    content = b"%PDF-1.7 broken"
    job = job_for(content, "application/pdf")
    result, published = await run(MemoryStorage({job["storageKey"]: content}), job)
    assert result == {"outcome": "failed", "code": "INVALID_DOCUMENT"}
    assert published[0]["code"] == "INVALID_DOCUMENT"


async def test_missing_object_is_a_failure_but_unavailable_storage_is_retried() -> None:
    job = job_for(b"x", "text/plain")
    result, _ = await run(MemoryStorage(), job)
    assert result == {"outcome": "failed", "code": "STORAGE_NOT_FOUND"}

    storage = MemoryStorage({job["storageKey"]: b"x"})
    storage.unavailable = True
    with pytest.raises(StorageError):
        await run(storage, job)


async def test_a_key_outside_the_workspace_is_never_read() -> None:
    job = job_for(b"x", "text/plain", storageKey="workspaces/other/files/secret")
    storage = MemoryStorage({"workspaces/other/files/secret": b"x"})
    result, _ = await run(storage, job)
    assert result == {"outcome": "failed", "code": "STORAGE_KEY_OUTSIDE_WORKSPACE"}


async def test_payload_with_extra_fields_is_rejected() -> None:
    job = job_for(b"x", "text/plain", title="عنوان")
    with pytest.raises(ValueError):
        await run(MemoryStorage(), job)
