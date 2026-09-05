import unittest
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "native" / "python"))

from num2words import num2words


class Num2WordsTests(unittest.TestCase):
    def test_cardinal_integers(self):
        self.assertEqual(num2words(0), "zero")
        self.assertEqual(num2words(1), "one")
        self.assertEqual(num2words(14), "fourteen")
        self.assertEqual(num2words(42), "forty-two")
        self.assertEqual(num2words(100), "one hundred")
        self.assertEqual(num2words(105), "one hundred five")
        self.assertEqual(num2words(1999), "one thousand nine hundred ninety-nine")
        self.assertEqual(num2words(1000000), "one million")

    def test_ordinals(self):
        self.assertEqual(num2words(1, to="ordinal"), "first")
        self.assertEqual(num2words(2, to="ordinal"), "second")
        self.assertEqual(num2words(3, to="ordinal"), "third")
        self.assertEqual(num2words(21, to="ordinal"), "twenty-first")
        self.assertEqual(num2words(50, to="ordinal"), "fiftieth")

    def test_years(self):
        self.assertEqual(num2words(1999, to="year"), "nineteen ninety-nine")
        self.assertEqual(num2words(2024, to="year"), "twenty twenty-four")

    def test_floats_and_strings(self):
        self.assertEqual(num2words("42"), "forty-two")
        self.assertIn("point", num2words(3.14))
        self.assertEqual(num2words(-5), "minus five")


if __name__ == "__main__":
    unittest.main()
