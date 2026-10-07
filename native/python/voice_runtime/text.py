import re
import unicodedata


def _fold_latin(match):
    # Latin letters with diacritics (café, naïve, résumé) -> ASCII base letters; the English
    # G2P accepts ASCII words only. Other scripts are left for the rules below.
    return ''.join(c for c in unicodedata.normalize('NFKD', match.group()) if not unicodedata.combining(c))


def clean_text_for_speech(text: str) -> str:
    """Remove display-only markup and CJK text before English speech synthesis."""
    cleaned = re.sub(r"[\U00010000-\U0010ffff\u2600-\u27BF\uE000-\uF8FF]", "", text or "")
    cleaned = cleaned.translate(str.maketrans({"，": ",", "、": ",", "。": ".", "！": "!", "？": "?"}))
    cleaned = re.sub(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\u31F0-\u31FF\uAC00-\uD7AF]+", " ", cleaned)
    cleaned = re.sub(r"[\u00C0-\u024F]+", _fold_latin, cleaned)
    cleaned = cleaned.translate(str.maketrans({"\u2018": "'", "\u2019": "'", "\u201C": '"', "\u201D": '"', "\u2013": "\u2014"}))
    # Markdown structure from chat models: list markers and line breaks become pauses,
    # a free-standing hyphen/dash becomes a comma (the G2P has no token for a bare "-").
    cleaned = re.sub(r"(?m)^[ \t]*(?:[-*+\u2022]|\d+[.)])[ \t]+", "", cleaned)
    cleaned = re.sub(r"[ \t]*\n+[ \t]*", lambda m: ". " if "\n\n" in m.group() else ", ", cleaned)
    cleaned = re.sub(r"(?<=\s)[-\u2013\u2014](?=\s)", ",", cleaned)
    cleaned = re.sub(r"\*\*([^*]+)\*\*", r"\1", cleaned)
    cleaned = re.sub(r"\*([^*]+)\*", r"\1", cleaned)
    cleaned = re.sub(r"[#_~`^>]", "", cleaned)
    cleaned = re.sub(r"\.{2,}", ", ", cleaned)
    cleaned = re.sub(r"\s+([,.;:!?])", r"\1", cleaned)
    cleaned = re.sub(r"([,.;:!?])(?:\s*[,.](?=\s|$))+", r"\1", cleaned)
    cleaned = re.sub(r",\s*", ", ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned if re.search(r"[A-Za-z0-9]", cleaned) else ""
