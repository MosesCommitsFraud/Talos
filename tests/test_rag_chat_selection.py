"""Chat base selection, using only the standard library and fake indexes."""

import os
import tempfile
import unittest
from unittest.mock import patch

from src import rag_registry
from src.chat_processor import ChatProcessor


class FakeIndex:
    def __init__(self, name):
        self.name = name
        self.calls = []

    def search(self, query, **kwargs):
        self.calls.append(kwargs)
        return [{
            "id": "same-id",
            "document": f"Hydraulic pressure calibration instructions from {self.name}.",
            "metadata": {"filename": "manual.pdf", "source": "manual.pdf"},
            "similarity": 0.9,
            "rerank_score": 0.9,
        }]


class ChatSelectionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        env = patch.dict(os.environ, RAG_DATA_DIR=self.directory.name)
        env.start()
        self.addCleanup(env.stop)
        cfg = patch.object(ChatProcessor, "_rag_cfg", return_value={"provider": "internal"})
        cfg.start()
        self.addCleanup(cfg.stop)
        self.indexes = {key: FakeIndex(key) for key in ("default", "manuals")}
        getter = patch("src.rag_singleton.get_rag_manager", side_effect=self.indexes.get)
        getter.start()
        self.addCleanup(getter.stop)
        rag_registry.create_base("Manuals")

    def retrieve(self):
        return ChatProcessor(None).retrieve("hydraulic pressure calibration")

    def test_legacy_default_and_persisted_switch(self):
        self.assertTrue(rag_registry.chat_enabled(rag_registry.get_base("default")))
        self.assertFalse(rag_registry.chat_enabled(rag_registry.get_base("manuals")))
        sources, _ = self.retrieve()
        self.assertEqual([s["rag_id"] for s in sources], ["default"])
        rag_registry.update_base("default", chat_enabled=False)
        rag_registry.update_base("manuals", chat_enabled=True)
        sources, _ = self.retrieve()
        self.assertEqual([s["rag_id"] for s in sources], ["manuals"])
        self.assertTrue(rag_registry.describe(rag_registry.get_base("manuals"), with_counts=False)["chat_enabled"])
        self.assertEqual(len(self.indexes["default"].calls), 1)

    def test_all_off_does_not_fall_back_to_cached_manager(self):
        rag_registry.update_base("default", chat_enabled=False)
        processor = ChatProcessor(type("Docs", (), {"rag_manager": self.indexes["default"]})())
        self.assertEqual(processor.retrieve("hydraulic pressure"), ([], ""))
        self.assertFalse(self.indexes["default"].calls)

    def test_multiple_bases_keep_provenance_and_sql_exclusion(self):
        rag_registry.update_base("manuals", chat_enabled=True)
        sources, content = self.retrieve()
        self.assertEqual({s["rag_id"] for s in sources}, {"default", "manuals"})
        self.assertEqual(len({s["_id"] for s in sources}), 2)
        self.assertIn("Knowledge base: Manuals", content)
        self.assertLessEqual(len(content), 10000)
        for index in self.indexes.values():
            self.assertEqual(index.calls[0]["exclude_scopes"], ["sql"])

    def test_unavailable_base_does_not_hide_other_results(self):
        rag_registry.update_base("manuals", chat_enabled=True)
        self.indexes["default"] = None
        sources, _ = self.retrieve()
        self.assertEqual([s["rag_id"] for s in sources], ["manuals"])

    def test_each_base_uses_its_own_relevance_threshold(self):
        rag_registry.update_base("manuals", chat_enabled=True)

        def config(processor):
            return {"rerank_min_score": 0.95 if processor.rag_base_id == "manuals" else 0.3}

        with patch.object(ChatProcessor, "_rag_cfg", config):
            sources, _ = self.retrieve()
        self.assertEqual([s["rag_id"] for s in sources], ["default"])
        self.assertTrue(self.indexes["manuals"].calls)

    def test_small_budget_and_prefix(self):
        sources, content = ChatProcessor(None).retrieve(
            "hydraulic pressure calibration", max_chars=500, prefix="Reference material"
        )
        self.assertTrue(sources)
        self.assertTrue(content.startswith("Reference material\n\n"))
        self.assertLessEqual(len(content), 500)


if __name__ == "__main__":
    unittest.main()
