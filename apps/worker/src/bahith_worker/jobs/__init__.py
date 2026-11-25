"""Job handlers, keyed by BullMQ job name."""

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from bahith_worker.jobs.ping import PING_JOB, handle_ping

JobHandler = Callable[[Mapping[str, Any]], Awaitable[dict[str, Any]]]

# Handlers that need storage or queues (sanad.extract) are registered at start-up by
# __main__ once their configuration has been validated.
HANDLERS: dict[str, JobHandler] = {
    PING_JOB: handle_ping,
}


def register_handler(name: str, handler: JobHandler) -> None:
    HANDLERS[name] = handler
