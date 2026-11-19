"""Optical character recognition for image-only pages (Tesseract, local only).

OCR runs on this machine: page images never leave the worker. Recognised text is kept
exactly as Tesseract returns it and is always labelled ``method="ocr"`` with Tesseract's
mean word confidence, so downstream evidence can require human review. When OCR is not
available or recognises nothing, the page stays empty and carries a failure code; no
text is ever inferred or completed.
"""

import io
import re
import shutil
from dataclasses import dataclass

import pytesseract
from PIL import Image

from bahith_worker.sanad.models import SanadError

# Arabic first, then English. Requires the `ara` and `eng` traineddata packages.
OCR_LANGUAGES = "ara+eng"
OCR_DPI = 300
OCR_TIMEOUT_SECONDS = 120
# Upper bound on rendered pixels (≈ A3 at 300 dpi) to bound memory per page.
MAX_OCR_PIXELS = 50_000_000
# Decompression-bomb guard for uploaded images.
Image.MAX_IMAGE_PIXELS = MAX_OCR_PIXELS


@dataclass(frozen=True)
class OcrResult:
    text: str
    confidence: float | None


def tesseract_version() -> str | None:
    if shutil.which("tesseract") is None:
        return None
    try:
        return str(pytesseract.get_tesseract_version())
    except (pytesseract.TesseractNotFoundError, OSError):
        return None


def ocr_available() -> bool:
    version = tesseract_version()
    if version is None:
        return False
    try:
        languages = set(pytesseract.get_languages(config=""))
    except (pytesseract.TesseractError, OSError):
        return False
    return {"ara", "eng"} <= languages


ARABIC_LETTER = re.compile(r"[\u0621-\u064A\u0671-\u06D3\u06FA-\u06FF]")
LATIN_LETTER = re.compile(r"[A-Za-z]")


def recognise(image: Image.Image) -> OcrResult:
    """Recognises one page.

    A first pass uses Arabic and English together. When Arabic script clearly dominates,
    a second Arabic-only pass is run (mixed models tend to inject Latin look-alikes into
    Arabic lines) and the result with the higher mean confidence is kept.
    """
    if image.width * image.height > MAX_OCR_PIXELS:
        raise SanadError("OCR_PAGE_TOO_LARGE")
    first = _recognise(image, OCR_LANGUAGES)
    arabic = len(ARABIC_LETTER.findall(first.text))
    latin = len(LATIN_LETTER.findall(first.text))
    if arabic > 0 and arabic >= 2 * latin:
        second = _recognise(image, "ara")
        if (second.confidence or 0) > (first.confidence or 0):
            return second
    return first


def _recognise(image: Image.Image, languages: str) -> OcrResult:
    try:
        data = pytesseract.image_to_data(
            image,
            lang=languages,
            config="--psm 3",
            output_type=pytesseract.Output.DICT,
            timeout=OCR_TIMEOUT_SECONDS,
        )
    except RuntimeError:
        # pytesseract raises RuntimeError on timeout.
        raise SanadError("OCR_TIMEOUT") from None
    except (pytesseract.TesseractError, OSError):
        raise SanadError("OCR_FAILED") from None

    lines: dict[tuple[int, int, int], list[str]] = {}
    confidences: list[float] = []
    for index, word in enumerate(data["text"]):
        word = word.strip()
        if not word:
            continue
        key = (data["block_num"][index], data["par_num"][index], data["line_num"][index])
        lines.setdefault(key, []).append(word)
        confidence = float(data["conf"][index])
        if confidence >= 0:
            confidences.append(confidence)
    # Tesseract emits words in logical (reading) order, also for Arabic.
    text = "\n".join(" ".join(words) for _, words in sorted(lines.items()))
    mean = round(sum(confidences) / len(confidences), 2) if confidences else None
    return OcrResult(text=text, confidence=mean)


def recognise_image_bytes(data: bytes) -> list[Image.Image]:
    """Decodes an uploaded PNG/JPEG/TIFF into pages (multi-page TIFF yields several)."""
    try:
        image = Image.open(io.BytesIO(data))
        pages: list[Image.Image] = []
        for frame in range(getattr(image, "n_frames", 1)):
            image.seek(frame)
            pages.append(image.convert("RGB"))
            if len(pages) > 500:
                raise SanadError("RESOURCE_LIMIT")
        return pages
    except SanadError:
        raise
    except (Image.DecompressionBombError, OSError, ValueError):
        raise SanadError("INVALID_DOCUMENT") from None
