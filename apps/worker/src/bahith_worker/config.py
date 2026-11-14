"""Worker configuration, read from the environment (and the repo-root .env locally)."""

from pathlib import Path

from pydantic import Field, RedisDsn, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

_REPO_ROOT = Path(__file__).resolve().parents[4]


class ConfigError(RuntimeError):
    """Required configuration is missing or invalid. Names variables, never values."""


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    redis_url: RedisDsn
    # Contract with the web app (the producer): one queue, jobs told apart by name.
    worker_queue: str = Field(default="bahith-documents", pattern=r"^[A-Za-z0-9_.-]+$")
    worker_concurrency: int = Field(default=2, ge=1, le=32)


def load_settings() -> Settings:
    """Loads settings or fails loudly; the error lists variable names only."""
    try:
        return Settings()  # type: ignore[call-arg]  # values come from the environment
    except ValidationError as error:
        names = sorted({".".join(str(part) for part in e["loc"]).upper() for e in error.errors()})
        raise ConfigError(
            f"Missing or invalid environment variables: {', '.join(names)}. "
            'Run "pnpm setup" or see .env.example.'
        ) from None
