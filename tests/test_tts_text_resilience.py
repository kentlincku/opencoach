"""TTS must not fail a whole reply because of a few unspeakable spellings (LLM output).

Cases are taken from real local-LLM replies captured during packaged-App acceptance
(2026-10-08 maintainer acceptance run).
"""
import unittest

from native.python.voice_runtime.english_g2p import preflight, speakable
from native.python.voice_runtime.text import clean_text_for_speech


class CleanerTests(unittest.TestCase):
    def test_word_slash_word_is_read_as_or(self):
        self.assertEqual(clean_text_for_speech('We take Visa/Mastercard and one/two cups.'),
                         'We take Visa or Mastercard and one or two cups.')

    def test_number_ranges_and_ratings(self):
        self.assertEqual(clean_text_for_speech('Reply in 1-2 short sentences.'), 'Reply in 1 to 2 short sentences.')
        self.assertEqual(clean_text_for_speech('I give it 5/5.'), 'I give it 5 out of 5.')

    def test_stray_markup_and_quotes_are_dropped(self):
        self.assertEqual(clean_text_for_speech("* Sure, 'I'll add it [Missing] + done."), "Sure, I'll add it Missing done.")

    def test_existing_behaviour_kept(self):
        self.assertEqual(clean_text_for_speech("That's $5.50. Yes, card is fine."), "That's $5.50. Yes, card is fine.")
        self.assertEqual(clean_text_for_speech('a well-known café'), 'a well-known cafe')


class SpeakableTests(unittest.TestCase):
    def test_number_sentence_end_before_closing_quote(self):
        for text in ['It\'s "$8.50." Next one.', 'Total $8.50." Need more.', 'Say "$5." Then stop.']:
            preflight(text)

    def test_valid_text_is_unchanged(self):
        text = "That's $5.50. Yes, card is fine."
        self.assertEqual(speakable(text), text)

    def test_unspeakable_runs_are_dropped_and_the_rest_is_spoken(self):
        out = speakable('Order 3rd-party x_y coffee now, please.')
        self.assertEqual(out, 'Order coffee now, please.')
        preflight(out)  # the result is admissible

    def test_nothing_speakable_still_fails_with_the_original_code(self):
        with self.assertRaises(Exception) as ctx:
            speakable('x_y 3rd-party')
        self.assertEqual(str(ctx.exception.args[0] if ctx.exception.args else ctx.exception), 'UNSUPPORTED_ENGLISH_TOKEN')

    def test_real_llm_replies_from_acceptance_are_all_speakable(self):
        replies = [
            "We need answer user's request: \"Hi, could I get a medium latte with oat milk, please?\" Need 1-2 short plain sentences.",
            'The user is asking about price/payment. As a barista/coach. I could say one/two lines.',
            "1.  **Analyze the User's Request:**\n    *   **Role:** Friendly English coach",
            "Rating 5/5. Great, 'I'll add it. [Missing context] + done - ok",
            "Count $8.50 if latte $5 + muffin $",
            'That will be $5.50." (2 sentences, short), ok: 1 to 2 lines.',
        ]
        for reply in replies:
            out = speakable(clean_text_for_speech(reply))
            self.assertTrue(out)
            preflight(out)


if __name__ == '__main__':
    unittest.main()
