"""Dispatches a BullMQ job to its handler."""

import logging
from collections.abc import Mapping
from typing import Any, Protocol

from pydantic import ValidationError

from bahith_worker.jobs import HANDLERS

logger = logging.getLogger("bahith_worker")


class JobLike(Protocol):
    """The part of `bullmq.Job` the processor uses."""

    id: Any
    name: str
    data: Any


class JobError(Exception):
    """A job failed for a known reason. `code` is stable and safe to store on the job."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


async def process(job: JobLike, _token: str | None = None) -> dict[str, Any]:
    """Runs one job. Logs carry the job id, name and outcome only — never job data,
    which may contain research content (engineering rule 11)."""
    handler = HANDLERS.get(job.name)
    if handler is None:
        logger.error("job rejected id=%s name=%s code=UNKNOWN_JOB", job.id, job.name)
        raise JobError("UNKNOWN_JOB", "no handler is registered for this job name")
    if not isinstance(job.data, Mapping):
        logger.error("job rejected id=%s name=%s code=INVALID_PAYLOAD", job.id, job.name)
        raise JobError("INVALID_PAYLOAD", "job data must be an object")

    try:
        result = await handler(job.data)
    except ValidationError as error:
        # Only field names and error types: the offending values stay out of logs.
        fields = sorted(
            {".".join(str(part) for part in e["loc"]) or "<root>" for e in error.errors()}
        )
        logger.error("job rejected id=%s name=%s code=INVALID_PAYLOAD", job.id, job.name)
        raise JobError("INVALID_PAYLOAD", f"invalid fields: {', '.join(fields)}") from None

    logger.info("job completed id=%s name=%s", job.id, job.name)
    return result
