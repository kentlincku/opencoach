"""Skip helper for tests that need the private speech vendor bundle.

Only an import failure of ``voice_practice_speech_vendor`` itself becomes a skip.
If the vendor is installed, every test runs and any failure still counts.

Set VPU_REQUIRE_PRIVATE_VENDOR=1 in packaging and release CI: a missing vendor is
then a hard failure instead of a skip.
"""
import importlib
import os
import unittest

VENDOR = 'voice_practice_speech_vendor'
SKIP_REASON = 'private vendor bundle not installed'


def require_private_vendor():
    try:
        importlib.import_module(VENDOR)
    except ModuleNotFoundError as error:
        if error.name == VENDOR:
            if os.environ.get('VPU_REQUIRE_PRIVATE_VENDOR') == '1':
                raise AssertionError(
                    'VPU_REQUIRE_PRIVATE_VENDOR=1 but private vendor bundle not installed') from error
            raise unittest.SkipTest(SKIP_REASON) from error
        raise
