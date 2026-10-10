"""Actual inflect 7.5.0 lane, not a substitute number implementation."""
import importlib
import importlib.util
import unittest
import inflect

MODULE = 'native.python.voice_runtime.english_numbers'

class EnglishNumbersTest(unittest.TestCase):
    def formatter(self, engine=None):
        self.assertIsNotNone(importlib.util.find_spec(MODULE), 'bounded formatter behavior not implemented')
        return importlib.import_module(MODULE).EnglishNumberFormatter(engine=engine or inflect.engine())

    def test_real_cardinal_and_ordinal(self):
        f = self.formatter()
        self.assertEqual(f.cardinal('123'), 'one hundred twenty three')
        self.assertEqual(f.cardinal('007'), 'seven')
        self.assertEqual(f.ordinal('21'), 'twenty first')
        self.assertEqual(f.ordinal('0'), 'zeroth')

    def test_year_decimal_digits_finite_policy(self):
        f = self.formatter()
        for method in ('year', 'decimal', 'digits'):
            self.assertTrue(callable(getattr(f, method, None)), method + ' behavior missing')
        for value, words in {'1000':'one thousand', '1900':'nineteen hundred', '1905':'nineteen oh five', '1999':'nineteen ninety nine', '2000':'two thousand', '2001':'two thousand one', '2009':'two thousand nine', '2010':'twenty ten', '2024':'twenty twenty four', '2100':'two thousand one hundred', '0999':'zero nine nine nine'}.items():
            with self.subTest(year=value):
                self.assertEqual(f.year(value), words)
        for value, words in {'0.50':'zero point five zero', '.50':'point five zero', '1.2300':'one point two three zero zero', '0.123456789012345678':'zero point one two three four five six seven eight nine zero one two three four five six seven eight'}.items():
            self.assertEqual(f.decimal(value), words)
        self.assertEqual(f.digits('007'), 'zero zero seven')

    def test_validation_precedes_engine_and_exact_kwargs(self):
        from native.python.voice_runtime.backends.base import BackendInputError, BackendExecutionError
        from unittest.mock import Mock
        # A spy wraps the REAL engine; a failure double is only for error injection.
        spy = Mock(wraps=inflect.engine())
        f = self.formatter(spy)
        f.cardinal('123')
        spy.number_to_words.assert_called_once_with('123', group=0, andword='', comma='', threshold=None)
        for method, values in {'cardinal':[1, True, 1.5, '-0', '+1', ' 1', '1e7', '１２', '1'*16], 'ordinal':['-1', '21st', '1'*16], 'year':['123', '12345', '-123'], 'decimal':['1.', '1.2.3', '-0.0', '0.'+'1'*19, '1'*16+'.2'], 'digits':['1'*19, '-0']}.items():
            for value in values:
                with self.subTest(method=method, value=value), self.assertRaises(BackendInputError):
                    getattr(f, method)(value)
        self.assertEqual(spy.number_to_words.call_count, 1)
        for output in (None, '', 'One', 'one 2', 'one/zero'):
            broken = Mock(); broken.number_to_words.return_value = output
            with self.assertRaises(BackendExecutionError):
                self.formatter(broken).cardinal('1')
        broken.number_to_words.side_effect = RuntimeError('private dependency details')
        with self.assertRaisesRegex(BackendExecutionError, '^BACKEND_ERROR:tts:kokoro-onnx$'):
            self.formatter(broken).cardinal('1')
        self.assertEqual(f.cardinal('100000000000000'), 'one hundred trillion')
        self.assertEqual(len(f.digits('0'*18).split()), 18)

if __name__ == '__main__':
    unittest.main()
