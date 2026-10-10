import os
import unittest
from unittest.mock import patch

from tests import _private_vendor


def _missing(name):
    raise ModuleNotFoundError("No module named %r" % name, name=name)


class PrivateVendorGateTest(unittest.TestCase):
    def test_missing_vendor_skips_by_default(self):
        with patch.dict(os.environ, {}, clear=False), patch.object(_private_vendor.importlib, 'import_module', _missing):
            os.environ.pop('VPU_REQUIRE_PRIVATE_VENDOR', None)
            with self.assertRaises(unittest.SkipTest):
                _private_vendor.require_private_vendor()

    def test_missing_vendor_fails_when_required(self):
        with patch.dict(os.environ, {'VPU_REQUIRE_PRIVATE_VENDOR': '1'}), \
                patch.object(_private_vendor.importlib, 'import_module', _missing):
            with self.assertRaises(AssertionError):
                _private_vendor.require_private_vendor()

    def test_other_missing_module_is_never_skipped(self):
        def other(_name):
            raise ModuleNotFoundError("No module named 'numpy'", name='numpy')
        with patch.object(_private_vendor.importlib, 'import_module', other):
            with self.assertRaises(ModuleNotFoundError):
                _private_vendor.require_private_vendor()
