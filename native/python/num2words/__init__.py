"""Clean-room Python implementation of English cardinal and ordinal verbalization functions for Misaki English G2P verbalization.

Authored under Apache-2.0 (Copyright (c) 2026 kentlincku) to replace external LGPL-2.1 num2words library.
"""
from __future__ import annotations

import re
from typing import Union

_ONES = [
    "", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
    "seventeen", "eighteen", "nineteen"
]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
_SCALES = ["", "thousand", "million", "billion", "trillion"]

_ORD_SPECIAL = {
    "one": "first", "two": "second", "three": "third", "four": "fourth",
    "five": "fifth", "six": "sixth", "seven": "seventh", "eight": "eighth",
    "nine": "ninth", "ten": "tenth", "eleven": "eleventh", "twelve": "twelfth",
    "thirteen": "thirteenth", "fourteen": "fourteenth", "fifteen": "fifteenth",
    "sixteen": "sixteenth", "seventeen": "seventeenth", "eighteen": "eighteenth",
    "nineteen": "nineteenth", "twenty": "twentieth", "thirty": "thirtieth",
    "forty": "fortieth", "fifty": "fiftieth", "sixty": "sixtieth",
    "seventy": "seventieth", "eighty": "eightieth", "ninety": "ninetieth",
}


def _chunk_to_words(val: int) -> str:
    words = []
    if val >= 100:
        words.append(_ONES[val // 100] + " hundred")
        val %= 100
    if val >= 20:
        tens_str = _TENS[val // 10]
        val %= 10
        if val > 0:
            tens_str += "-" + _ONES[val]
        words.append(tens_str)
    elif val > 0:
        words.append(_ONES[val])
    return " ".join(words)


def _int_to_cardinal(n: int) -> str:
    if n == 0:
        return "zero"
    if n < 0:
        return "minus " + _int_to_cardinal(-n)
    parts = []
    scale_idx = 0
    while n > 0:
        chunk = n % 1000
        if chunk > 0:
            chunk_words = _chunk_to_words(chunk)
            if _SCALES[scale_idx]:
                chunk_words += " " + _SCALES[scale_idx]
            parts.insert(0, chunk_words)
        n //= 1000
        scale_idx += 1
    return " ".join(parts)


def _to_ordinal(cardinal: str) -> str:
    words = cardinal.split()
    if not words:
        return "zeroth"
    last = words[-1]
    last_hyphen = last.split("-")
    target = last_hyphen[-1]
    if target in _ORD_SPECIAL:
        last_hyphen[-1] = _ORD_SPECIAL[target]
    elif target.endswith("y"):
        last_hyphen[-1] = target[:-1] + "ieth"
    else:
        last_hyphen[-1] = target + "th"
    words[-1] = "-".join(last_hyphen)
    return " ".join(words)


def num2words(val: Union[int, float, str], to: str = "cardinal", **kwargs) -> str:
    """Convert number to written English words."""
    if isinstance(val, str):
        val = val.strip().replace(",", "")
        if "." in val:
            val = float(val)
        else:
            val = int(val)

    if isinstance(val, float):
        int_part = int(val)
        str_val = f"{val:.6f}".rstrip("0").rstrip(".")
        if "." in str_val:
            frac_digits = str_val.split(".")[1]
            frac_words = " ".join(_ONES[int(d)] if int(d) > 0 else "zero" for d in frac_digits)
            return f"{_int_to_cardinal(int_part)} point {frac_words}"
        return _int_to_cardinal(int_part)

    n = int(val)
    if to == "ordinal":
        return _to_ordinal(_int_to_cardinal(n))
    if to == "year":
        if 1000 <= n <= 9999 and n % 100 != 0:
            first_two = n // 100
            last_two = n % 100
            return f"{_int_to_cardinal(first_two)} {_int_to_cardinal(last_two)}"
        return _int_to_cardinal(n)
    return _int_to_cardinal(n)
