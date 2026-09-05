import unittest

from native.python.voice_runtime.text import clean_text_for_speech


class SpeechTextPolicyTest(unittest.TestCase):
    def test_native_tts_removes_cjk_characters(self):
        self.assertEqual(clean_text_for_speech("Hello 你好，how are you？"), "Hello, how are you?")
        self.assertEqual(clean_text_for_speech("這是一段中文。"), "")


if __name__ == "__main__":
    unittest.main()
