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

9. digits joined by one separator ("0.05", "1,250") are one number (UAX #9 rule W4),
   so a decimal in an Arabic line is not read as "05.0";
10. a line that is soft-wrapped (it reaches the text block's far edge and the next
    line follows at the paragraph's line spacing) is joined to the next with a space;
    real paragraph breaks stay line breaks. A quotation that crosses a soft wrap is
    then the same string as in the source.

Known limitation: fully vocalised text (e.g. Qur'anic verses with complete tashkeel)
can still come out with a misplaced mark or an extra space inside a word, because
stacked marks shift glyph boxes and some producers split such words into separate
runs. Such passages need human review before citation.

Nothing is added beyond the glyphs on the page except line breaks and word spaces.
Word spaces come from the page itself: a space glyph with a real width inside the
gap, or a space character written in the content stream between the two glyphs
(Chromium writes some of these with a zero-width box at the next word's origin).
A gap wider than WORD_GAP of the font size is also a space, except between two Arabic
letters on a line that has real space glyphs: there geometry is not reliable, because
the gap after a non-joining letter inside a word (measured 0.34 of the font size in
"دالاً") can be wider than a real word gap (0.27 in "أكثر من"). Where Latin meets
Arabic, which never join, any visible gap is a space (Chromium writes none at some
direction changes).

Combining marks are attached to the base glyph next to them in the content stream
whose box touches theirs (preferring the one before), and only otherwise to the
nearest base by position: Chromium places a mark's box flush against its base, on the
side of the following letter, so the nearest box can be the wrong letter.
"""

import ctypes
import itertools
import unicodedata
from dataclasses import dataclass, field

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_raw

LOGICAL_ORDER_VERSION = "logical-order-v2"
# Fraction of the font size within which two baselines belong to the same line.
BASELINE_TOLERANCE = 0.45
# Gap (fraction of the font size) that always separates two words.
WORD_GAP = 0.3
# Smaller gap that separates words only when the page puts a space there.
SPACED_GAP = 0.1
# Gap needed for a space character in the content stream to count as a word space.
STREAM_SPACE_GAP = 0.2
# Soft wraps: the next line follows within this many font sizes (and within 1.15× the
# page's tightest line spacing), and the line ends this close to the block's far edge.
MAX_LINE_SPACING = 2.0
WRAP_EDGE = 0.12


@dataclass
class _Glyph:
    index: int
    text: str
    x0: float
    x1: float
    origin_y: float
    size: float
    # Number of space characters before this glyph in the content stream.
    word: int = 0

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
    word = 0
    try:
        stream: list[tuple[int, str]] = []
        for index in range(text_page.count_chars()):
            if pdfium_raw.FPDFText_IsGenerated(text_page, index):
                continue  # pdfium's synthesised spaces/newlines: not on the page
            code = pdfium_raw.FPDFText_GetUnicode(text_page, index)
            if code not in (0, 0xFFFE, 0xFFFF):
                stream.append((index, chr(code)))
        for position, (index, char) in enumerate(stream):
            pdfium_raw.FPDFText_GetCharOrigin(text_page, index, ctypes.byref(x), ctypes.byref(y))
            left, _bottom, right, _top = text_page.get_charbox(index)
            size = pdfium_raw.FPDFText_GetFontSize(text_page, index) or 10.0
            if char.isspace():
                if right - left > 0.5:
                    word += 1
                    spaces.append(_Glyph(index, " ", left, right, y.value, size, word))
                elif not any(
                    unicodedata.category(c) == "Mn" for _, c in stream[position + 1 : position + 4]
                ):
                    # A zero-width space is a word boundary too, except where Chromium
                    # splits a run around a combining mark ("دا|لاً", "و|طُبّق").
                    word += 1
                continue
            # NFKC per glyph maps presentation forms (and ligatures such as لا) to letters.
            glyphs.append(
                _Glyph(index, unicodedata.normalize("NFKC", char), left, right, y.value, size, word)
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
                previous.index,
                text,
                previous.x0,
                previous.x1,
                previous.origin_y,
                previous.size,
                previous.word,
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


def _is_word_gap(
    previous: _Glyph, glyph: _Glyph, lo: float, hi: float, spaces: list[_Glyph]
) -> bool:
    size = min(previous.size, glyph.size)
    gap = hi - lo
    if gap > SPACED_GAP * size and any(lo - 0.5 <= s.centre <= hi + 0.5 for s in spaces):
        return True
    # A space character in the stream between them, where the gap is word-sized
    # (Chromium's zero-width spaces sit near, not always exactly at, the boundary).
    if previous.word != glyph.word and gap > STREAM_SPACE_GAP * size:
        return True
    scripts = {_strong(previous.text), _strong(glyph.text)}
    # Latin next to Arabic never joins: a visible gap is a space ("TEI لترميز").
    if scripts == {"L", "R"} and gap > SPACED_GAP * size:
        return True
    # Between two Arabic letters geometry is ambiguous (non-joining letters leave gaps
    # inside words), so it is used only when the line has no real space glyphs.
    if scripts == {"R"} and spaces:
        return False
    return gap > WORD_GAP * size


def _touches(mark: _Glyph, base: _Glyph) -> bool:
    return mark.x0 - 0.05 <= base.x1 and base.x0 <= mark.x1 + 0.05


def _attach_marks(
    bases: list[_Glyph], marks: list[_Glyph], right_to_left: bool
) -> dict[int, list[str]]:
    attached: dict[int, list[str]] = {id(base): [] for base in bases}
    by_stream = sorted(bases, key=lambda g: g.index)
    for mark in sorted(marks, key=lambda g: g.index):
        before = [b for b in by_stream if b.index < mark.index]
        after = [b for b in by_stream if b.index > mark.index]
        touching = [b for b in bases if _touches(mark, b)]
        adjacent = [n for n in (before[-1:] + after[:1]) if n in touching]
        # Chromium draws a mark's box flush against the start edge of its base
        # (its left edge in a right-to-left line), on the side of the next letter.
        flush = [
            b
            for b in touching
            if abs((b.x0 - mark.x1) if right_to_left else (mark.x0 - b.x1)) < 0.05
        ]
        chosen = (adjacent or flush or touching)[:1]
        if chosen:
            attached[id(chosen[0])].append(mark.text)
            continue
        centre = mark.centre

        def distance(base: _Glyph, centre: float = centre) -> float:
            if base.x0 - 0.5 <= centre <= base.x1 + 0.5:
                return 0.0
            return min(abs(base.x0 - centre), abs(base.x1 - centre))

        attached[id(min(bases, key=distance))].append(mark.text)
    return attached


def _is_number(text: str) -> bool:
    return bool(text) and all(unicodedata.bidirectional(c) in ("EN", "AN") for c in text)


def _join_numbers_rtl(words: list[str]) -> list[str]:
    """In a right-to-left line (words in visual order), joins "05" "." "0" into "0.05"."""
    out = list(words)
    index = 0
    while index + 2 < len(out):
        right, separator, left = out[index], out[index + 1], out[index + 2]
        if (
            len(separator) == 1
            and unicodedata.bidirectional(separator) in ("CS", "ES")
            and _is_number(right.replace(",", "").replace(".", ""))
            and _is_number(left)
        ):
            out[index : index + 3] = [left + separator + right]
            continue
        index += 1
    return out


def _line_text(line: _Line, spaces: list[_Glyph]) -> str:
    bases = [glyph for glyph in line.glyphs if not glyph.is_mark]
    marks = [glyph for glyph in line.glyphs if glyph.is_mark]
    if not bases:
        return "".join(mark.text for mark in marks)
    rtl = sum(_strong(glyph.text) == "R" for glyph in bases)
    ltr = sum(_strong(glyph.text) == "L" for glyph in bases)
    right_to_left = rtl > ltr
    bases.sort(key=lambda g: -g.centre if right_to_left else g.centre)

    attached = _attach_marks(bases, marks, right_to_left)

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
            if _is_word_gap(previous, base, lo, hi, line_spaces):
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
        words = _join_numbers_rtl(words)
        words = [word if _is_ltr_token(word) else word.translate(_MIRRORED) for word in words]
        words = _reverse_runs(words, _is_ltr_token)
    else:
        words = _reverse_runs(words, _is_rtl_token)
    return "".join(words)


def _direction(line: _Line) -> str:
    rtl = sum(_strong(g.text) == "R" for g in line.glyphs)
    ltr = sum(_strong(g.text) == "L" for g in line.glyphs)
    return "rtl" if rtl > ltr else "ltr"


def _soft_wraps(lines: list[_Line]) -> list[bool]:
    """For each line, whether it is soft-wrapped into the next one."""
    if len(lines) < 2:
        return [False] * len(lines)
    left = min(g.x0 for line in lines for g in line.glyphs)
    right = max(g.x1 for line in lines for g in line.glyphs)
    edge = WRAP_EDGE * (right - left)
    gaps = [a.baseline - b.baseline for a, b in itertools.pairwise(lines)]
    tightest = min((gap for gap in gaps if gap > 0), default=0.0)
    wraps: list[bool] = []
    for line, following, gap in zip(lines, lines[1:], gaps, strict=False):
        direction = _direction(line)
        reaches = (
            min(g.x0 for g in line.glyphs) - left <= edge
            if direction == "rtl"
            else right - max(g.x1 for g in line.glyphs) <= edge
        )
        wraps.append(
            reaches
            and direction == _direction(following)
            and 0 < gap <= MAX_LINE_SPACING * line.size
            and gap <= tightest * 1.15
        )
    return [*wraps, False]


def page_text(page: pdfium.PdfPage) -> str:
    """The page's text in logical reading order: one paragraph per output line."""
    glyphs, spaces = _glyphs(page)
    glyphs = _merge_ligatures(glyphs)
    lines = _lines(glyphs)
    parts: list[str] = []
    for line, wrapped in zip(lines, _soft_wraps(lines), strict=True):
        text = _line_text(line, spaces)
        if text:
            parts.append(text + (" " if wrapped else "\n"))
    return "".join(parts).rstrip("\n ")
