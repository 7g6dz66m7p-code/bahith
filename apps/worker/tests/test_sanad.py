"""SANAD Retrieve operates on real document bytes and keeps auditable text locations.

All document text below is explicitly synthetic test-fixture content, never a
scientific finding or a source presented to a researcher.
"""

import hashlib
import json
import logging
import runpy
import sys
from io import BytesIO
from itertools import pairwise
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from docx import Document
from pypdf import PdfWriter
from pypdf._page import PageObject
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from bahith_worker.sanad import ExtractionUnit, SanadError, chunk_units, extract_document

PDF = "application/pdf"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
TEXT = "text/plain"


def pdf_bytes(pages: list[str | None], *, encrypted: bool = False) -> bytes:
    """Write actual PDF pages with plain Helvetica text; None creates a blank page."""
    writer = PdfWriter()
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    for text in pages:
        page = writer.add_blank_page(width=300, height=300)
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})}
        )
        if text is not None:
            stream = DecodedStreamObject()
            escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            stream.set_data(f"BT /F1 12 Tf 20 20 Td ({escaped}) Tj ET".encode("ascii"))
            page[NameObject("/Contents")] = writer._add_object(stream)
    if encrypted:
        writer.encrypt("synthetic-fixture-password")
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def docx_bytes() -> bytes:
    document = Document()
    document.add_paragraph("فقرة اختبار عربية")
    table = document.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "خلية اختبار"
    table.cell(0, 1).text = "English fixture cell"
    document.add_paragraph("English fixture paragraph")
    output = BytesIO()
    document.save(output)
    return output.getvalue()


def run_cli(monkeypatch: pytest.MonkeyPatch, arguments: list[str]) -> int:
    monkeypatch.setattr(sys, "argv", ["bahith_worker.sanad", *arguments])
    try:
        runpy.run_module("bahith_worker.sanad", run_name="__main__")
    except SystemExit as error:
        assert error.code is None or isinstance(error.code, int)
        return error.code or 0
    return 0


def test_text_manifest_preserves_unicode_bytes_hash_and_character_offsets() -> None:
    text = "🧪 البحثُ العلمي\nEnglish fixture text\r\nلا تغيير للنص"
    data = text.encode("utf-8")
    result = extract_document(data, TEXT)
    encoded = result.model_dump(by_alias=True)

    assert encoded["schemaVersion"] == 1
    assert encoded["fileSha256"] == hashlib.sha256(data).hexdigest()
    assert encoded["mimeType"] == TEXT
    assert encoded["extractorVersion"]
    assert encoded["chunkerVersion"]
    assert "schema_version" not in encoded
    assert result.failures == []
    assert len(result.units) == 1
    assert result.units[0].content == text
    assert result.units[0].page is None
    assert result.units[0].direction == "rtl"
    assert result.chunks[0].content == text
    assert result.chunks[0].char_start == 0
    assert result.chunks[0].char_end == len(text)
    assert result.chunks[0].page_start is None
    assert result.chunks[0].page_end is None


def test_pdf_maps_chunks_to_actual_pages_and_leaves_blank_page_empty() -> None:
    result = extract_document(pdf_bytes(["Page one fixture", None, "Page three fixture"]), PDF)

    assert [unit.page for unit in result.units] == [1, 2, 3]
    assert [unit.kind for unit in result.units] == ["page", "page", "page"]
    assert result.units[0].content == "Page one fixture"
    assert result.units[1].content == ""
    assert result.units[2].content == "Page three fixture"
    assert [chunk.page_start for chunk in result.chunks] == [1, 3]
    assert [chunk.page_end for chunk in result.chunks] == [1, 3]
    assert all("Page one fixture" not in chunk.content for chunk in result.chunks[1:])


def test_pdf_page_failure_is_recorded_without_invented_text(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    original = PageObject.extract_text

    def fail_second_page(page: PageObject, *args: object, **kwargs: object) -> str:
        text = original(page, *args, **kwargs)
        if text == "Failing fixture page":
            raise ValueError("private page text must never escape")
        return text

    monkeypatch.setattr(PageObject, "extract_text", fail_second_page)
    caplog.set_level(logging.DEBUG)
    result = extract_document(
        pdf_bytes(["First fixture page", "Failing fixture page", "Third fixture page"]), PDF
    )

    assert len(result.failures) == 1
    failure = result.failures[0]
    assert failure.unit_index == 1
    assert failure.page == 2
    assert failure.code
    assert all(chunk.unit_index != 1 for chunk in result.chunks)
    assert all(chunk.page_start in (1, 3) for chunk in result.chunks)
    assert "private page text" not in caplog.text
    assert "Failing fixture page" not in caplog.text


def test_docx_keeps_body_table_order_and_never_invents_page_numbers() -> None:
    result = extract_document(docx_bytes(), DOCX)
    nonempty = [unit for unit in result.units if unit.content.strip()]

    assert [unit.content for unit in nonempty] == [
        "فقرة اختبار عربية",
        "خلية اختبار",
        "English fixture cell",
        "English fixture paragraph",
    ]
    assert [unit.kind for unit in nonempty] == [
        "paragraph",
        "table_cell",
        "table_cell",
        "paragraph",
    ]
    assert [unit.direction for unit in nonempty] == ["rtl", "rtl", "ltr", "ltr"]
    assert all(unit.page is None for unit in result.units)
    assert all(chunk.page_start is None and chunk.page_end is None for chunk in result.chunks)
    assert result.failures == []


@pytest.mark.parametrize(
    ("data", "mime_type", "code"),
    [
        (b"synthetic", "image/png", "UNSUPPORTED_MIME_TYPE"),
        (b"%PDF-1.7 broken fixture private research", PDF, "INVALID_DOCUMENT"),
        (b"not a zip private research", DOCX, "INVALID_DOCUMENT"),
        (b"\xff\xfe invalid private research", TEXT, "INVALID_TEXT_ENCODING"),
        (b"", PDF, "INVALID_DOCUMENT"),
        (pdf_bytes(["Encrypted fixture"], encrypted=True), PDF, "ENCRYPTED_DOCUMENT"),
    ],
)
def test_invalid_document_errors_are_stable_and_privacy_safe(
    data: bytes, mime_type: str, code: str, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    with pytest.raises(SanadError) as captured:
        extract_document(data, mime_type)
    assert captured.value.code == code
    assert "private research" not in str(captured.value)
    assert "private research" not in caplog.text


def test_file_larger_than_50_mib_is_rejected_before_parsing() -> None:
    with pytest.raises(SanadError) as captured:
        extract_document(b"x" * (50 * 1024 * 1024 + 1), TEXT)
    assert captured.value.code == "FILE_TOO_LARGE"


def test_docx_zip_bomb_is_rejected_before_xml_parsing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("bahith_worker.sanad.extraction.MAX_DOCX_UNCOMPRESSED_BYTES", 1024)
    output = BytesIO()
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", b"x" * 2048)
    with pytest.raises(SanadError) as captured:
        extract_document(output.getvalue(), DOCX)
    assert captured.value.code == "RESOURCE_LIMIT"


def test_chunk_overlap_keeps_exact_unicode_slices_and_every_token() -> None:
    text = "🧪 " + " ".join(f"fixture{index}" for index in range(1300))
    unit = ExtractionUnit(index=0, page=None, kind="text", content=text, direction="ltr")
    chunks = chunk_units([unit])

    assert len(chunks) >= 3
    assert chunks[0].char_start == 0
    assert chunks[-1].char_end == len(text)
    covered = set()
    for index, chunk in enumerate(chunks):
        assert chunk.index == index
        assert chunk.unit_index == unit.index
        assert chunk.content == text[chunk.char_start : chunk.char_end]
        assert 0 < chunk.token_count <= 800
        assert chunk.page_start is None and chunk.page_end is None
        covered.update(range(chunk.char_start, chunk.char_end))
    assert covered == set(range(len(text)))
    for previous, current in pairwise(chunks):
        assert previous.char_start < current.char_start < previous.char_end
        assert current.char_end > previous.char_end
        overlap_text = text[current.char_start : previous.char_end]
        assert 0.10 <= len(overlap_text) / len(previous.content) <= 0.20


def test_chunking_never_crosses_unit_boundaries_and_ignores_whitespace_units() -> None:
    units = [
        ExtractionUnit(index=0, page=1, kind="page", content="First fixture", direction="ltr"),
        ExtractionUnit(index=1, page=2, kind="page", content=" \n\t", direction="auto"),
        ExtractionUnit(index=2, page=3, kind="page", content="آخر اختبار", direction="rtl"),
    ]
    chunks = chunk_units(units)
    assert [chunk.unit_index for chunk in chunks] == [0, 2]
    assert [chunk.content for chunk in chunks] == ["First fixture", "آخر اختبار"]
    assert [chunk.page_start for chunk in chunks] == [1, 3]
    assert [chunk.page_end for chunk in chunks] == [1, 3]
    assert [chunk.direction for chunk in chunks] == ["ltr", "rtl"]


def test_empty_text_has_no_chunks_and_is_not_fabricated() -> None:
    result = extract_document(b" \n\t", TEXT)
    assert result.units[0].content == " \n\t"
    assert result.chunks == []


def test_cli_writes_explicit_manifest_and_prints_no_research_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    input_path = tmp_path / "input.txt"
    output_path = tmp_path / "manifest.json"
    text = "نص اختبار سري explicit fixture"
    input_path.write_bytes(text.encode())

    assert (
        run_cli(
            monkeypatch,
            [str(input_path), "--mime-type", TEXT, "--output", str(output_path)],
        )
        == 0
    )
    manifest = json.loads(output_path.read_text())
    assert manifest["units"][0]["content"] == text
    assert manifest["chunks"][0]["content"] == text
    assert manifest["schemaVersion"] == 1
    captured = capsys.readouterr()
    assert text not in captured.out + captured.err
    assert "Traceback" not in captured.out + captured.err


def test_cli_corrupt_document_errors_never_echo_path_or_document_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    input_path = tmp_path / "private-research-name.pdf"
    output_path = tmp_path / "manifest.json"
    input_path.write_bytes(b"%PDF-1.7 private-fixture-content")

    assert (
        run_cli(
            monkeypatch,
            [str(input_path), "--mime-type", PDF, "--output", str(output_path)],
        )
        != 0
    )
    captured = capsys.readouterr()
    assert "INVALID_DOCUMENT" in captured.out + captured.err
    assert "private-fixture-content" not in captured.out + captured.err
    assert "private-research-name" not in captured.out + captured.err
    assert "Traceback" not in captured.out + captured.err
    assert not output_path.exists()


def test_cli_missing_input_is_reported_as_safe_io_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    assert (
        run_cli(
            monkeypatch,
            [
                str(tmp_path / "missing.txt"),
                "--mime-type",
                TEXT,
                "--output",
                str(tmp_path / "out.json"),
            ],
        )
        != 0
    )
    captured = capsys.readouterr()
    assert "IO_ERROR" in captured.out + captured.err
    assert "Traceback" not in captured.out + captured.err


@pytest.mark.parametrize(
    ("target_tokens", "max_tokens", "overlap"),
    [(0, 800, 0.15), (801, 800, 0.15), (600, 0, 0.15), (600, 800, -0.1), (600, 800, 1)],
)
def test_invalid_chunk_configuration_fails_explicitly(
    target_tokens: int, max_tokens: int, overlap: float
) -> None:
    unit = ExtractionUnit(index=0, page=None, kind="text", content="fixture", direction="ltr")
    with pytest.raises(SanadError) as captured:
        chunk_units([unit], target_tokens=target_tokens, max_tokens=max_tokens, overlap=overlap)
    assert captured.value.code == "INVALID_CHUNK_CONFIG"


def test_document_unit_limit_is_enforced_before_unbounded_extraction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("bahith_worker.sanad.extraction.MAX_UNITS", 2)
    with pytest.raises(SanadError) as captured:
        extract_document(pdf_bytes(["Fixture one", "Fixture two", "Fixture three"]), PDF)
    assert captured.value.code == "RESOURCE_LIMIT"


@pytest.mark.parametrize("text", ["A" * 20_000, "🧪" + " " * 20_000 + "اختبار"])
def test_chunk_size_is_bounded_for_long_words_and_whitespace_gaps(text: str) -> None:
    unit = ExtractionUnit(index=0, page=None, kind="text", content=text, direction="ltr")
    chunks = chunk_units([unit])
    covered_nonspace = set()
    for chunk in chunks:
        assert 0 < len(chunk.content) <= 800 * 12
        assert 0 < chunk.token_count <= 800
        assert chunk.content == text[chunk.char_start : chunk.char_end]
        covered_nonspace.update(
            index for index in range(chunk.char_start, chunk.char_end) if not text[index].isspace()
        )
    assert covered_nonspace == {index for index, char in enumerate(text) if not char.isspace()}


def test_chunk_count_resource_limit_is_explicit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("bahith_worker.sanad.chunking.MAX_CHUNKS", 2)
    unit = ExtractionUnit(
        index=0, page=None, kind="text", content="fixture " * 1600, direction="ltr"
    )
    with pytest.raises(SanadError) as captured:
        chunk_units([unit])
    assert captured.value.code == "RESOURCE_LIMIT"


def test_cli_never_overwrites_an_existing_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    input_path = tmp_path / "input.txt"
    output_path = tmp_path / "manifest.json"
    input_path.write_text("fixture input")
    existing = b"private existing manifest fixture"
    output_path.write_bytes(existing)

    assert (
        run_cli(
            monkeypatch,
            [str(input_path), "--mime-type", TEXT, "--output", str(output_path)],
        )
        != 0
    )
    assert output_path.read_bytes() == existing
    captured = capsys.readouterr()
    assert "IO_ERROR" in captured.out + captured.err
    assert "fixture input" not in captured.out + captured.err
    assert "private existing" not in captured.out + captured.err


def test_cli_rejects_same_input_and_output_without_changing_document(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    input_path = tmp_path / "input.txt"
    content = b"original fixture input"
    input_path.write_bytes(content)

    assert (
        run_cli(
            monkeypatch,
            [str(input_path), "--mime-type", TEXT, "--output", str(input_path)],
        )
        != 0
    )
    assert input_path.read_bytes() == content
    captured = capsys.readouterr()
    assert "INVALID_OUTPUT_PATH" in captured.out + captured.err
    assert "original fixture input" not in captured.out + captured.err


def test_per_unit_token_resource_bound(monkeypatch: pytest.MonkeyPatch) -> None:
    from bahith_worker.sanad import chunking

    monkeypatch.setattr(chunking, "MAX_TOKENS_PER_UNIT", 2)
    unit = ExtractionUnit(index=0, page=None, kind="text", content="one two three", direction="ltr")
    with pytest.raises(SanadError) as error:
        chunk_units([unit])
    assert error.value.code == "RESOURCE_LIMIT"
