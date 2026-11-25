"""`system.ping`: proves that a job produced by the web app reaches the worker."""

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

PING_JOB = "system.ping"


class PingPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    nonce: str = Field(min_length=1, max_length=64)


async def handle_ping(data: Mapping[str, Any]) -> dict[str, Any]:
    payload = PingPayload.model_validate(data)
    return {"pong": payload.nonce}
