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
from collections.abc import Iterator
from dataclasses import dataclass
from itertools import pairwise

import pytesseract
from PIL import Image, ImageOps

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
    top: int | None = None


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
    languages = OCR_LANGUAGES
    arabic = len(ARABIC_LETTER.findall(first.text))
    latin = len(LATIN_LETTER.findall(first.text))
    if arabic > 0 and arabic >= 2 * latin:
        second = _recognise(image, "ara")
        if (second.confidence or 0) > (first.confidence or 0):
            first = second
            languages = "ara"
    return _recover_heading(image, first, languages)


def _recover_heading(image: Image.Image, result: OcrResult, languages: str) -> OcrResult:
    """Recover a single ink line ignored above Tesseract's first recognised word.

    Tesseract 5.5 page segmentation can silently discard Arabic headings. A raw-line
    pass over that actual image region retains them. Multiple lines/graphics are not
    treated as a heading; this is bounded to one additional recognition per page.
    """
    if result.top is None or result.top <= 0:
        return result
    with image.crop((0, 0, image.width, result.top)) as top, top.convert("L") as gray:
        with ImageOps.invert(gray) as inverted:
            mask = inverted.point(lambda pixel: 255 if pixel > 127 else 0)
        try:
            bounds = mask.getbbox()
            if bounds is None or bounds[3] - bounds[1] < 8:
                return result
            with mask.resize((1, mask.height), resample=Image.Resampling.BOX) as projection:
                rows = [i for i, value in enumerate(projection.get_flattened_data()) if value > 0]
            if not rows or any(
                following - previous > max(3, (bounds[3] - bounds[1]) // 6)
                for previous, following in pairwise(rows)
            ):
                return result
            with (
                top.crop(bounds) as cropped,
                ImageOps.expand(cropped, border=10, fill="white") as line,
            ):
                try:
                    heading = _recognise(line, languages, psm=13)
                except SanadError:
                    return result
        finally:
            mask.close()
    if not ARABIC_LETTER.search(heading.text) and not LATIN_LETTER.search(heading.text):
        return result
    length = len(heading.text) + len(result.text)
    confidence = (
        round(
            (
                (heading.confidence or 0) * len(heading.text)
                + (result.confidence or 0) * len(result.text)
            )
            / length,
            2,
        )
        if length
        else None
    )
    return OcrResult(text=heading.text + "\n" + result.text, confidence=confidence, top=bounds[1])


def _recognise(image: Image.Image, languages: str, *, psm: int = 3) -> OcrResult:
    try:
        data = pytesseract.image_to_data(
            image,
            lang=languages,
            config=f"--psm {psm}",
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
    tops: list[int] = []
    for index, word in enumerate(data["text"]):
        word = word.strip()
        if not word:
            continue
        key = (data["block_num"][index], data["par_num"][index], data["line_num"][index])
        lines.setdefault(key, []).append(word)
        tops.append(data["top"][index])
        confidence = float(data["conf"][index])
        if confidence >= 0:
            confidences.append(confidence)
    # Tesseract emits words in logical (reading) order, also for Arabic.
    text = "\n".join(" ".join(words) for _, words in sorted(lines.items()))
    mean = round(sum(confidences) / len(confidences), 2) if confidences else None
    return OcrResult(text=text, confidence=mean, top=min(tops) if tops else None)


def recognise_image_bytes(data: bytes) -> Iterator[Image.Image]:
    """Decode one page at a time so multi-page TIFFs cannot retain all RGB frames."""
    try:
        with Image.open(io.BytesIO(data)) as image:
            frame_count = getattr(image, "n_frames", 1)
            if frame_count > 500:
                raise SanadError("RESOURCE_LIMIT")
            for frame in range(frame_count):
                image.seek(frame)
                if image.width * image.height > MAX_OCR_PIXELS:
                    raise SanadError("OCR_PAGE_TOO_LARGE")
                # The consumer owns this independent frame and must close it.
                yield image.convert("RGB")
    except SanadError:
        raise
    except (Image.DecompressionBombError, OSError, ValueError):
        raise SanadError("INVALID_DOCUMENT") from None
