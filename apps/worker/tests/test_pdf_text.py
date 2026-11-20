"""Logical reading order for born-digital PDFs (Arabic, English, mixed).

Regression for a real defect: content-stream extraction returned Arabic presentation
forms, right-to-left runs in left-to-right order and reversed numbers ("١٢٪" → "٢١").
The fixture is a Chromium-made PDF of synthetic sentences (fixtures/pdf/make_fixtures.cjs).
"""

from pathlib import Path

import pypdfium2 as pdfium
import pytest

from bahith_worker.sanad import extract_document
from bahith_worker.sanad.pdf_text import page_text

FIXTURE = Path(__file__).parent / "fixtures" / "pdf" / "arabic-english-mixed.pdf"

EXPECTED = [
    "تعتمد الدراسة على تحليل المصادر الأصلية في البحث العلمي.",
    "أظهرت النتائج أن التعليم عن بعد يرفع التحصيل بنسبة ١٢٪ لدى طلاب المرحلة الثانوية.",
    "نشرت الدراسة في مجلة Nature عام 2015 بعنوان Deep Learning وهي مرجع مهم.",
    "انظر المرجع (الفصل الثالث، ص 45) لمزيد من التفصيل.",
    "The study (Smith, 2020, p. 45) reports that 37% of participants improved.",
    "Mixed: the term الإسناد means chain of transmission in hadith studies.",
]


@pytest.fixture(scope="module")
def lines() -> list[str]:
    document = pdfium.PdfDocument(FIXTURE.read_bytes())
    try:
        return page_text(document[0]).split("\n")
    finally:
        document.close()


def test_every_line_is_recovered_exactly_in_logical_order(lines: list[str]) -> None:
    assert lines == EXPECTED


def test_no_presentation_forms_survive(lines: list[str]) -> None:
    text = "".join(lines)
    assert not any(0xFB50 <= ord(c) <= 0xFDFF or 0xFE70 <= ord(c) <= 0xFEFF for c in text)


def test_numbers_inside_arabic_lines_keep_their_digits_in_order(lines: list[str]) -> None:
    assert "١٢٪" in lines[1]
    assert "٢١" not in lines[1]
    assert "2015" in lines[2]


def test_brackets_in_arabic_lines_are_not_mirrored(lines: list[str]) -> None:
    assert "(الفصل الثالث، ص 45)" in lines[3]


def test_extraction_manifest_uses_the_logical_order_extractor() -> None:
    manifest = extract_document(FIXTURE.read_bytes(), "application/pdf", ocr=False)
    assert manifest.extractor_version.startswith("sanad-pdf-v2:pdfium-")
    assert manifest.extractor_version.endswith("+logical-order-v1")
    assert manifest.units[0].content.split("\n") == EXPECTED
    # Lexical search can now find what a researcher types.
    assert any("تحليل المصادر الأصلية" in chunk.content for chunk in manifest.chunks)


def test_a_second_producer_libreoffice_including_lam_alef_ligatures() -> None:
    document = pdfium.PdfDocument((FIXTURE.parent / "libreoffice-arabic.pdf").read_bytes())
    try:
        lines = page_text(document[0]).split("\n")
    finally:
        document.close()
    assert lines == [
        EXPECTED[0],
        EXPECTED[1],
        EXPECTED[2],
        "The study (Smith, 2020, p. 45) reports that 37% of participants improved.",
    ]
    # "الأصلية" and "طلاب" contain lam-alef ligatures written in visual order.
    assert "الأصلية" in lines[0]
    assert "طلاب" in lines[1]
