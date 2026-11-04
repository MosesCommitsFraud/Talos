"""retrieve() says why it found nothing, and doesn't hand a turn the same passage twice."""

import unittest
from unittest.mock import patch

from src import citations
from src.chat_processor import ChatProcessor, _merge_misses
from src.rag_vector import FailedSearch


def _hit(chunk_id, score=0.9, text="Hydraulic pressure calibration instructions"):
    return {
        "id": chunk_id,
        "document": f"{text} {chunk_id}.",
        "metadata": {"filename": f"{chunk_id}.pdf", "source": f"{chunk_id}.pdf"},
        "similarity": score,
        "rerank_score": score,
    }


class _Index:
    def __init__(self, results):
        self.results = results

    def search(self, query, **kwargs):
        return self.results


class RetrieveTests(unittest.TestCase):
    def setUp(self):
        cfg = patch.object(ChatProcessor, "_rag_cfg", return_value={"provider": "internal"})
        cfg.start()
        self.addCleanup(cfg.stop)
        citations.begin_turn("s1")

    def _retrieve(self, results, processor=None, session="s1"):
        processor = processor or ChatProcessor(None)
        found, block = processor.retrieve(
            "hydraulic pressure calibration", _manager=_Index(results), citation_session=session
        )
        return found, block, processor.last_miss

    def test_failed_search_is_an_engine_error(self):
        found, block, miss = self._retrieve(FailedSearch("Qdrant down"))
        self.assertEqual((found, block), ([], ""))
        self.assertEqual(miss, {"cause": "engine_error", "detail": "Qdrant down"})

    def test_empty_index_is_no_candidates(self):
        self.assertEqual(self._retrieve([])[2], {"cause": "no_candidates"})

    def test_passages_below_the_floor_are_below_threshold(self):
        _, _, miss = self._retrieve([_hit("a", 0.1), _hit("b", 0.2)])
        self.assertEqual(miss["cause"], "below_threshold")
        self.assertEqual(miss["candidates"], 2)
        self.assertEqual(miss["best_score"], 0.2)

    def test_a_good_search_leaves_no_miss(self):
        processor = ChatProcessor(None)
        self._retrieve(FailedSearch("x"), processor)
        found, _, miss = self._retrieve([_hit("a")], processor)
        self.assertEqual(len(found), 1)
        self.assertEqual(miss, {})

    def test_a_passage_comes_only_once_per_turn(self):
        _, first, _ = self._retrieve([_hit("a")])
        self.assertIn("instructions a.", first)
        found, second, _ = self._retrieve([_hit("a"), _hit("b")])
        self.assertNotIn("instructions a.", second)
        self.assertIn("instructions b.", second)
        self.assertIn("not repeated here: [1] a.pdf", second)
        self.assertEqual([s["n"] for s in found], [1, 2])

    def test_only_repeats_still_answer_with_the_numbers(self):
        self._retrieve([_hit("a")])
        found, block, miss = self._retrieve([_hit("a")])
        self.assertEqual([s["n"] for s in found], [1])
        self.assertIn("not repeated here: [1] a.pdf", block)
        self.assertNotIn("instructions a.", block)
        self.assertEqual(miss, {})

    def test_a_new_turn_gets_the_text_again(self):
        self._retrieve([_hit("a")])
        citations.begin_turn("s1")
        self.assertIn("instructions a.", self._retrieve([_hit("a")])[1])

    def test_after_compaction_the_text_comes_again(self):
        self._retrieve([_hit("a")])
        citations.forget_delivered("s1")
        self.assertIn("instructions a.", self._retrieve([_hit("a")])[1])

    def test_a_subagent_has_not_read_what_its_parent_read(self):
        self._retrieve([_hit("a")])
        token = citations.set_delivery_scope("subagent-1")
        try:
            self.assertIn("instructions a.", self._retrieve([_hit("a")])[1])
            self.assertNotIn("instructions a.", self._retrieve([_hit("a")])[1])
        finally:
            citations.reset_delivery_scope(token)
        self.assertNotIn("instructions a.", self._retrieve([_hit("a")])[1])

    def test_without_a_running_turn_nothing_is_held_back(self):
        for _ in range(2):
            self.assertIn("instructions a.", self._retrieve([_hit("a")], session=None)[1])

    def test_figures_stay_for_embedding(self):
        figure = _hit("f")
        figure["metadata"]["image_url"] = "/img/f.png"
        figure["metadata"]["modality"] = "figure"
        figure["metadata"]["synthetic_anchor"] = True
        text = _hit("a")
        with patch("src.chat_processor._pixel_gate_figures", lambda relevant, *a: relevant):
            self._retrieve([text, figure])
            _, second, _ = self._retrieve([text, figure])
        self.assertIn("/img/f.png", second)


class MergeTests(unittest.TestCase):
    def test_a_broken_search_outranks_a_miss(self):
        merged = _merge_misses(
            [{"cause": "below_threshold", "best_score": 0.2}, {"cause": "engine_error"}]
        )
        self.assertEqual(merged["cause"], "engine_error")

    def test_the_best_near_miss_is_reported(self):
        merged = _merge_misses(
            [
                {"cause": "below_threshold", "best_score": 0.1},
                {"cause": "below_threshold", "best_score": 0.2},
                {"cause": "no_candidates"},
            ]
        )
        self.assertEqual(merged["best_score"], 0.2)

    def test_nothing_to_merge_means_no_bases(self):
        self.assertEqual(_merge_misses([]), {"cause": "no_bases"})
