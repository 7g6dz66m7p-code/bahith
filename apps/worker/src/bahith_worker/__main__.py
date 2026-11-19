"""Entry point: `python -m bahith_worker`."""

import asyncio
import logging
import signal
import sys
from typing import Any

from bullmq import Queue, Worker

from bahith_worker.config import ConfigError, Settings, load_settings
from bahith_worker.jobs import register_handler
from bahith_worker.jobs.extract import EXTRACT_JOB, INGEST_JOB, make_extract_handler
from bahith_worker.processor import process
from bahith_worker.storage import S3Storage

logger = logging.getLogger("bahith_worker")


def _enable_document_jobs(settings: Settings) -> Queue | None:
    if not settings.storage_configured:
        logger.warning("object storage not configured: document extraction is disabled")
        return None
    storage = S3Storage(
        bucket=settings.s3_bucket or "",
        region=settings.s3_region or "",
        access_key_id=settings.s3_access_key_id or "",
        secret_access_key=settings.s3_secret_access_key or "",
        endpoint=settings.s3_endpoint or None,
        force_path_style=settings.s3_force_path_style,
    )
    ingest = Queue(settings.ingest_queue, {"connection": str(settings.redis_url)})

    async def publish(data: dict[str, Any]) -> None:
        await ingest.add(
            INGEST_JOB,
            data,
            {
                "jobId": f"ingest-{data['fileId']}",
                "attempts": 3,
                "backoff": {"type": "exponential", "delay": 5000},
                "removeOnComplete": {"age": 86400, "count": 1000},
                "removeOnFail": {"age": 604800},
            },
        )

    register_handler(EXTRACT_JOB, make_extract_handler(storage, publish))
    return ingest


async def run() -> None:
    settings = load_settings()
    ingest = _enable_document_jobs(settings)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signum, stop.set)

    worker = Worker(
        settings.worker_queue,
        process,
        {"connection": str(settings.redis_url), "concurrency": settings.worker_concurrency},
    )
    logger.info(
        "worker started queue=%s concurrency=%d",
        settings.worker_queue,
        settings.worker_concurrency,
    )
    try:
        await stop.wait()
    finally:
        logger.info("worker stopping")
        await worker.close()
        if ingest is not None:
            await ingest.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        asyncio.run(run())
    except ConfigError as error:
        sys.stderr.write(f"error: {error}\n")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
