"""Worker configuration, read from the environment (and the repo-root .env locally)."""

from pathlib import Path

from pydantic import Field, RedisDsn, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

_PARENTS = Path(__file__).resolve().parents
# In the monorepo the repo-root .env is four levels up; in a container image (installed
# outside the repo) there is none and only the process environment is used.
_REPO_ROOT = _PARENTS[4] if len(_PARENTS) > 4 else _PARENTS[-1]


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
    # Queue consumed by the Node jobs process (packages/pipeline: INGEST_QUEUE).
    ingest_queue: str = Field(default="bahith-ingest", pattern=r"^[A-Za-z0-9_.-]+$")

    # Object storage. All optional here so the ping-only worker still starts; the
    # document handler is enabled only when every required value is present.
    s3_endpoint: str | None = None
    s3_region: str | None = None
    s3_bucket: str | None = None
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    s3_force_path_style: bool = False

    @property
    def storage_configured(self) -> bool:
        return all(
            value
            for value in (
                self.s3_region,
                self.s3_bucket,
                self.s3_access_key_id,
                self.s3_secret_access_key,
            )
        )


def load_settings() -> Settings:
    """Loads settings or fails loudly; the error lists variable names only."""
    try:
        return Settings()  # type: ignore[call-arg]  # values come from the environment
    except ValidationError as error:
        names = sorted({".".join(str(part) for part in e["loc"]).upper() for e in error.errors()})
        raise ConfigError(
            f"Missing or invalid environment variables: {', '.join(names)}. "
            'Run "pnpm bootstrap" or see .env.example.'
        ) from None
