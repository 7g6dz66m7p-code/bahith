"""Unicode token estimates and exact code-point spans; no model tokenizer is implied."""

import math
import re
import unicodedata

from bahith_worker.sanad.models import Direction, ExtractedChunk, ExtractionUnit, SanadError

CHUNKER_VERSION = "sanad-unicode-estimate-v1"
MAX_CHUNKS = 50_000
MAX_TOKENS_PER_UNIT = 200_000
# Each group of at most twelve Unicode word characters or one punctuation/symbol
# is an estimated token. Long URLs/DNA/words cannot bypass the chunk size limit.
_TOKEN = re.compile(r"\w{1,12}|[^\w\s]", re.UNICODE)


def text_direction(text: str) -> Direction:
    """First strong directional character, following Unicode paragraph conventions."""
    for character in text:
        direction = unicodedata.bidirectional(character)
        if direction in {"R", "AL"}:
            return "rtl"
        if direction == "L":
            return "ltr"
    return "auto"


def chunk_units(
    units: list[ExtractionUnit],
    target_tokens: int = 600,
    max_tokens: int = 800,
    overlap: float = 0.15,
) -> list[ExtractedChunk]:
    """Chunk units independently, preserving exact slices into their original content.

    Offsets count Unicode code points (Python string indices). JavaScript consumers
    must use ``Array.from(content).slice(start, end).join('')``, not UTF-16 indices.
    ``tokenCount`` is the versioned Unicode estimate, never a provider token count.
    Empty units and failed pages cannot contribute text or bridge adjacent units.
    """
    if (
        isinstance(target_tokens, bool)
        or isinstance(max_tokens, bool)
        or not isinstance(target_tokens, int)
        or not isinstance(max_tokens, int)
        or not 1 <= target_tokens <= max_tokens <= 800
        or not isinstance(overlap, (float, int))
        or isinstance(overlap, bool)
        or not math.isfinite(overlap)
        or not 0 <= overlap < 1
    ):
        raise SanadError("INVALID_CHUNK_CONFIG")

    result: list[ExtractedChunk] = []
    overlap_tokens = min(int(target_tokens * overlap), target_tokens - 1)
    for unit in units:
        # Store spans only; the input is bounded by extraction's text-size limit.
        tokens: list[tuple[int, int]] = []
        for match in _TOKEN.finditer(unit.content):
            if len(tokens) >= MAX_TOKENS_PER_UNIT:
                raise SanadError("RESOURCE_LIMIT")
            tokens.append((match.start(), match.end()))
        start = 0
        while start < len(tokens):
            if len(result) >= MAX_CHUNKS:
                raise SanadError("RESOURCE_LIMIT")
            end = min(start + target_tokens, len(tokens))
            char_start = tokens[start][0]
            # Large whitespace gaps do not justify arbitrarily large chunks.
            while end > start + 1 and tokens[end - 1][1] - char_start > max_tokens * 12:
                end -= 1
            char_end = tokens[end - 1][1]
            content = unit.content[char_start:char_end]
            result.append(
                ExtractedChunk(
                    index=len(result),
                    unit_index=unit.index,
                    char_start=char_start,
                    char_end=char_end,
                    content=content,
                    page_start=unit.page,
                    page_end=unit.page,
                    token_count=end - start,
                    direction=text_direction(content),
                )
            )
            if end == len(tokens):
                break
            start = end - min(overlap_tokens, end - start - 1)
    return result
