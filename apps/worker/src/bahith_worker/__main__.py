"""Entry point: `python -m bahith_worker`."""

import asyncio
import logging
import signal
import sys

from bullmq import Worker

from bahith_worker.config import ConfigError, load_settings
from bahith_worker.processor import process

logger = logging.getLogger("bahith_worker")


async def run() -> None:
    settings = load_settings()
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


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        asyncio.run(run())
    except ConfigError as error:
        sys.stderr.write(f"error: {error}\n")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
