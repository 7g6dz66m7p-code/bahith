"""OCR for scanned pages and images: real Tesseract runs on Chromium-rendered fixtures.

The fixture images contain synthetic test sentences (see fixtures/ocr/make_fixtures.cjs).
"""

from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image
from pypdf import PdfWriter

from bahith_worker.sanad import extract_document
from bahith_worker.sanad.ocr import ocr_available

FIXTURES = Path(__file__).parent / "fixtures" / "ocr"
PDF = "application/pdf"

requires_ocr = pytest.mark.skipif(
    not ocr_available(), reason="Tesseract with ara+eng traineddata is not installed"
)


def image_bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def scanned_pdf(*names: str) -> bytes:
    """An image-only PDF (no text layer), like a scanned book or manuscript.

    Saved at 300 dpi, the resolution scans are normally made at and the one OCR renders at.
    """
    images = [Image.open(FIXTURES / name).convert("RGB") for name in names]
    buffer = BytesIO()
    images[0].save(buffer, format="PDF", save_all=True, append_images=images[1:], resolution=300)
    return buffer.getvalue()


@requires_ocr
def test_scanned_pdf_pages_are_recognised_in_arabic_and_english_with_real_pages() -> None:
    manifest = extract_document(scanned_pdf("arabic-page.png", "english-page.png"), PDF)

    assert manifest.failures == []
    assert [unit.page for unit in manifest.units] == [1, 2]
    assert all(unit.method == "ocr" for unit in manifest.units)
    assert all(
        unit.ocr_confidence is not None and unit.ocr_confidence > 50 for unit in manifest.units
    )
    arabic, english = manifest.units
    assert "المنهج العلمي" in arabic.content
    assert "المصادر الأصلية" in arabic.content
    assert arabic.direction == "rtl"
    assert "primary sources" in english.content
    assert english.direction == "ltr"
    assert "+ocr-tesseract-" in manifest.extractor_version
    # Chunks keep the page the text was recognised on.
    assert {chunk.page_start for chunk in manifest.chunks} == {1, 2}


@requires_ocr
def test_png_upload_is_one_ocr_page() -> None:
    manifest = extract_document(image_bytes("arabic-page.png"), "image/png")
    assert len(manifest.units) == 1
    unit = manifest.units[0]
    assert (unit.page, unit.kind, unit.method) == (1, "page", "ocr")
    assert "تحليل المصادر" in unit.content


def test_without_ocr_a_scanned_page_stays_empty_and_is_flagged() -> None:
    manifest = extract_document(scanned_pdf("arabic-page.png"), PDF, ocr=False)
    assert [unit.content for unit in manifest.units] == [""]
    assert [failure.code for failure in manifest.failures] == ["OCR_UNAVAILABLE"]
    assert manifest.chunks == []
    assert "ocr" not in manifest.extractor_version


@requires_ocr
def test_blank_scan_produces_no_text_and_a_failure_code() -> None:
    blank = Image.new("RGB", (1200, 800), "white")
    buffer = BytesIO()
    blank.save(buffer, format="PNG")
    manifest = extract_document(buffer.getvalue(), "image/png")
    assert manifest.units[0].content == ""
    assert manifest.failures[0].code == "OCR_NO_TEXT"
    assert manifest.chunks == []


def test_text_layer_pages_never_go_through_ocr() -> None:
    writer = PdfWriter()
    writer.add_blank_page(width=300, height=300)
    buffer = BytesIO()
    writer.write(buffer)
    # A blank page has no text layer; with OCR disabled it is flagged, never filled.
    manifest = extract_document(buffer.getvalue(), PDF, ocr=False)
    assert manifest.units[0].method == "text"
