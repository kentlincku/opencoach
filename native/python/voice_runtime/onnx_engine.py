"""Lazy, content-bound CPU TTS caller. Compatibility is not S2 admission."""
from __future__ import annotations
import hashlib
import json
import os
import re
import stat
from pathlib import Path
from .backends.base import BackendUnavailableError

_LIMIT = 256 * 1024
_CHUNK = 1024 * 1024


def _physical(path):
    path = Path(path).absolute()
    for part in (path, *path.parents):
        if part.is_symlink():
            raise _unavailable()
    return path


def _stamp(value):
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def _open(path):
    path = _physical(path)
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_BINARY', 0)
    fd = os.open(path, flags)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise _unavailable()
    except BaseException:
        os.close(fd)
        raise
    return fd


def _read(fd, path, *, limit=None, collect=False):
    before = os.fstat(fd)
    if limit is not None and before.st_size > limit:
        raise _unavailable()
    if _stamp(_physical(path).stat()) != _stamp(before):
        raise _unavailable()
    os.lseek(fd, 0, os.SEEK_SET)
    size, hasher, parts = 0, hashlib.sha256(), []
    while True:
        block = os.read(fd, min(_CHUNK, before.st_size - size + 1))
        if not block:
            break
        size += len(block)
        if size > before.st_size:
            raise _unavailable()
        hasher.update(block)
        if collect:
            parts.append(block)
    if size != before.st_size or _stamp(before) != _stamp(os.fstat(fd)) or _stamp(before) != _stamp(_physical(path).stat()):
        raise _unavailable()
    return (size, hasher.hexdigest(), _stamp(before)), b''.join(parts)


def _read_resource(path):
    fd = _open(path)
    try:
        return _read(fd, path, limit=_LIMIT, collect=True)
    finally:
        os.close(fd)


def _json(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise _unavailable()
            value[key] = item
        return value
    def invalid(_):
        raise _unavailable()
    return json.loads(raw.decode('utf-8'), object_pairs_hook=unique, parse_constant=invalid)


def _sha(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def _profiles(anchor, identity):
    _, raw = _read_resource(anchor/'resources/kokoro/compatibility.json')
    root = _json(raw)
    if not isinstance(root, dict) or set(root) != {'schemaVersion', 'profiles'} or type(root['schemaVersion']) is not int or root['schemaVersion'] != 1:
        raise _unavailable()
    entries = root['profiles']
    if not isinstance(entries, list) or not 1 <= len(entries) <= 32:
        raise _unavailable()
    identities, names, selected = set(), set(), None
    base = {'profileId', 'modelBytes', 'modelSha256', 'vocabSource', 'vocabCanonicalSha256'}
    extra = {'relativePath', 'vocabBytes', 'vocabFileSha256'}
    for p in entries:
        if not isinstance(p, dict) or p.get('vocabSource') not in ('embedded', 'runtime-profile'):
            raise _unavailable()
        fields = base | (extra if p['vocabSource'] == 'runtime-profile' else set())
        if set(p) != fields or not isinstance(p['profileId'], str) or not re.fullmatch('[A-Za-z0-9_-]{1,64}', p['profileId']):
            raise _unavailable()
        if type(p['modelBytes']) is not int or p['modelBytes'] <= 0 or not _sha(p['modelSha256']) or not _sha(p['vocabCanonicalSha256']):
            raise _unavailable()
        key = (p['modelBytes'], p['modelSha256'])
        if key in identities or p['profileId'] in names:
            raise _unavailable()
        identities.add(key); names.add(p['profileId'])
        if p['vocabSource'] == 'runtime-profile':
            if p['relativePath'] != 'resources/kokoro/vocabularies/' + p['profileId'] + '.json' or type(p['vocabBytes']) is not int or not 0 < p['vocabBytes'] <= _LIMIT or not _sha(p['vocabFileSha256']):
                raise _unavailable()
        if key == identity[:2]:
            selected = p
    if selected is None:
        raise _unavailable()
    return selected


def _vocab_digest(vocab):
    if not isinstance(vocab, dict) or not 1 <= len(vocab) <= 4096:
        raise _unavailable()
    if any(not isinstance(c, str) or len(c) != 1 or type(i) is not int or i < 0 for c, i in vocab.items()) or len(set(vocab.values())) != len(vocab) or not any(vocab.values()):
        raise _unavailable()
    return hashlib.sha256(json.dumps(sorted(vocab.items()), ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()


def _runtime_vocab(anchor, profile):
    if profile['vocabSource'] == 'embedded':
        return None
    identity, raw = _read_resource(anchor/profile['relativePath'])
    if identity[:2] != (profile['vocabBytes'], profile['vocabFileSha256']):
        raise _unavailable()
    vocab = _json(raw)
    if _vocab_digest(vocab) != profile['vocabCanonicalSha256']:
        raise _unavailable()
    return vocab


def _unavailable():
    return BackendUnavailableError('tts', 'kokoro-onnx', 'TTS_RESOURCE_INVALID')


_CPU = ['CPUExecutionProvider']
_CUDA = ['CUDAExecutionProvider', 'CPUExecutionProvider']


def _session(onnxruntime, model_path):
    """CUDA first when the accelerator policy allows, else CPU; the session must
    report exactly the requested provider list, otherwise it is not trusted."""
    from . import accelerator
    if accelerator.use_cuda('tts'):
        try:
            session = onnxruntime.InferenceSession(str(model_path), providers=list(_CUDA))
            if session.get_providers() == _CUDA:
                return session, 'CUDAExecutionProvider'
        except (RuntimeError, OSError, ValueError):
            pass
        if accelerator.policy() == 'cuda':
            raise BackendUnavailableError('tts', 'kokoro-onnx', 'CUDA_REQUIRED:CUDA_SESSION_FAILED')
    session = onnxruntime.InferenceSession(str(model_path), providers=list(_CPU))
    if session.get_providers() != _CPU:
        raise _unavailable()
    return session, 'CPUExecutionProvider'


class _CpuEngine:
    _provider = 'CPUExecutionProvider'

    def __init__(self, kokoro, g, session):
        if kokoro.sess is not session or kokoro.tokenizer is not g:
            raise _unavailable()
        self._kokoro, self._g, self._session = kokoro, g, session

    def create(self, text, *, voice, speed, lang):
        with self._g.lock:
            if self._kokoro.sess is not self._session or self._kokoro.tokenizer is not self._g:
                raise _unavailable()
            result = self._kokoro.create(text, voice=voice, speed=speed, lang=lang)
            if self._kokoro.sess is not self._session or self._kokoro.tokenizer is not self._g:
                raise _unavailable()
            return result


def create_cpu_engine(model_path: Path, voices_path: Path):
    from .english_g2p import resolve_resource_anchor, resolve_english_paths, load_english_resources
    try:
        anchor = resolve_resource_anchor()
        resolve_english_paths(anchor)
        voices_fd = _open(voices_path)
        os.close(voices_fd)
        fd = _open(model_path)
        try:
            identity, _ = _read(fd, model_path)
            profile = _profiles(anchor, identity)
            runtime_vocab = _runtime_vocab(anchor, profile)
            import onnxruntime
            from voice_practice_speech_vendor.kokoro_onnx import Kokoro
            from voice_practice_speech_vendor.kokoro_onnx.session import embedded_vocab
            session, provider = _session(onnxruntime, model_path)
            after, _ = _read(fd, model_path)
            if after != identity:
                raise _unavailable()
            embedded = embedded_vocab(session)
            if embedded is not None and _vocab_digest(embedded) != profile['vocabCanonicalSha256']:
                raise _unavailable()
            vocab = embedded if profile['vocabSource'] == 'embedded' else runtime_vocab
            if vocab is None:
                raise _unavailable()
            g = load_english_resources(anchor, vocab)
            kokoro = Kokoro.from_session(session, str(voices_path), model_path=str(model_path), tokenizer=g)
            engine = _CpuEngine(kokoro, g, session)
            engine._provider = provider
            from types import MappingProxyType
            engine._profile = MappingProxyType(profile)
            engine._model_identity = identity
            return engine
        finally:
            os.close(fd)
    except (ImportError, OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
        raise _unavailable() from None
