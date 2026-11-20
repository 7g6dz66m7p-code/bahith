"""Logical-order text from born-digital PDF pages (Arabic, English and mixed lines).

PDF text is a set of positioned glyphs, not a string. Common extractors read glyphs in
content-stream order, which for Arabic produces presentation forms (U+FB50–U+FEFF)
instead of letters, right-to-left runs emitted left to right, and reversed numbers —
"١٢٪" came out as "٢١". That would turn evidence into misquotation.

This module rebuilds reading order from geometry instead:

1. glyphs are read with their baseline origin and box (pdfium);
2. glyphs are grouped into lines by baseline (tolerance relative to the font size);
3. each line's direction is decided by its strong characters (Arabic vs Latin);
4. glyphs are ordered by x in that direction; combining marks (tashkeel) are attached
   to the base glyph under them;
5. within a right-to-left line, embedded left-to-right runs (Latin words, digits) are
   restored to left-to-right order, and the reverse for Arabic inside a Latin line;
6. presentation forms are mapped back to letters with NFKC, applied per glyph only;
7. characters that share one glyph box (a ligature written as several characters) are
   kept together; Arabic lam-alef, the one mandatory Arabic ligature, is put back in
   logical order (lam first) because some producers list its parts visually;
8. in a right-to-left line, paired brackets are swapped back: fonts draw "(" mirrored
   there, so the glyph's code is ")" (bidi mirroring, Unicode UAX #9 rule L4).

Known limitation: fully vocalised text (e.g. Qur'anic verses with complete tashkeel)
can still come out with a misplaced mark or an extra space inside a word, because
stacked marks shift glyph boxes. Such passages need human review before citation.

Nothing is added beyond the glyphs on the page except line breaks and word spaces.
A word space is placed where neighbouring glyphs are separated by a gap wider than
WORD_GAP of the font size, or by a narrower gap that contains one of the page's own
space glyphs. Stream order and zero-width space boxes are not trusted for this: some
producers write Arabic words glyph by glyph in visual order, and put zero-width space
boxes at the start of the next word. (Measured on Chromium PDFs: word gaps are about
0.45 of the font size; gaps inside a word, after non-joining letters, at most 0.2.)
"""

import ctypes
import unicodedata
from dataclasses import dataclass, field

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_raw

LOGICAL_ORDER_VERSION = "logical-order-v1"
# Fraction of the font size within which two baselines belong to the same line.
BASELINE_TOLERANCE = 0.45
# Gap (fraction of the font size) that always separates two words.
WORD_GAP = 0.3
# Smaller gap that separates words only when a real space glyph lies inside it.
SPACED_GAP = 0.1


@dataclass
class _Glyph:
    index: int
    text: str
    x0: float
    x1: float
    origin_y: float
    size: float

    @property
    def centre(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def is_mark(self) -> bool:
        return bool(self.text) and all(unicodedata.category(c) == "Mn" for c in self.text)


@dataclass
class _Line:
    glyphs: list[_Glyph] = field(default_factory=list)
    baseline_sum: float = 0.0

    @property
    def baseline(self) -> float:
        return self.baseline_sum / len(self.glyphs)

    @property
    def size(self) -> float:
        return max(glyph.size for glyph in self.glyphs)

    def add(self, glyph: _Glyph) -> None:
        self.glyphs.append(glyph)
        self.baseline_sum += glyph.origin_y


_MIRRORED = str.maketrans("()[]{}<>«»", ")(][}{><»«")


def _strong(text: str) -> str | None:
    for char in text:
        kind = unicodedata.bidirectional(char)
        if kind in ("R", "AL"):
            return "R"
        if kind == "L":
            return "L"
    return None


def _is_ltr_token(text: str) -> bool:
    """Latin words and numbers (European or Arabic-Indic), with their inner punctuation."""
    if text.isspace() or not text:
        return False
    kinds = {unicodedata.bidirectional(char) for char in text}
    return bool(kinds & {"L", "EN", "AN"}) and kinds <= {"L", "EN", "AN", "ES", "ET", "CS", "NSM"}


def _is_rtl_token(text: str) -> bool:
    return not text.isspace() and _strong(text) == "R"


def _reverse_runs(tokens: list[str], in_run: "callable[[str], bool]") -> list[str]:
    """Reverses maximal runs of tokens matching `in_run` (spaces inside a run included)."""
    result: list[str] = []
    index = 0
    while index < len(tokens):
        if not in_run(tokens[index]):
            result.append(tokens[index])
            index += 1
            continue
        end = index
        while end < len(tokens) and (
            in_run(tokens[end])
            or (tokens[end].isspace() and end + 1 < len(tokens) and in_run(tokens[end + 1]))
        ):
            end += 1
        result.extend(reversed(tokens[index:end]))
        index = end
    return result


def _glyphs(page: pdfium.PdfPage) -> tuple[list[_Glyph], list[_Glyph]]:
    """Visible glyphs, and the page's own space glyphs that have a real width."""
    text_page = page.get_textpage()
    x = ctypes.c_double()
    y = ctypes.c_double()
    glyphs: list[_Glyph] = []
    spaces: list[_Glyph] = []
    try:
        for index in range(text_page.count_chars()):
            if pdfium_raw.FPDFText_IsGenerated(text_page, index):
                continue  # pdfium's synthesised spaces/newlines: not on the page
            code = pdfium_raw.FPDFText_GetUnicode(text_page, index)
            if code in (0, 0xFFFE, 0xFFFF):
                continue
            char = chr(code)
            pdfium_raw.FPDFText_GetCharOrigin(text_page, index, ctypes.byref(x), ctypes.byref(y))
            left, _bottom, right, _top = text_page.get_charbox(index)
            size = pdfium_raw.FPDFText_GetFontSize(text_page, index) or 10.0
            if char.isspace():
                if right - left > 0.5:
                    spaces.append(_Glyph(index, " ", left, right, y.value, size))
                continue
            # NFKC per glyph maps presentation forms (and ligatures such as لا) to letters.
            glyphs.append(
                _Glyph(index, unicodedata.normalize("NFKC", char), left, right, y.value, size)
            )
    finally:
        text_page.close()
    return glyphs, spaces


_ALEFS = frozenset("اأإآٱ")


def _merge_ligatures(glyphs: list[_Glyph]) -> list[_Glyph]:
    """Joins consecutive characters drawn as one glyph (identical box and baseline)."""
    merged: list[_Glyph] = []
    for glyph in glyphs:
        previous = merged[-1] if merged else None
        if (
            previous is not None
            and not glyph.is_mark
            and not previous.is_mark
            and abs(previous.x0 - glyph.x0) < 0.01
            and abs(previous.x1 - glyph.x1) < 0.01
            and abs(previous.origin_y - glyph.origin_y) < 0.01
        ):
            text = previous.text + glyph.text
            if len(text) == 2 and text[1] == "ل" and text[0] in _ALEFS:
                text = text[::-1]  # lam-alef listed visually: restore lam first
            merged[-1] = _Glyph(
                previous.index, text, previous.x0, previous.x1, previous.origin_y, previous.size
            )
        else:
            merged.append(glyph)
    return merged


def _lines(glyphs: list[_Glyph]) -> list[_Line]:
    lines: list[_Line] = []
    for glyph in sorted(glyphs, key=lambda g: -g.origin_y):
        for line in lines:
            if abs(line.baseline - glyph.origin_y) <= BASELINE_TOLERANCE * max(
                line.size, glyph.size
            ):
                line.add(glyph)
                break
        else:
            line = _Line()
            line.add(glyph)
            lines.append(line)
    return sorted(lines, key=lambda line: -line.baseline)


def _is_word_gap(lo: float, hi: float, size: float, spaces: list[_Glyph]) -> bool:
    gap = hi - lo
    if gap > WORD_GAP * size:
        return True
    return gap > SPACED_GAP * size and any(lo - 0.5 <= space.centre <= hi + 0.5 for space in spaces)


def _line_text(line: _Line, spaces: list[_Glyph]) -> str:
    bases = [glyph for glyph in line.glyphs if not glyph.is_mark]
    marks = [glyph for glyph in line.glyphs if glyph.is_mark]
    if not bases:
        return "".join(mark.text for mark in marks)
    rtl = sum(_strong(glyph.text) == "R" for glyph in bases)
    ltr = sum(_strong(glyph.text) == "L" for glyph in bases)
    right_to_left = rtl > ltr
    bases.sort(key=lambda g: -g.centre if right_to_left else g.centre)

    attached: dict[int, list[str]] = {id(base): [] for base in bases}
    letters = bases
    for mark in sorted(marks, key=lambda g: g.centre):
        centre = mark.centre

        def distance(base: _Glyph, centre: float = centre) -> float:
            if base.x0 - 0.5 <= centre <= base.x1 + 0.5:
                return 0.0
            return min(abs(base.x0 - centre), abs(base.x1 - centre))

        attached[id(min(letters, key=distance))].append(mark.text)

    line_spaces = [
        space
        for space in spaces
        if abs(space.origin_y - line.baseline) <= BASELINE_TOLERANCE * line.size
    ]
    tokens: list[str] = []
    for position, base in enumerate(bases):
        if position > 0:
            previous = bases[position - 1]
            lo, hi = (base.x1, previous.x0) if right_to_left else (previous.x1, base.x0)
            if _is_word_gap(lo, hi, min(base.size, previous.size), line_spaces):
                tokens.append(" ")
        tokens.append(base.text + "".join(attached[id(base)]))

    # Merge adjacent glyphs of the same kind into words before reversing runs, so a
    # Latin word or a number keeps its inner order.
    words: list[str] = []
    for token in tokens:
        if (
            words
            and not token.isspace()
            and not words[-1].isspace()
            and (_is_ltr_token(token) and _is_ltr_token(words[-1]))
        ):
            words[-1] = words[-1] + token if not right_to_left else token + words[-1]
        else:
            words.append(token)
    if right_to_left:
        words = [word if _is_ltr_token(word) else word.translate(_MIRRORED) for word in words]
        words = _reverse_runs(words, _is_ltr_token)
    else:
        words = _reverse_runs(words, _is_rtl_token)
    return "".join(words)


def page_text(page: pdfium.PdfPage) -> str:
    """The page's text in logical reading order, one line per output line."""
    glyphs, spaces = _glyphs(page)
    glyphs = _merge_ligatures(glyphs)
    texts = (_line_text(line, spaces) for line in _lines(glyphs))
    return "\n".join(text for text in texts if text)
