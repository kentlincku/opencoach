"""English tokenizer adapter. Optional speech dependencies are lazy imports."""
from __future__ import annotations

import re
import string
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from .backends.base import BackendExecutionError, BackendInputError, BackendUnavailableError


REQUIRED_NUMBER_WORDS = frozenset('''zero one two three four five six seven eight nine ten
    eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty
    forty fifty sixty seventy eighty ninety hundred thousand million billion trillion zeroth
    first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth
    fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth thirtieth fortieth
    fiftieth sixtieth seventieth eightieth ninetieth hundredth thousandth millionth billionth
    trillionth oh point minus plus and dollar dollars cent cents pound pounds penny pence euro euros'''.split())
_INPUT_CODES = frozenset(('UNSUPPORTED_ENGLISH_NUMBER', 'ENGLISH_NUMBER_LIMIT',
                         'UNSUPPORTED_ENGLISH_TOKEN', 'ENGLISH_SPELLING_LIMIT', 'ENGLISH_SPAN_INVALID'))


def _unavailable():
    return BackendUnavailableError('tts', 'kokoro-onnx', 'ENGLISH_RESOURCE_INVALID')


def _normalize(phonemes):
    return ' '.join(phonemes.replace('ɾ', 'T').replace('ʔ', 't').split())


@dataclass(frozen=True)
class EnglishPreflight:
    number_spans: tuple
    identifier_spans: tuple
    ordinary_spans: tuple


def _identifier(lexeme):
    if re.match(r'^[0-9]+(?:st|nd|rd|th)', lexeme) or re.fullmatch(r'[0-9]+(?:\.[0-9]+)?[eE][+-]?[0-9]*', lexeme) or re.fullmatch(r"[0-9]+(?:s|'s|ed|'d|ing)", lexeme):
        raise BackendInputError('UNSUPPORTED_ENGLISH_NUMBER')
    if not re.fullmatch(r'[A-Za-z0-9]+', lexeme) or not re.search('[A-Za-z]', lexeme) or not re.search('[0-9]', lexeme):
        raise BackendInputError('UNSUPPORTED_ENGLISH_TOKEN')
    if len(lexeme) > 64:
        raise BackendInputError('ENGLISH_SPELLING_LIMIT')
    if any(len(run) > 18 for run in re.findall('[0-9]+', lexeme)):
        raise BackendInputError('ENGLISH_NUMBER_LIMIT')


def preflight(text: str) -> EnglishPreflight:
    """Pure cleaned-text admission. No NLP, resource or third-party imports."""
    if not isinstance(text, str) or len(text) > 5000:
        raise BackendInputError('INVALID_TEXT_LENGTH')
    if not text.strip():
        raise BackendInputError('EMPTY_TEXT')
    numbers, identifiers, ordinary = [], [], []
    letters = 0
    for m in re.finditer(r'[^\s,;:!?"“”()—…]+', text):
        run, start, end = m.group(), m.start(), m.end()
        numeric = bool(re.search('[0-9]', run)) or any(c in run for c in '$£€+−')
        if run.endswith('.') and not re.fullmatch(r'(?:[A-Za-z]\.){2,}', run):
            # A numeric token keeps its period (list marker "1. hello") unless it ends the
            # text or a new sentence starts with a capital letter ("That's $5.50. Yes, ...").
            # Closing quotes/brackets after the period still end the sentence ('$8.50." Next').
            following = text[end:].lstrip().lstrip('"”)\']').lstrip()
            if not numeric or not following or (following[0].isupper() and following[0].isascii()):
                run, end = run[:-1], end-1
        if not run:
            continue
        if numeric:
            match = re.fullmatch(r'([+-]?)([$£€]?)([0-9]+(?:\.[0-9]+)?|\.[0-9]+)(st|nd|rd|th)?', run)
            if match:
                sign, currency, magnitude, suffix = match.groups()
                parts = magnitude.split('.')
                if len(parts[0]) > 15 or (len(parts) == 2 and len(parts[1]) > 18):
                    raise BackendInputError('ENGLISH_NUMBER_LIMIT')
                if currency and len(parts) == 2 and len(parts[1]) > 2:
                    raise BackendInputError('UNSUPPORTED_ENGLISH_NUMBER')
                if suffix:
                    if sign == '-' or currency or len(parts) != 1:
                        raise BackendInputError('UNSUPPORTED_ENGLISH_NUMBER')
                    value = int(magnitude)
                    expected = 'th' if 10 <= value % 100 <= 20 else {1:'st',2:'nd',3:'rd'}.get(value % 10,'th')
                    if suffix != expected:
                        raise BackendInputError('UNSUPPORTED_ENGLISH_NUMBER')
                word = ('-' if sign == '-' else '') + magnitude + (suffix or '')
                numbers.append((start,end,word,currency or None,sign == '+'))
            else:
                if not re.fullmatch('[A-Za-z0-9]+', run):
                    raise BackendInputError('UNSUPPORTED_ENGLISH_NUMBER')
                _identifier(run)
                identifiers.append((start,end,run))
                letters += len(re.findall('[A-Za-z]', run))
        else:
            if not (re.fullmatch(r"[A-Za-z]+(?:'[A-Za-z]+)*(?:-[A-Za-z]+(?:'[A-Za-z]+)*)*", run)
                    or re.fullmatch(r'(?:[A-Za-z]\.){2,}', run)
                    or run in ('%', '&', '@', '/', '+')):
                raise BackendInputError('UNSUPPORTED_ENGLISH_TOKEN')
            ordinary.append((start,end,run))
    if letters > 256:
        raise BackendInputError('ENGLISH_SPELLING_LIMIT')
    return EnglishPreflight(tuple(numbers), tuple(identifiers), tuple(ordinary))


def speakable(text: str) -> str:
    """Admit as much of a reply as the English G2P can say, instead of failing the sentence.

    Runs (whitespace/punctuation-delimited, the same split as preflight) that preflight
    rejects with a token/number code are dropped; everything else is kept verbatim.
    Raises the original error when nothing speakable remains, or for length/empty errors.
    """
    try:
        preflight(text)
        return text
    except BackendInputError as error:
        if error.code not in ('UNSUPPORTED_ENGLISH_TOKEN', 'UNSUPPORTED_ENGLISH_NUMBER'):
            raise
        first = error
    kept, last = [], 0
    for m in re.finditer(r'[^\s,;:!?"“”()—…]+', text):
        run = m.group()
        try:
            # A run is kept only if preflight admits it on its own and it carries something
            # sayable (letters, digits, or one of the symbols the G2P reads aloud).
            ok = bool(re.search('[A-Za-z0-9]', run) or run in ('%', '&', '@', '+'))
            if ok: preflight(run)
        except BackendInputError:
            ok = False
        if not ok:
            kept.append(text[last:m.start()])
            last = m.end()
    kept.append(text[last:])
    result = re.sub(r'\s+([,.;:!?])', r'\1', re.sub(r'\s+', ' ', ''.join(kept))).strip(' ,;:')
    result = re.sub(r'([,;:])(?:\s*[,;:])+', r'\1', result)
    if not re.search('[A-Za-z]', result):
        raise first
    try:
        preflight(result)
    except BackendInputError as error:
        if error.code != 'UNSUPPORTED_ENGLISH_NUMBER':
            raise
        # A number's trailing period is read as a list marker unless a capitalised sentence
        # follows; when context is ambiguous, make that period a comma so the amount is spoken.
        result = re.sub(r'([0-9])\.(?=["”\')\]]*(?:[\s,;:]|$))', r'\1,', result)
        preflight(result)
    return result


def _resource_path(anchor, relative='', *, directory=False):
    import stat
    from pathlib import Path
    anchor = Path(anchor).absolute()
    path = anchor / relative
    if '..' in path.parts or not path.is_relative_to(anchor):
        raise _unavailable()
    for part in (path, *path.parents):
        mode = part.lstat().st_mode
        if stat.S_ISLNK(mode):
            raise _unavailable()
    mode = path.stat().st_mode
    if not (stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode)):
        raise _unavailable()
    return path


def resolve_resource_anchor():
    """Locate only. Frozen onedir identity is checked, never inferred from env."""
    import importlib
    import importlib.resources
    import sys
    from pathlib import Path
    try:
        vendor = importlib.import_module('voice_practice_speech_vendor')
        anchor = importlib.resources.files(vendor)
        if not isinstance(anchor, Path) or not anchor.is_absolute():
            raise _unavailable()
        anchor = _resource_path(anchor, directory=True)
        origin = Path(vendor.__file__)
        if not origin.is_absolute() or origin.parent != anchor:
            raise _unavailable()
        if getattr(sys, 'frozen', False):
            expected = Path(sys.executable).absolute().parent / '_internal/voice_practice_speech_vendor'
            if anchor != expected:
                raise _unavailable()
        # PYZ __file__ is a location marker, not a required physical source file.
        return anchor
    except (ImportError, OSError, TypeError, ValueError, AttributeError):
        raise _unavailable() from None


def _debug_cause(stage, exc):
    """Opt-in diagnostics (VOICE_RUNTIME_DEBUG=1): exception type and message only, to stderr."""
    import os, sys
    if os.environ.get('VOICE_RUNTIME_DEBUG') == '1':
        print(f'english_g2p {stage}: {type(exc).__name__}: {str(exc)[:300]}', file=sys.stderr, flush=True)


def resolve_english_paths(anchor):
    """Physical resource checks only; complete inventory/rights belongs to S4."""
    import os
    try:
        paths = tuple(_resource_path(anchor, 'resources/misaki/en/' + name)
                      for name in ('us_gold.json', 'us_silver.json'))
        relative = 'resources/spacy/en_core_web_sm-3.8.0'
        nlp_path = _resource_path(anchor, relative, directory=True)
        for name in ('meta.json', 'config.cfg', 'tokenizer', 'tok2vec/model', 'tagger/model', 'vocab/strings.json'):
            _resource_path(anchor, relative + '/' + name)
        for root, directories, files in os.walk(nlp_path):
            from pathlib import Path
            for name in directories:
                _resource_path(anchor, str((Path(root)/name).relative_to(anchor)), directory=True)
            for name in files:
                _resource_path(anchor, str((Path(root)/name).relative_to(anchor)))
        return nlp_path, paths
    except (OSError, ValueError, TypeError):
        raise _unavailable() from None


def load_english_resources(anchor, vocab):
    from .english_numbers import EnglishNumberFormatter
    nlp_path, paths = resolve_english_paths(anchor)
    try:
        import spacy
        import inflect
        nlp = spacy.load(nlp_path, enable=['tok2vec', 'tagger'])
        if not {'tok2vec', 'tagger'}.issubset(nlp.pipe_names):
            raise _unavailable()
        return EnglishG2PAdapter(nlp=nlp, formatter=EnglishNumberFormatter(engine=inflect.engine()), lexicon_paths=paths, vocab=vocab)
    except (ImportError, OSError, ValueError, TypeError, AttributeError) as exc:
        _debug_cause('load_english_resources', exc)
        raise _unavailable() from None


class EnglishG2PAdapter:
    def __init__(self, *, nlp, formatter, lexicon_paths, vocab):
        # V3 owns provenance resolution; this gate validates the supplied map, never defaults.
        if not isinstance(vocab, Mapping) or not vocab or len(vocab) > 4096:
            raise _unavailable()
        if any(not isinstance(c, str) or len(c) != 1 or type(i) is not int or i < 0 for c,i in vocab.items()):
            raise _unavailable()
        if len(set(vocab.values())) != len(vocab) or not any(v > 0 for v in vocab.values()):
            raise _unavailable()
        self.vocab = MappingProxyType(dict(vocab))
        self.formatter = formatter
        self.last_spelling_events = ()
        self._active = False
        try:
            from voice_practice_speech_vendor.misaki.en import G2P
            self.lock = formatter.lock
            self._g2p = G2P(nlp=nlp, number_formatter=formatter, lexicon_paths=lexicon_paths,
                            spell_ascii=self.spell_ascii, render_identifier=self.render_identifier,
                            spell_ascii_source=self.spell_ascii,
                            version='1.0', british=False, fallback=None)
            lex = self._g2p.lexicon
            for dictionary in (lex.golds, lex.silvers):
                for entry in dictionary.values():
                    self._resource_entry(entry)
            self._letters = {c:self._resource_phonemes(lex.golds.get(c)) for c in string.ascii_uppercase}
            for word in REQUIRED_NUMBER_WORDS:
                entry = lex.golds.get(word, lex.silvers.get(word))
                if entry is None and word.endswith('s') and not word.endswith('ss'):
                    # misaki derives regular plurals from the singular (Lexicon.stem_s);
                    # upstream us_gold has 'euro' but no 'euros'.
                    entry = lex.golds.get(word[:-1], lex.silvers.get(word[:-1]))
                self._resource_phonemes(entry)
            self.known(' ')
        except (ImportError, OSError, ValueError, TypeError, AttributeError):
            raise _unavailable() from None

    def _resource_entry(self, entry):
        # Upstream misaki marks per-tag variants as None to mean "no override; use the
        # spelling/NNP fallback" (misaki Lexicon.lookup). DEFAULT must always be a phoneme
        # string; tagged variants are either None or a phoneme string.
        if isinstance(entry, dict):
            self._resource_phonemes(entry.get('DEFAULT'))
            for tag, ps in entry.items():
                if not isinstance(tag, str):
                    raise _unavailable()
                if ps is not None:
                    self._resource_phonemes(ps)
        else:
            self._resource_phonemes(entry)

    def _resource_phonemes(self, entry):
        if isinstance(entry, dict):
            entry = entry.get('DEFAULT')
        if not isinstance(entry, str) or not entry.strip():
            raise _unavailable()
        self.known(_normalize(entry))
        return entry

    def _budget(self, count):
        if not self._active:
            raise BackendInputError('ENGLISH_SPAN_INVALID')
        self._letter_count += count
        if self._letter_count > 256:
            raise BackendInputError('ENGLISH_SPELLING_LIMIT')

    def _render_letters(self, letters):
        return ' '.join(self._letters[c.upper()] for c in letters)

    def spell_ascii(self, letters, source=None):
        if not isinstance(letters, str) or not re.fullmatch('[A-Za-z]+', letters):
            raise BackendInputError('UNSUPPORTED_ENGLISH_TOKEN')
        if len(letters) > 64:
            raise BackendInputError('ENGLISH_SPELLING_LIMIT')
        self._budget(len(letters))
        # M supplies the original atomic source before dotted/case normalization.
        # Legacy one-argument callers still receive the same spelling behavior.
        source = letters if source is None else source
        if not isinstance(source, str) or source.replace('.', '').lower() != letters.lower():
            raise BackendInputError('ENGLISH_SPAN_INVALID')
        self.last_spelling_events += ((source, 'spelled'),)
        return self._render_letters(letters)

    def render_identifier(self, lexeme):
        _identifier(lexeme)
        self._budget(len(re.findall('[A-Za-z]', lexeme)))
        if not self._identifiers[lexeme]:
            raise BackendInputError('ENGLISH_SPAN_INVALID')
        self._identifiers[lexeme] -= 1
        self.last_spelling_events += ((lexeme, 'identifier'),)
        result = []
        for run in re.findall('[A-Za-z]+|[0-9]+', lexeme):
            if run[0] in '0123456789':
                for word in self.formatter.digits(run).split():
                    result.append(self._g2p.lexicon.lookup(word, None, None, None)[0])
            else:
                result.append(self._render_letters(run))
        return ' '.join(result)

    @staticmethod
    def _coverage(text, phonemes, tokens):
        """Reconcile original text and consumed groups, independently of M ratings."""
        if not tokens or not isinstance(phonemes, str) or not phonemes.strip():
            raise _unavailable()
        cursor = 0
        reconstructed = []
        for tk in tokens:
            if not isinstance(tk.text, str) or not tk.text or not isinstance(tk.phonemes, str):
                raise _unavailable()
            while cursor < len(text) and text[cursor].isspace():
                cursor += 1
            if not text.startswith(tk.text, cursor):
                raise _unavailable()
            cursor += len(tk.text)
            if not tk.phonemes.strip() and not all(c.isspace() or c in '-.,;:!?—…"“”()' for c in tk.text):
                raise _unavailable()
            reconstructed.append(tk.phonemes + tk.whitespace)
        if text[cursor:].strip() or _normalize(''.join(reconstructed)) != _normalize(phonemes):
            raise _unavailable()

    def phonemize(self, text, lang='en-us', norm=True):
        # V3 must hold THIS reentrant lock across the complete K.create as well.
        with self.lock:
            self.last_spelling_events = ()
            if lang != 'en-us' or norm is not True:
                raise BackendInputError('UNSUPPORTED_ENGLISH_TOKEN')
            plan = preflight(text)
            self._letter_count = 0
            self._identifiers = Counter(s[2] for s in plan.identifier_spans)
            self._active = True
            try:
                ps, tokens = self._g2p(text, preprocess=False, number_spans=plan.number_spans,
                                       identifier_spans=plan.identifier_spans)
                if any(self._identifiers.values()):
                    raise _unavailable()
                self._coverage(text, ps, tokens)
                return self.known(_normalize(ps))
            except BackendInputError:
                raise
            except ValueError as error:
                if str(error) in _INPUT_CODES:
                    raise BackendInputError(str(error)) from None
                if str(error) in ('ENGLISH_RESOURCE_INVALID', 'ENGLISH_CONFIGURATION_INVALID'):
                    raise _unavailable() from None
                raise BackendExecutionError('tts', 'kokoro-onnx') from None
            finally:
                self._active = False
                self._identifiers.clear()


    def known(self, phonemes):
        if not isinstance(phonemes, str) or any(c not in self.vocab or self.vocab[c] == 0 for c in phonemes):
            raise BackendUnavailableError('tts', 'kokoro-onnx', 'ENGLISH_VOCAB_INVALID')
        return phonemes

    def tokenize(self, phonemes, limit=510):
        self.known(phonemes)
        if limit is not None and len(phonemes) > limit:
            raise BackendInputError('ENGLISH_PHONEME_LIMIT')
        return [self.vocab[c] for c in phonemes]
