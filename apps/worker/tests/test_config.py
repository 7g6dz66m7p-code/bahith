import pytest

from bahith_worker.config import ConfigError, Settings, load_settings


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch) -> None:
    # Keep the developer's real .env and environment out of these tests.
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    for name in ("REDIS_URL", "WORKER_QUEUE", "WORKER_CONCURRENCY"):
        monkeypatch.delenv(name, raising=False)


def test_reads_settings_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379")
    settings = load_settings()
    assert str(settings.redis_url).startswith("redis://localhost:6379")
    assert settings.worker_queue == "bahith-documents"
    assert settings.worker_concurrency == 2


def test_missing_redis_url_fails_naming_the_variable() -> None:
    with pytest.raises(ConfigError, match="REDIS_URL"):
        load_settings()


def test_invalid_values_are_named_but_never_echoed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REDIS_URL", "https://user:hunter2@example.com")
    monkeypatch.setenv("WORKER_CONCURRENCY", "0")
    with pytest.raises(ConfigError) as error:
        load_settings()
    assert "REDIS_URL" in str(error.value)
    assert "WORKER_CONCURRENCY" in str(error.value)
    assert "hunter2" not in str(error.value)


def test_queue_name_must_be_a_valid_bullmq_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379")
    monkeypatch.setenv("WORKER_QUEUE", "bad:name")
    with pytest.raises(ConfigError, match="WORKER_QUEUE"):
        load_settings()
