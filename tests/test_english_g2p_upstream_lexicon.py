"""Regression: real upstream misaki lexicon shapes must be admitted (R56)."""
import unittest
from voice_runtime.english_g2p import EnglishG2PAdapter

class _Probe(EnglishG2PAdapter):
    def __init__(self): self.seen = []
    def known(self, ps): self.seen.append(ps)

class UpstreamLexiconShapes(unittest.TestCase):
    def test_tagged_none_variant_is_admitted(self):
        p = _Probe(); p._resource_entry({'DEFAULT': 'ˈæd', 'NOUN': None}); self.assertEqual(set(p.seen), {'ˈæd'})
    def test_missing_default_rejected(self):
        with self.assertRaises(Exception): _Probe()._resource_entry({'NOUN': 'ˈæd'})
    def test_empty_variant_rejected(self):
        with self.assertRaises(Exception): _Probe()._resource_entry({'DEFAULT': 'ˈæd', 'NOUN': ' '})
    def test_non_string_tag_rejected(self):
        with self.assertRaises(Exception): _Probe()._resource_entry({'DEFAULT': 'ˈæd', 1: 'x'})

if __name__ == '__main__': unittest.main()
