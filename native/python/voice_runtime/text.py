import re


def clean_text_for_speech(text: str) -> str:
    """Remove display-only markup and CJK text before English speech synthesis."""
    cleaned = re.sub(r"[\U00010000-\U0010ffff\u2600-\u27BF\uE000-\uF8FF]", "", text or "")
    cleaned = cleaned.translate(str.maketrans({"，": ",", "、": ",", "。": ".", "！": "!", "？": "?"}))
    cleaned = re.sub(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\u31F0-\u31FF\uAC00-\uD7AF]+", " ", cleaned)
    cleaned = re.sub(r"\*\*([^*]+)\*\*", r"\1", cleaned)
    cleaned = re.sub(r"\*([^*]+)\*", r"\1", cleaned)
    cleaned = re.sub(r"[#_~`^>]", "", cleaned)
    cleaned = re.sub(r"\.{2,}", ", ", cleaned)
    cleaned = re.sub(r"\s+([,.;:!?])", r"\1", cleaned)
    cleaned = re.sub(r",\s*", ", ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned if re.search(r"[A-Za-z0-9]", cleaned) else ""
