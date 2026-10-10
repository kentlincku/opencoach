"""Bounded English number orchestration; inflect is explicitly instance-owned."""
from __future__ import annotations

import re
from threading import RLock
from .backends.base import BackendExecutionError, BackendInputError


class EnglishNumberFormatter:
    def __init__(self, *, engine):
        self.engine = engine
        self.lock = RLock()

    @staticmethod
    def _digits(value, limit=15):
        if not isinstance(value, str) or not re.fullmatch(r'[0-9]+', value):
            raise BackendInputError('UNSUPPORTED_ENGLISH_NUMBER')
        if len(value) > limit:
            raise BackendInputError('ENGLISH_NUMBER_LIMIT')
        return value

    def _words(self, digits, *, ordinal=False):
        with self.lock:
            try:
                value = self.engine.ordinal(digits) if ordinal else digits
                words = self.engine.number_to_words(value, group=0, andword='', comma='', threshold=None)
                if not isinstance(words, str):
                    raise ValueError()
                words = ' '.join(words.replace('-', ' ').replace(',', ' ').split())
                if not re.fullmatch(r'[a-z]+(?: [a-z]+)*', words):
                    raise ValueError()
                return words
            except Exception:
                raise BackendExecutionError('tts', 'kokoro-onnx') from None

    def cardinal(self, digits: str) -> str:
        return self._words(self._digits(digits))

    def ordinal(self, digits: str) -> str:
        return self._words(self._digits(digits), ordinal=True)

    def digits(self, digits: str) -> str:
        self._digits(digits, 18)
        with self.lock:
            return ' '.join(self.cardinal(c) for c in digits)

    def decimal(self, magnitude: str) -> str:
        if not isinstance(magnitude, str) or not re.fullmatch(r'(?:[0-9]+)?\.[0-9]+', magnitude):
            raise BackendInputError('UNSUPPORTED_ENGLISH_NUMBER')
        whole, fraction = magnitude.split('.')
        if len(whole) > 15 or len(fraction) > 18:
            raise BackendInputError('ENGLISH_NUMBER_LIMIT')
        with self.lock:
            words = ([self.cardinal(whole)] if whole else [])
            return ' '.join([*words, 'point', self.digits(fraction)])

    def year(self, digits: str) -> str:
        if not isinstance(digits, str) or not re.fullmatch(r'[0-9]{4}', digits):
            raise BackendInputError('UNSUPPORTED_ENGLISH_NUMBER')
        with self.lock:
            if digits[0] == '0':
                return self.digits(digits)
            value = int(digits)
            if 1001 <= value <= 1999:
                last = digits[2:]
                ending = 'hundred' if last == '00' else ('oh ' + self.cardinal(last[1]) if last[0] == '0' else self.cardinal(last))
                return self.cardinal(digits[:2]) + ' ' + ending
            if 2010 <= value <= 2099:
                return 'twenty ' + self.cardinal(digits[2:])
            return self.cardinal(digits)
