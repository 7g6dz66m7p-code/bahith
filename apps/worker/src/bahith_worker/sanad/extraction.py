"""Bounded local PDF, DOCX and UTF-8 extraction for SANAD Retrieve.

The original bytes determine the source version. Extracted text is never normalised,
reversed, completed or inferred. Page failures carry stable codes and no invented text.
"""

import hashlib
import io
import logging
import threading
import zipfile
from collections.abc import Iterator
from contextlib import contextmanager
from importlib.metadata import version

from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph
from pypdf import PdfReader, apply_configuration
from pypdf.errors import LimitReachedError

from bahith_worker.sanad.chunking import CHUNKER_VERSION, chunk_units, text_direction
from bahith_worker.sanad.models import (
    ExtractionFailure,
    ExtractionManifest,
    ExtractionUnit,
    SanadError,
)

MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_DOCX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
MAX_DOCX_ENTRY_BYTES = 20 * 1024 * 1024
MAX_DOCX_ENTRIES = 2_000
MAX_UNITS = 20_000
MAX_TEXT_CHARS = 20_000_000
SUPPORTED_MIME_TYPES = frozenset(
    {
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text/plain",
    }
)


class _CurrentThreadFilter(logging.Filter):
    """Keep third-party parser diagnostics from leaking research content."""

    def __init__(self) -> None:
        super().__init__()
        self.thread = threading.get_ident()

    def filter(self, record: logging.LogRecord) -> bool:
        return record.thread != self.thread


@contextmanager
def _quiet_pdf_logs() -> Iterator[None]:
    # Suppress this extraction's diagnostics without disabling another thread's logs.
    log_filter = _CurrentThreadFilter()
    loggers = [
        logging.getLogger(name)
        for name in list(logging.Logger.manager.loggerDict)
        if name == "pypdf" or name.startswith("pypdf.")
    ]
    for logger in loggers:
        logger.addFilter(log_filter)
    try:
        yield
    finally:
        for logger in loggers:
            logger.removeFilter(log_filter)


class _Units:
    def __init__(self) -> None:
        self.values: list[ExtractionUnit] = []
        self.characters = 0

    def append(self, content: str, kind: str, page: int | None = None) -> None:
        if len(self.values) >= MAX_UNITS or self.characters + len(content) > MAX_TEXT_CHARS:
            raise SanadError("RESOURCE_LIMIT")
        self.characters += len(content)
        self.values.append(
            ExtractionUnit.model_validate(
                {
                    "index": len(self.values),
                    "page": page,
                    "kind": kind,
                    "content": content,
                    "direction": text_direction(content),
                }
            )
        )


def _pdf(data: bytes, units: _Units) -> list[ExtractionFailure]:
    if not data.startswith(b"%PDF-"):
        raise SanadError("INVALID_DOCUMENT")
    failures: list[ExtractionFailure] = []
    with (
        _quiet_pdf_logs(),
        apply_configuration(
            maximum_declared_stream_length=MAX_DOCX_ENTRY_BYTES,
            array_based_stream_maximum_output_length=MAX_DOCX_ENTRY_BYTES,
            zlib_maximum_output_length=MAX_DOCX_ENTRY_BYTES,
            lzw_maximum_output_length=MAX_DOCX_ENTRY_BYTES,
            run_length_maximum_output_length=MAX_DOCX_ENTRY_BYTES,
            brotli_maximum_output_length=MAX_DOCX_ENTRY_BYTES,
            page_tree_maximum_entries=MAX_UNITS,
            page_tree_maximum_page_entries=MAX_UNITS,
            stream_decoding_work_maximum_length=MAX_DOCX_UNCOMPRESSED_BYTES,
        ),
    ):
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise SanadError("ENCRYPTED_DOCUMENT")
        if len(reader.pages) > MAX_UNITS:
            raise SanadError("RESOURCE_LIMIT")
        for index in range(len(reader.pages)):
            try:
                text = reader.pages[index].extract_text(extraction_mode="plain") or ""
            except (LimitReachedError, MemoryError):
                raise SanadError("RESOURCE_LIMIT") from None
            except Exception:
                # A failed page retains its position but contains no fabricated text.
                units.append("", "page", index + 1)
                failures.append(
                    ExtractionFailure(
                        unit_index=len(units.values) - 1,
                        page=index + 1,
                        code="PAGE_EXTRACTION_FAILED",
                    )
                )
                continue
            units.append(text, "page", index + 1)
    return failures


def _check_docx_archive(data: bytes) -> None:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if (
            len(entries) > MAX_DOCX_ENTRIES
            or sum(entry.file_size for entry in entries) > MAX_DOCX_UNCOMPRESSED_BYTES
            or any(entry.file_size > MAX_DOCX_ENTRY_BYTES for entry in entries)
        ):
            raise SanadError("RESOURCE_LIMIT")
        if len(names) != len(set(names)) or not {"[Content_Types].xml", "word/document.xml"} <= set(
            names
        ):
            raise SanadError("INVALID_DOCUMENT")
        total = 0
        for entry in entries:
            if entry.flag_bits & 1:
                raise SanadError("ENCRYPTED_DOCUMENT")
            # Read bounded bytes to validate sizes, CRC and XML declarations before
            # python-docx parses the archive. Nothing is extracted onto the filesystem.
            with archive.open(entry) as stream:
                content = stream.read(MAX_DOCX_ENTRY_BYTES + 1)
            total += len(content)
            if len(content) > MAX_DOCX_ENTRY_BYTES or total > MAX_DOCX_UNCOMPRESSED_BYTES:
                raise SanadError("RESOURCE_LIMIT")
            if entry.filename.endswith((".xml", ".rels")):
                upper = content.upper()
                if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper:
                    raise SanadError("INVALID_DOCUMENT")


def _docx(data: bytes, units: _Units) -> None:
    _check_docx_archive(data)
    document = Document(io.BytesIO(data))
    for block in document.iter_inner_content():
        if isinstance(block, Paragraph):
            units.append(block.text, "paragraph")
        elif isinstance(block, Table):
            # Merged cells occur repeatedly in row.cells; emit each physical cell once.
            seen: set[object] = set()
            for row in block.rows:
                for cell in row.cells:
                    identity = cell._tc
                    if identity not in seen:
                        seen.add(identity)
                        units.append(cell.text, "table_cell")


def extract_document(data: bytes, mime_type: str) -> ExtractionManifest:
    """Extract bytes locally, returning explicit provenance and extraction failures.

    No database, network, API credential or queue operation occurs here. Callers must
    supply their authenticated source/project context when persisting this manifest.
    A hash is a file version, not proof that its scientific assertions are correct.
    """
    if mime_type not in SUPPORTED_MIME_TYPES:
        raise SanadError("UNSUPPORTED_MIME_TYPE")
    if len(data) > MAX_FILE_BYTES:
        raise SanadError("FILE_TOO_LARGE")
    if not data:
        raise SanadError("INVALID_DOCUMENT")

    units = _Units()
    failures: list[ExtractionFailure] = []
    try:
        if mime_type == "application/pdf":
            failures = _pdf(data, units)
            extractor = f"sanad-pdf-v1:pypdf-{version('pypdf')}"
        elif mime_type == "text/plain":
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                raise SanadError("INVALID_TEXT_ENCODING") from None
            if "\x00" in text:
                raise SanadError("INVALID_DOCUMENT")
            units.append(text, "text")
            extractor = "sanad-utf8-v1"
        else:
            _docx(data, units)
            extractor = f"sanad-docx-v1:python-docx-{version('python-docx')}"
    except SanadError:
        raise
    except (LimitReachedError, MemoryError):
        raise SanadError("RESOURCE_LIMIT") from None
    except Exception:
        # Parser exception messages can contain private document strings or paths.
        raise SanadError("INVALID_DOCUMENT") from None

    return ExtractionManifest(
        file_sha256=hashlib.sha256(data).hexdigest(),
        mime_type=mime_type,
        extractor_version=extractor,
        chunker_version=CHUNKER_VERSION,
        units=units.values,
        failures=failures,
        chunks=chunk_units(units.values),
    )
