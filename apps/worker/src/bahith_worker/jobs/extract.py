"""`sanad.extract`: stored file → verified bytes → extraction manifest → ingestion job.

Contract: packages/pipeline/src/contracts.ts (canonical examples in
packages/pipeline/contracts/*.json are validated by tests on both sides).

The worker never writes to the database. It hands the manifest to the Node jobs
process, which re-authorizes the user and ingests it through the single TypeScript
ingestion boundary. Deterministic problems (bad file, wrong type, integrity mismatch)
are reported as a `failed` outcome with a stable code; transient problems (storage or
Redis unavailable) raise so BullMQ retries the job.
"""

import asyncio
import hashlib
import re
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from bahith_worker.sanad import SanadError, extract_document
from bahith_worker.sanad.extraction import MAX_FILE_BYTES
from bahith_worker.storage import ObjectStorage, StorageError

EXTRACT_JOB = "sanad.extract"
INGEST_JOB = "sanad.ingest"

UUID = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
MimeType = Literal[
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "image/png",
    "image/jpeg",
    "image/tiff",
]


class _Contract(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

    user_id: str = Field(pattern=UUID)
    workspace_id: str = Field(pattern=UUID)
    project_id: str = Field(pattern=UUID)
    file_id: str = Field(pattern=UUID)


class ExtractPayload(_Contract):
    storage_key: str = Field(min_length=1, max_length=512)
    mime_type: MimeType
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class IngestExtracted(_Contract):
    outcome: Literal["extracted"] = "extracted"
    manifest_key: str = Field(min_length=1, max_length=600)


class IngestFailed(_Contract):
    outcome: Literal["failed"] = "failed"
    code: str = Field(pattern=r"^[A-Z][A-Z0-9_]{0,79}$")


Publish = Callable[[dict[str, Any]], Awaitable[None]]


def manifest_key(payload: ExtractPayload) -> str:
    # Same layout as packages/pipeline/src/keys.ts (manifestObjectKey).
    return (
        f"workspaces/{payload.workspace_id}/files/{payload.file_id}/manifests/{payload.sha256}.json"
    )


def _is_workspace_key(payload: ExtractPayload) -> bool:
    prefix = f"workspaces/{payload.workspace_id}/"
    return payload.storage_key.startswith(prefix) and ".." not in payload.storage_key


def make_extract_handler(
    storage: ObjectStorage, publish: Publish
) -> Callable[[Mapping[str, Any]], Awaitable[dict[str, Any]]]:
    async def handle(data: Mapping[str, Any]) -> dict[str, Any]:
        payload = ExtractPayload.model_validate(data)
        context = payload.model_dump(
            by_alias=True, include={"user_id", "workspace_id", "project_id", "file_id"}
        )

        async def fail(code: str) -> dict[str, Any]:
            await publish(IngestFailed(**context, code=code).model_dump(by_alias=True))
            return {"outcome": "failed", "code": code}

        if not _is_workspace_key(payload):
            return await fail("STORAGE_KEY_OUTSIDE_WORKSPACE")
        try:
            content = await asyncio.to_thread(
                storage.get_bytes, payload.storage_key, MAX_FILE_BYTES
            )
        except StorageError as error:
            if error.code in {"STORAGE_NOT_FOUND", "STORAGE_TOO_LARGE"}:
                return await fail(error.code)
            raise  # transient: let BullMQ retry
        if hashlib.sha256(content).hexdigest() != payload.sha256:
            return await fail("FILE_INTEGRITY_MISMATCH")
        try:
            manifest = await asyncio.to_thread(extract_document, content, payload.mime_type)
        except SanadError as error:
            code = error.code if re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", error.code) else "FAILED"
            return await fail(code)

        key = manifest_key(payload)
        body = manifest.model_dump_json(by_alias=True).encode("utf-8")
        await asyncio.to_thread(storage.put, key, body, "application/json")
        await publish(IngestExtracted(**context, manifest_key=key).model_dump(by_alias=True))
        return {
            "outcome": "extracted",
            "unitCount": len(manifest.units),
            "chunkCount": len(manifest.chunks),
            "failureCount": len(manifest.failures),
        }

    return handle
