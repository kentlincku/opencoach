"""Portable real M/I/regex/addict lane. Only NLP, dictionaries and vocab synthetic."""
import importlib
import importlib.util
import json
import re
import string
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import inflect
from native.python.voice_runtime.english_numbers import EnglishNumberFormatter
from tests._private_vendor import require_private_vendor
from native.python.voice_runtime.text import clean_text_for_speech
from native.python.voice_runtime.backends.base import BackendInputError, BackendUnavailableError

MODULE = 'native.python.voice_runtime.english_g2p'
NUMBER_WORDS = '''zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion trillion zeroth first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth thirtieth fortieth fiftieth sixtieth seventieth eightieth ninetieth hundredth thousandth millionth billionth trillionth oh point minus plus and dollar dollars cent cents pound pounds penny pence euro euros'''.split()

class OffsetNLP:
    """Deliberately splits signs/numbers; genuine M must reconstruct protected spans."""
    pipe_names = ['tok2vec', 'tagger']
    def __call__(self, text):
        matches = list(re.finditer(r"[A-Za-z]+(?:'[A-Za-z]+)*|[0-9]+|[^\w\s]|[^\x00-\x7f]+", text))
        result = []
        for i, m in enumerate(matches):
            end = matches[i+1].start() if i+1 < len(matches) else len(text)
            gap = text[m.end():end]
            result.append(SimpleNamespace(idx=m.start(), text=m.group(), whitespace_=gap,
                                          tag_='NN' if m.group()[0].isalpha() else 'CD' if m.group().isdigit() else '.'))
        return result

class EnglishResourceTest(unittest.TestCase):
    def test_physical_frozen_anchor_not_meipass_or_source_file(self):
        import sys
        require_private_vendor()
        import voice_practice_speech_vendor as vendor
        module=importlib.import_module(MODULE)
        with tempfile.TemporaryDirectory(prefix='resource-v3b-') as tmp:
            root=Path(tmp); anchor=root/'_internal/voice_practice_speech_vendor'
            anchor.mkdir(parents=True)
            # Frozen code can live in PYZ: __file__ identifies location, need not exist.
            with patch('importlib.resources.files',return_value=anchor), patch.object(vendor,'__file__',str(anchor/'__init__.pyc')), patch.object(sys,'frozen',True,create=True), patch.object(sys,'executable',str(root/'voice-runtime.exe')), patch.object(sys,'_MEIPASS','/not-authority',create=True):
                self.assertEqual(module.resolve_resource_anchor(),anchor)
                with patch.object(vendor,'__file__',str(root/'wrong/__init__.py')):
                    with self.assertRaises(BackendUnavailableError):
                        module.resolve_resource_anchor()
                with patch.object(sys,'executable',str(root/'other/voice-runtime.exe')):
                    with self.assertRaises(BackendUnavailableError):
                        module.resolve_resource_anchor()
                with patch('importlib.resources.files',return_value=SimpleNamespace()):
                    with self.assertRaises(BackendUnavailableError):
                        module.resolve_resource_anchor()
            with patch('importlib.resources.files',return_value=anchor), patch.object(vendor,'__file__',str(anchor/'__init__.py')), patch.object(sys,'frozen',False,create=True):
                self.assertEqual(module.resolve_resource_anchor(),anchor)
                link=root/'link'
                try:
                    link.symlink_to(anchor,target_is_directory=True)
                except OSError as e:
                    if getattr(e, 'winerror', None) == 1314 or getattr(e, 'errno', 0) in (1, 13):
                        self.skipTest('creating directory symlink requires elevated privilege or Developer Mode on Windows')
                    raise
                with patch('importlib.resources.files',return_value=link), patch.object(vendor,'__file__',str(link/'__init__.py')):
                    with self.assertRaises(BackendUnavailableError):
                        module.resolve_resource_anchor()

    def test_owned_loader_missing_layout_and_symlink_rejected(self):
        from tests.test_onnx_engine import SyntheticResources
        from native.python.voice_runtime.onnx_engine import create_cpu_engine
        from contextlib import closing
        with tempfile.TemporaryDirectory(prefix='resource-v3b-') as tmp, closing(SyntheticResources(Path(tmp))) as f:
            files=['resources/misaki/en/us_gold.json','resources/misaki/en/us_silver.json',
                   'resources/spacy/en_core_web_sm-3.8.0/meta.json','resources/spacy/en_core_web_sm-3.8.0/config.cfg',
                   'resources/spacy/en_core_web_sm-3.8.0/tokenizer','resources/spacy/en_core_web_sm-3.8.0/tok2vec/model',
                   'resources/spacy/en_core_web_sm-3.8.0/tagger/model','resources/spacy/en_core_web_sm-3.8.0/vocab/strings.json']
            for name in files:
                path=f.root/name; raw=path.read_bytes(); path.unlink()
                with self.subTest(missing=name),f.boundaries(),self.assertRaises(BackendUnavailableError):
                    create_cpu_engine(f.model,f.voices)
                f.session_factory.assert_not_called(); f.nlp_loader.assert_not_called()
                path.write_bytes(raw)
            source=f.root/files[0]; alias=source.with_suffix('.alias'); source.rename(alias)
            try:
                try:
                    source.symlink_to(alias)
                except OSError as e:
                    if getattr(e, 'winerror', None) == 1314 or getattr(e, 'errno', 0) in (1, 13):
                        self.skipTest('creating file symlink requires elevated privilege or Developer Mode on Windows')
                    raise
                with f.boundaries(),self.assertRaises(BackendUnavailableError):
                    create_cpu_engine(f.model,f.voices)
                f.session_factory.assert_not_called()
            finally:
                if source.is_symlink() or source.exists():
                    source.unlink()
                if alias.exists():
                    alias.rename(source)
            f.nlp_loader.return_value=SimpleNamespace(pipe_names=['tagger'])
            with f.boundaries(),self.assertRaises(BackendUnavailableError):
                create_cpu_engine(f.model,f.voices)
            f.session.run.assert_not_called()


class EnglishG2PTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='english-v2-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        # Distinguishable consonant-only toy phonemes, not pronunciation evidence.
        self.gold = {w:'n'+'k'*i for i,w in enumerate(NUMBER_WORDS,1)}
        self.gold.update({c:'b'+'d'*i for i,c in enumerate(string.ascii_uppercase,1)})
        self.gold.update({'hello':'həlˈO', 'world':'wɜɹld', 'Known':'nOn'})
        self.paths = (self.root/'gold.json', self.root/'silver.json')
        self.vocab = {c:i for i,c in enumerate('AIOWYbdfhijklmnpstuvwzæðŋɑɔəɛɜɡɪɹɾʃʊʌʒʤʧˈˌθᵊᵻʔT ,.!?;:—“”()',1)}
        self.vocab['<pad>'] = 0
        # Padding is a single CHARACTER entry, not a multi-character alias.
        self.vocab['~'] = self.vocab.pop('<pad>')

    def adapter(self, nlp=None):
        require_private_vendor()
        self.assertIsNotNone(importlib.util.find_spec(MODULE), 'G2P adapter behavior not implemented')
        self.paths[0].write_text(json.dumps(self.gold))
        self.paths[1].write_text('{}')
        return importlib.import_module(MODULE).EnglishG2PAdapter(
            nlp=nlp or OffsetNLP(), formatter=EnglishNumberFormatter(engine=inflect.engine()),
            lexicon_paths=self.paths, vocab=self.vocab)

    def test_cleaner_real_misaki_number_lookup_to_strict_ids(self):
        g = self.adapter()
        from voice_practice_speech_vendor.misaki.en import G2P
        self.assertIsInstance(g._g2p, G2P)
        with patch.object(g._g2p.lexicon, 'lookup', wraps=g._g2p.lexicon.lookup) as lookup:
            ps = g.phonemize(clean_text_for_speech('-0.00'))
        self.assertEqual([c.args[0] for c in lookup.call_args_list], ['minus','zero','point','zero','zero'])
        self.assertEqual(ps, ' '.join(self.gold[w] for w in ['minus','zero','point','zero','zero']))
        self.assertEqual(g.known(ps), ps)
        self.assertEqual(g.tokenize(ps, limit=None), [self.vocab[c] for c in ps])

    def test_numeric_table_real_lookup_and_private_nonhead_controls(self):
        g = self.adapter()
        table = {'123':'one hundred twenty three','12345':'twelve thousand three hundred forty five','21st':'twenty first','0th':'zeroth','1905':'nineteen oh five','2001':'two thousand one','2024':'twenty twenty four','2100':'two thousand one hundred','0999':'zero nine nine nine','-2024':'minus two thousand twenty four','-0':'minus zero','1.2300':'one point two three zero zero','.25':'point two five','+0.5':'plus zero point five','$1.25':'one dollar and twenty five cents','$0.25':'twenty five cents','-$0.25':'minus twenty five cents','$2.00':'two dollars','$1.2':'one dollar and twenty cents','£2.01':'two pounds and one penny','€2.02':'two euros and two cents','0.123456789012345678':'zero point one two three four five six seven eight nine zero one two three four five six seven eight'}
        for value, words in table.items():
            with self.subTest(value=value), patch.object(g._g2p.lexicon, 'lookup', wraps=g._g2p.lexicon.lookup) as lookup:
                ps = g.phonemize(clean_text_for_speech(value))
                # M resolves tokens right-to-left for context: plus is a separate token.
                lookup_words = words.split()[1:] + ['plus'] if value.startswith('+') else words.split()
                self.assertEqual([c.args[0] for c in lookup.call_args_list], lookup_words)
                self.assertEqual(ps, ' '.join(self.gold[w] for w in words.split()))
                self.assertEqual(len(g.tokenize(ps, limit=None)), len(ps))
        for value, words in {'007':'zero zero seven','105':'one oh five','120':'one twenty','100':'one hundred','1.02':'one zero two','2024':'twenty twenty four'}.items():
            with self.subTest(nonhead=value), patch.object(g._g2p.lexicon, 'lookup', wraps=g._g2p.lexicon.lookup) as lookup:
                g._g2p.lexicon.get_number(value, None, False, '')
                self.assertEqual([c.args[0] for c in lookup.call_args_list], words.split())
        with self.assertRaisesRegex(ValueError, 'UNSUPPORTED_ENGLISH_NUMBER'):
            g._g2p.lexicon.get_number('123', None, True, 'a')
        ps = g._g2p.lexicon.get_number('1.2.3', None, True, '')[0]
        self.assertEqual(ps, ' '.join(self.gold[w] for w in ['one','two','three']))

    def test_identifiers_and_pure_preflight_reserved_numeric_errors(self):
        g = self.adapter()
        preflight = getattr(importlib.import_module(MODULE), 'preflight', None)
        self.assertTrue(callable(preflight), 'pure preflight behavior missing')
        for value in ['5G','RTX4070','R2D2','x2y','AB007','E5']:
            with self.subTest(value=value):
                plan = preflight(value)
                self.assertEqual(plan.identifier_spans, ((0,len(value),value),))
                ps = g.phonemize(value)
                expected = []
                for c in value:
                    expected.append(self.gold[c.upper()] if c.isalpha() else self.gold[g.formatter.digits(c)])
                self.assertEqual(ps, ' '.join(expected))
                self.assertEqual(g.last_spelling_events, ((value,'identifier'),))
        errors = {'11st':'UNSUPPORTED_ENGLISH_NUMBER','21st2':'UNSUPPORTED_ENGLISH_NUMBER','1e7':'UNSUPPORTED_ENGLISH_NUMBER','1e-7':'UNSUPPORTED_ENGLISH_NUMBER','1e+7':'UNSUPPORTED_ENGLISH_NUMBER','1e':'UNSUPPORTED_ENGLISH_NUMBER','1e+':'UNSUPPORTED_ENGLISH_NUMBER','1.2e7':'UNSUPPORTED_ENGLISH_NUMBER','−0.5':'UNSUPPORTED_ENGLISH_NUMBER','1.2.3':'UNSUPPORTED_ENGLISH_NUMBER','$1.234':'UNSUPPORTED_ENGLISH_NUMBER','$-1':'UNSUPPORTED_ENGLISH_NUMBER','--1':'UNSUPPORTED_ENGLISH_NUMBER','-1st':'UNSUPPORTED_ENGLISH_NUMBER','123s':'UNSUPPORTED_ENGLISH_NUMBER','123ing':'UNSUPPORTED_ENGLISH_NUMBER','1'*16:'ENGLISH_NUMBER_LIMIT','0.'+'1'*19:'ENGLISH_NUMBER_LIMIT','R'+'1'*19:'ENGLISH_NUMBER_LIMIT','R'*64+'1':'ENGLISH_SPELLING_LIMIT'}
        for value, code in errors.items():
            with self.subTest(value=value), self.assertRaisesRegex(BackendInputError, '^'+code+'$'):
                preflight(value)
        with self.assertRaisesRegex(BackendInputError, 'INVALID_TEXT_LENGTH'):
            preflight('a'*5001)
        self.assertEqual(preflight('1.').number_spans, ((0,1,'1',None,False),))
        with self.assertRaisesRegex(BackendInputError, 'UNSUPPORTED_ENGLISH_NUMBER'):
            preflight('1. hello')
        # Sentence-final number followed by a new sentence (typical LLM reply).
        self.assertEqual(preflight("That's $5.50. Yes, we take cards.").number_spans, ((7,12,'5.50','$',False),))
        self.assertEqual(preflight('It costs 5. Thanks!').number_spans, ((9,10,'5',None,False),))

    def test_unknown_ascii_atomic_hyphen_known_context_and_trace_reset(self):
        g = self.adapter()
        self.assertEqual(g.phonemize('hello world'), 'həlˈO wɜɹld')
        self.assertEqual(g.last_spelling_events, ())
        for text in ['Zorvex', 'ZZ', 'Zorvex-Luma']:
            with self.subTest(text=text):
                ps = g.phonemize(text)
                self.assertTrue(ps)
                events = g.last_spelling_events
                self.assertEqual(sorted(e[0] for e in events), sorted(text.split('-')))
                self.assertTrue(all(e[1] == 'spelled' for e in events))
                self.assertEqual(len(g.tokenize(ps, limit=None)), len(ps))
        g.phonemize('hello')
        self.assertEqual(g.last_spelling_events, ())
        for text, code in [('café','UNSUPPORTED_ENGLISH_TOKEN'), ('Ｈello','UNSUPPORTED_ENGLISH_TOKEN'), ('foo_bar','UNSUPPORTED_ENGLISH_TOKEN'), ("qzx'foo",'UNSUPPORTED_ENGLISH_TOKEN'), ('Zorvex--Luma','UNSUPPORTED_ENGLISH_TOKEN'), ('-Zorvex','UNSUPPORTED_ENGLISH_TOKEN'), ('Zorvex-','UNSUPPORTED_ENGLISH_TOKEN'), ('Z'*65,'ENGLISH_SPELLING_LIMIT'), (' '.join(['Z'*64]*4+['R2']),'ENGLISH_SPELLING_LIMIT')]:
            with self.subTest(text=text), self.assertRaisesRegex(BackendInputError, '^'+code+'$'):
                g.phonemize(text)
        g.phonemize('R2')
        self.assertEqual(g.last_spelling_events, (('R2','identifier'),))

    def test_resource_gate_and_zero_padding_strict_whole_utterance(self):
        for key, value in [('A',None), ('Q',{}), ('B',{'DEFAULT':None}), ('C',{'DEFAULT':12}), ('zero',''), ('oh',None), ('trillionth',{'DEFAULT':'n', 'NOUN':None})]:
            old = self.gold[key]
            with self.subTest(key=key), self.assertRaises(BackendUnavailableError):
                if value is None:
                    del self.gold[key]
                else:
                    self.gold[key] = value
                self.adapter()
            self.gold[key] = old
        old = self.vocab.copy()
        for vocab in [{}, {'x':0}, {'x':True}, {'x':-1}, {'x':1,'y':1}, {'bad':1}, {**old,'~':2}, {c:i for c,i in old.items() if c != 'b'}]:
            self.vocab = vocab
            with self.subTest(vocab_size=len(vocab)), self.assertRaises(BackendUnavailableError):
                self.adapter()
        self.vocab = old
        g = self.adapter()
        for ps in ['h~','h❓','h' * 600 + '❓']:
            with self.subTest(ps_length=len(ps)), self.assertRaises(BackendUnavailableError):
                g.tokenize(ps, limit=None)
        self.assertEqual(g.known('  h  '), '  h  ')
        self.assertEqual(len(g.tokenize('h'*511, limit=None)), 511)
        with self.assertRaises(BackendInputError):
            g.tokenize('h'*511)
        # Whole-utterance checks happen before a caller could infer an early chunk.
        with patch.object(type(g._g2p), '__call__', return_value=('h'*600+'❓', [])):
            with self.assertRaises(BackendUnavailableError):
                g.phonemize('hello')

    def test_actual_m_rejects_malformed_or_overlapping_spans(self):
        g = self.adapter()
        for numbers, identifiers in [(((0,2,'2',None,False),),()), (((0,2,'12',None,False),),((0,2,'R2'),)), ((),((0,2,'Q2'),)), ((),((True,2,'R2'),))]:
            with self.subTest(numbers=numbers, identifiers=identifiers), self.assertRaisesRegex(ValueError, 'ENGLISH_SPAN_INVALID'):
                g._g2p('R2', number_spans=numbers, identifier_spans=identifiers)
        class BrokenOffsets(OffsetNLP):
            def __call__(self, text):
                doc = super().__call__(text)
                doc[0].idx = 1
                return doc
        g = self.adapter(BrokenOffsets())
        with self.assertRaises(BackendInputError):
            g.phonemize('-0.25')

    def test_known_dotted_and_uppercase_silver_before_spelling_real_caller(self):
        class WholeNLP(OffsetNLP):
            def __call__(self, text):
                return [SimpleNamespace(idx=0, text=text, whitespace_='', tag_='NNP')]
        self.gold['U.S.A.'] = {'DEFAULT':'nOn','NOUN':'wɜɹld'}
        self.gold['NASA'] = 'nOn'
        g = self.adapter(WholeNLP())
        self.assertEqual(g.phonemize('U.S.A.'), 'wˈɜɹld')
        self.assertEqual(g.last_spelling_events, ())
        g._g2p.lexicon.silvers['NASA'] = g._g2p.lexicon.golds.pop('NASA')
        self.assertEqual(g.phonemize('NASA'), 'nˈOn')
        self.assertEqual(g.last_spelling_events, ())
        del g._g2p.lexicon.golds['U.S.A.']
        ps = g.phonemize('U.S.A.')
        self.assertEqual(ps, ' '.join(self.gold[c] for c in 'USA'))
        self.assertEqual(g.last_spelling_events, (('U.S.A.', 'spelled'),))
        self.assertEqual(g._letter_count, 3)

    def test_dotted_trace_does_not_take_known_same_letters_source(self):
        class AtomicNLP(OffsetNLP):
            def __call__(self, text):
                matches = list(re.finditer(r'\S+', text))
                return [SimpleNamespace(idx=m.start(), text=m.group(), tag_='NNP',
                        whitespace_=text[m.end():matches[i+1].start()] if i+1 < len(matches) else '')
                        for i,m in enumerate(matches)]
        for known, unknown in [('U.S.A.', 'USA'), ('USA', 'U.S.A.')]:
            with self.subTest(known=known, unknown=unknown):
                self.gold.pop('U.S.A.', None)
                self.gold.pop('USA', None)
                self.gold[known] = 'nOn'
                g = self.adapter(AtomicNLP())
                spelled = ' '.join(self.gold[c] for c in 'USA')
                self.assertEqual(g.phonemize(unknown+' '+known), spelled+' nˈOn')
                self.assertEqual(g.last_spelling_events, ((unknown, 'spelled'),))
                self.assertEqual(g._letter_count, 3)
                g.phonemize(known)
                self.assertEqual(g.last_spelling_events, ())

    def test_ordinary_coverage_whitespace_punctuation_and_dictionary_compound(self):
        self.gold['hello-world'] = 'nOn'
        g = self.adapter()
        for text, expected in [('  hello,\tworld!  ', 'həlˈO, wɜɹld!'),
                               ('hello-world', 'həlˈOwɜɹld')]:
            with self.subTest(text=text):
                self.assertEqual(g.phonemize(text), expected)
                self.assertEqual(g.last_spelling_events, ())
        class CompoundNLP(OffsetNLP):
            def __call__(self, text):
                return [SimpleNamespace(idx=0, text=text, whitespace_='', tag_='NN')]
        # Whole compound token is an explicit fixture, not a spaCy claim.
        compound = self.adapter(CompoundNLP())
        self.assertEqual(compound.phonemize('hello-world'), 'nOn')
        self.assertEqual(compound.last_spelling_events, ())
        from voice_practice_speech_vendor.misaki.token import MToken
        def token(text, ps, ws=''):
            return MToken(text=text, tag='NN', whitespace=ws, phonemes=ps)
        cases = [
            ('hello world', 'h', [token('hello', 'h')]),
            ('hello world', 'h ', [token('hello', 'h', ' '), token('world', '')]),
            ('hello world', 'w h', [token('world', 'w', ' '), token('hello', 'h')]),
            ('hello-world world', 'n', [token('hello-world', 'n')]),
            ('hello-world world', 'n ', [token('hello-world', 'n', ' '), token('', '')]),
        ]
        for text, ps, tokens in cases:
            with self.subTest(text=text, tokens=[t.text for t in tokens]), patch.object(type(g._g2p), '__call__', return_value=(ps,tokens)), self.assertRaises(BackendUnavailableError):
                g.phonemize(text)

    def test_coverage_no_empty_success_and_normalization(self):
        g = self.adapter()
        from voice_practice_speech_vendor.misaki.token import MToken
        # A faulty dependency cannot forge success by returning only known phonemes.
        for ps, tokens in [('h', []), ('', [MToken(text='hello',tag='NN',whitespace='',phonemes='')]), ('h', [MToken(text='world',tag='NN',whitespace='',phonemes='h')])]:
            with self.subTest(ps=ps), patch.object(type(g._g2p), '__call__', return_value=(ps,tokens)), self.assertRaises(BackendUnavailableError):
                g.phonemize('hello')
        self.gold['tap'] = 'ɾʔ'
        g = self.adapter()
        self.assertEqual(g.phonemize('tap'), 'Tt')
        with self.assertRaises(BackendInputError):
            g.phonemize('hello', lang='en-gb')
        with self.assertRaises(BackendInputError):
            g.phonemize('hello', norm=False)
        with self.assertRaises(BackendInputError):
            g.render_identifier('R2')

    def test_full_g2p_serialization_instance_ownership(self):
        import threading
        from concurrent.futures import ThreadPoolExecutor
        entered, release, second = threading.Event(), threading.Event(), threading.Event()
        class BlockingNLP(OffsetNLP):
            calls = 0
            def __call__(self, text):
                self.calls += 1
                if self.calls == 1:
                    entered.set()
                    if not release.wait(2):
                        raise AssertionError('release missing')
                else:
                    second.set()
                return super().__call__(text)
        g = self.adapter(BlockingNLP())
        other = self.adapter()
        self.assertIsNot(g.lock, other.lock)
        self.assertIsNot(g.formatter.engine, other.formatter.engine)
        self.assertIsNot(g._g2p.nlp, other._g2p.nlp)
        with ThreadPoolExecutor(max_workers=2) as pool:
            a = pool.submit(g.phonemize, 'R2')
            self.assertTrue(entered.wait(2))
            b = pool.submit(g.phonemize, 'hello')
            try:
                self.assertFalse(second.wait(0.05))
            finally:
                release.set()
            self.assertTrue(a.result())
            self.assertEqual(b.result(), 'həlˈO')
        self.assertEqual(g.last_spelling_events, ())
        self.assertIs(g.lock, g.formatter.lock)

if __name__ == '__main__':
    unittest.main()
