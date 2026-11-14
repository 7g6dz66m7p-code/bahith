"""Round trip through a real Redis: a queued job is consumed and its result stored."""

import asyncio
from collections.abc import Iterator

import pytest
from bullmq import Job, Queue, Worker
from testcontainers.community.redis import RedisContainer

from bahith_worker.jobs.ping import PING_JOB
from bahith_worker.processor import process

pytestmark = pytest.mark.integration

QUEUE = "bahith-test"


@pytest.fixture(scope="module")
def redis_url() -> Iterator[str]:
    with RedisContainer("redis:7-alpine") as container:
        yield f"redis://{container.get_container_host_ip()}:{container.get_exposed_port(6379)}"


async def _wait_for_state(queue: Queue, job_id: str, state: str) -> Job:
    async with asyncio.timeout(20):
        while True:
            job = await Job.fromId(queue, job_id)
            if job is not None and await job.getState() == state:
                return job
            await asyncio.sleep(0.05)


async def test_a_queued_ping_is_processed(redis_url: str) -> None:
    queue = Queue(QUEUE, {"connection": redis_url})
    worker = Worker(QUEUE, process, {"connection": redis_url})
    try:
        queued = await queue.add(PING_JOB, {"nonce": "n-1"})
        done = await _wait_for_state(queue, queued.id, "completed")
        assert done.returnvalue == {"pong": "n-1"}
    finally:
        await worker.close()
        await queue.close()


async def test_an_unknown_job_is_marked_failed_with_its_code(redis_url: str) -> None:
    queue = Queue(QUEUE, {"connection": redis_url})
    worker = Worker(QUEUE, process, {"connection": redis_url})
    try:
        queued = await queue.add("documents.unknown", {})
        failed = await _wait_for_state(queue, queued.id, "failed")
        assert failed.failedReason.startswith("UNKNOWN_JOB")
    finally:
        await worker.close()
        await queue.close()
