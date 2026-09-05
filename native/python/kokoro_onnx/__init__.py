"""Standalone Kokoro ONNX inference engine using Misaki English G2P.

Derived from kokoro-onnx (https://github.com/thewh1teagle/kokoro-onnx)
Original Work Copyright (c) 2025 thewh1teagle (MIT License)
Modifications and Misaki G2P integration Copyright (c) 2026 kentlincku (Apache-2.0 License)

Eliminates phonemizer, eSpeak-NG, and GPL copyleft dependencies entirely.

--- MIT License Notice for Upstream Derived Components (kokoro-onnx / DEFAULT_VOCAB) ---
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
-----------------------------------------------------------------------------------------
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np
import onnxruntime as ort

SAMPLE_RATE = 24000
MAX_PHONEME_LENGTH = 510

DEFAULT_VOCAB: Dict[str, int] = {
    ';': 1, ':': 2, ',': 3, '.': 4, '!': 5, '?': 6, '—': 9, '…': 10, '"': 11, '(': 12, ')': 13,
    '“': 14, '”': 15, ' ': 16, '\u0303': 17, 'ʣ': 18, 'ʤ': 19, 'ʥ': 20, 'ʦ': 21, 'ᵝ': 22, 'ꭧ': 23,
    'A': 24, 'I': 25, 'O': 31, 'Q': 33, 'S': 35, 'T': 36, 'W': 39, 'Y': 41, 'ᵊ': 42, 'a': 43,
    'b': 44, 'c': 45, 'd': 46, 'e': 47, 'f': 48, 'h': 50, 'i': 51, 'j': 52, 'k': 53, 'l': 54,
    'm': 55, 'n': 56, 'o': 57, 'p': 58, 'q': 59, 'r': 60, 's': 61, 't': 62, 'u': 63, 'v': 64,
    'w': 65, 'x': 66, 'y': 67, 'z': 68, 'ɑ': 69, 'ɐ': 70, 'ɒ': 71, 'æ': 72, 'β': 75, 'ɔ': 76,
    'ɕ': 77, 'ç': 78, 'ɖ': 80, 'ð': 81, 'ʤ': 82, 'ə': 83, 'ɚ': 85, 'ɛ': 86, 'ɜ': 87, 'ɟ': 90,
    'ɡ': 92, 'ɥ': 99, 'ɨ': 101, 'ɪ': 102, 'ʝ': 103, 'ɯ': 110, 'ɰ': 111, 'ŋ': 112, 'ɳ': 113,
    'ɲ': 114, 'ɴ': 115, 'ø': 116, 'ɸ': 118, 'θ': 119, 'œ': 120, 'ɹ': 123, 'ɾ': 125, 'ɻ': 126,
    'ʁ': 128, 'ɽ': 129, 'ʂ': 130, 'ʃ': 131, 'ʈ': 132, 'ʧ': 133, 'ʊ': 135, 'ʋ': 136, 'ʌ': 138,
    'ɣ': 139, 'ɤ': 140, 'χ': 142, 'ʎ': 143, 'ʒ': 147, 'ʔ': 148, 'ˈ': 156, 'ˌ': 157, 'ː': 158,
    'ʰ': 162, 'ʲ': 164, '↓': 169, '→': 171, '↗': 172, '↘': 173, 'ᵻ': 177
}


class Tokenizer:
    def __init__(self, vocab: Optional[Dict[str, int]] = None):
        self.vocab = vocab or DEFAULT_VOCAB
        self._g2p = None

    def _get_g2p(self):
        if self._g2p is None:
            from misaki import en
            import en_core_web_sm

            class OfflineG2P(en.G2P):
                def __init__(self, version=None, trf=False, british=False, fallback=None, unk='❓'):
                    self.version = version
                    self.british = british
                    self.nlp = en_core_web_sm.load(enable=['tok2vec', 'tagger'])
                    self.lexicon = en.Lexicon(british)
                    self.fallback = fallback if fallback else None
                    self.unk = unk

            def spell_fallback(token):
                lex = en.Lexicon(False)
                chars = [lex.golds.get(c.upper(), '') for c in token.text if c.isalpha()]
                return ' '.join(filter(None, chars)), 1

            self._g2p = OfflineG2P(trf=False, fallback=spell_fallback)
        return self._g2p

    def phonemize(self, text: str, lang: str = "en-us") -> str:
        g2p = self._get_g2p()
        phonemes, _ = g2p(text)
        return "".join(p for p in phonemes if p in self.vocab or p.isspace()).strip()

    def tokenize(self, phonemes: str, limit: Optional[int] = MAX_PHONEME_LENGTH) -> List[int]:
        if limit is not None and len(phonemes) > limit:
            raise ValueError(f"text is too long, must be less than {limit} phonemes")
        return [self.vocab[p] for p in phonemes if p in self.vocab]


class Kokoro:
    def __init__(
        self,
        model_path: Union[str, Path],
        voices_path: Union[str, Path],
        providers: Optional[List[str]] = None,
    ) -> None:
        self.model_path = str(model_path)
        self.voices_path = str(voices_path)
        self.sess: ort.InferenceSession = ort.InferenceSession(
            self.model_path,
            providers=providers or ["CPUExecutionProvider"]
        )
        self.voices: Dict[str, np.ndarray] = np.load(self.voices_path)
        self.tokenizer = Tokenizer(DEFAULT_VOCAB)

    def get_voices(self) -> List[str]:
        return sorted(self.voices.keys())

    def get_voice_style(self, voice: str) -> np.ndarray:
        if voice not in self.voices:
            raise ValueError(f"Voice '{voice}' not found in available voices")
        return self.voices[voice]

    def _split_into_batches(self, text: str, max_chunk_chars: int = 250) -> List[str]:
        """Split text into sentence-sized chunks for smooth synthesis."""
        sentences = re.split(r'(?<=[.!?;\n])\s+', text.strip())
        batches = []
        current = ""
        for s in sentences:
            if not s.strip():
                continue
            if current and len(current) + len(s) > max_chunk_chars:
                batches.append(current.strip())
                current = s
            else:
                current = f"{current} {s}".strip() if current else s
        if current.strip():
            batches.append(current.strip())
        return batches or [text]

    def _infer_batch(self, token_ids: List[int], voice_style: np.ndarray, speed: float) -> np.ndarray:
        input_names = [inp.name for inp in self.sess.get_inputs()]
        token_key = "tokens" if "tokens" in input_names else "input_ids"

        style_vector = voice_style[min(len(token_ids), len(voice_style)) - 1]

        inputs = {
            token_key: np.array([[0, *token_ids, 0]], dtype=np.int64),
            "style": np.asarray(style_vector, dtype=np.float32),
            "speed": np.array([float(speed)], dtype=np.float32),
        }

        outputs = self.sess.run(None, inputs)
        audio = np.asarray(outputs[0]).ravel()
        return audio

    def create(
        self,
        text: str,
        voice: Union[str, np.ndarray] = "af_heart",
        speed: float = 1.0,
        lang: str = "en-us",
        is_phonemes: bool = False,
        **_kwargs: Any,
    ) -> Tuple[np.ndarray, int]:
        """Synthesize speech waveform for text with given voice and speed."""
        if not 0.5 <= speed <= 2.0:
            raise ValueError(f"Speed should be between 0.5 and 2.0, got {speed}")

        if isinstance(voice, str):
            style = self.get_voice_style(voice)
        else:
            style = voice

        batches = self._split_into_batches(text)
        audio_segments: List[np.ndarray] = []
        pause = np.zeros(int(SAMPLE_RATE * 0.15), dtype=np.float32)

        for batch_text in batches:
            if is_phonemes:
                phonemes = batch_text
            else:
                phonemes = self.tokenizer.phonemize(batch_text, lang=lang)

            if not phonemes.strip():
                continue

            token_ids = self.tokenizer.tokenize(phonemes)
            if not token_ids:
                continue

            chunk_audio = self._infer_batch(token_ids, style, speed)
            if len(chunk_audio) > 0:
                audio_segments.append(chunk_audio)
                audio_segments.append(pause)

        if not audio_segments:
            return np.zeros(0, dtype=np.float32), SAMPLE_RATE

        # Remove trailing pause
        final_audio = np.concatenate(audio_segments[:-1]) if len(audio_segments) > 1 else audio_segments[0]
        return final_audio, SAMPLE_RATE


__all__ = ["Kokoro", "Tokenizer", "DEFAULT_VOCAB", "SAMPLE_RATE"]
