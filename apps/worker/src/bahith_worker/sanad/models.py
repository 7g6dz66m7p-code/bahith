"""Versioned, content-preserving interchange format for SANAD Retrieve."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

Direction = Literal["rtl", "ltr", "auto"]


class SanadError(Exception):
    """Safe error: no document content, filenames or parser messages are exposed."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class ManifestModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class ExtractionUnit(ManifestModel):
    index: int = Field(ge=0)
    page: int | None = Field(default=None, ge=1)
    kind: Literal["page", "paragraph", "table_cell", "text"]
    content: str
    direction: Direction


class ExtractionFailure(ManifestModel):
    unit_index: int = Field(ge=0)
    page: int | None = Field(default=None, ge=1)
    code: str


class ExtractedChunk(ManifestModel):
    index: int = Field(ge=0)
    unit_index: int = Field(ge=0)
    char_start: int = Field(ge=0)
    char_end: int = Field(ge=0)
    content: str
    page_start: int | None = Field(default=None, ge=1)
    page_end: int | None = Field(default=None, ge=1)
    token_count: int = Field(ge=1)
    direction: Direction


class ExtractionManifest(ManifestModel):
    schema_version: Literal[1] = 1
    file_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    mime_type: str
    extractor_version: str
    chunker_version: str
    units: list[ExtractionUnit]
    failures: list[ExtractionFailure]
    chunks: list[ExtractedChunk]
