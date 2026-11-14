"""Job handlers, keyed by BullMQ job name."""

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from bahith_worker.jobs.ping import PING_JOB, handle_ping

JobHandler = Callable[[Mapping[str, Any]], Awaitable[dict[str, Any]]]

# Document jobs (extract, chunk, embed) are added in Phase 3.
HANDLERS: dict[str, JobHandler] = {
    PING_JOB: handle_ping,
}
