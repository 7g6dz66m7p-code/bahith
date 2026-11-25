import logging
from dataclasses import dataclass
from typing import Any

import pytest

from bahith_worker.jobs.ping import PING_JOB
from bahith_worker.processor import JobError, process


@dataclass
class FakeJob:
    name: str
    data: Any
    id: str = "job-1"


async def test_ping_returns_the_nonce() -> None:
    assert await process(FakeJob(PING_JOB, {"nonce": "abc"})) == {"pong": "abc"}


async def test_unknown_job_name_fails_with_a_stable_code() -> None:
    with pytest.raises(JobError) as error:
        await process(FakeJob("documents.unknown", {}))
    assert error.value.code == "UNKNOWN_JOB"


@pytest.mark.parametrize(
    "data",
    [{}, {"nonce": ""}, {"nonce": "x" * 65}, {"nonce": "ok", "extra": 1}, {"nonce": 5}],
)
async def test_invalid_payload_is_rejected(data: dict[str, Any]) -> None:
    with pytest.raises(JobError) as error:
        await process(FakeJob(PING_JOB, data))
    assert error.value.code == "INVALID_PAYLOAD"


async def test_payload_that_is_not_an_object_is_rejected() -> None:
    with pytest.raises(JobError) as error:
        await process(FakeJob(PING_JOB, "not an object"))
    assert error.value.code == "INVALID_PAYLOAD"


async def test_job_data_never_reaches_logs_or_error_messages(
    caplog: pytest.LogCaptureFixture,
) -> None:
    research_text = "نص بحثي سري لا يجوز تسجيله"
    caplog.set_level(logging.DEBUG, logger="bahith_worker")

    with pytest.raises(JobError) as error:
        await process(FakeJob(PING_JOB, {"nonce": "ok", "leaked": research_text}))
    await process(FakeJob(PING_JOB, {"nonce": "ok"}))

    assert research_text not in caplog.text
    assert research_text not in str(error.value)
    assert "job completed id=job-1 name=system.ping" in caplog.text
