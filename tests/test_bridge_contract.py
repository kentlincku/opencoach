import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class NativeBridgeContractTests(unittest.TestCase):
    def setUp(self):
        self.contract_path = ROOT / "contracts" / "native-bridge-protocol.json"
        self.assertTrue(self.contract_path.is_file(), "native-bridge-protocol.json must exist")
        self.contract = json.loads(self.contract_path.read_text(encoding="utf-8"))

    def test_schema_structure_and_constraints(self):
        self.assertEqual(self.contract.get("type"), "object")
        self.assertFalse(self.contract.get("additionalProperties", True))
        required = set(self.contract.get("required", []))
        self.assertIn("id", required)
        self.assertIn("operation", required)

        operations = self.contract["properties"]["operation"]["enum"]
        self.assertEqual(
            set(operations),
            {"models", "chat", "credential.has", "credential.set", "credential.clear"},
        )

    def test_contract_forbids_unsafe_capabilities(self):
        forbidden_properties = {
            "url", "headers", "method", "filesystem", "shell", "exec",
            "eval", "cookies", "redirect", "token", "rawRequest",
        }
        properties = set(self.contract["properties"].keys())
        self.assertTrue(properties.isdisjoint(forbidden_properties))

    def test_message_schema_bounded(self):
        messages = self.contract["properties"]["messages"]
        self.assertEqual(messages.get("type"), "array")
        self.assertEqual(messages.get("maxItems"), 100)
        items = messages.get("items", {})
        self.assertFalse(items.get("additionalProperties", True))
        self.assertEqual(set(items.get("required", [])), {"role", "content"})
        roles = items["properties"]["role"]["enum"]
        self.assertEqual(set(roles), {"system", "user", "assistant"})
        self.assertEqual(items["properties"]["content"].get("maxLength"), 32000)

    def test_id_schema_bounded(self):
        id_prop = self.contract["properties"]["id"]
        self.assertEqual(id_prop.get("minLength"), 1)
        self.assertEqual(id_prop.get("maxLength"), 128)


if __name__ == "__main__":
    unittest.main()
