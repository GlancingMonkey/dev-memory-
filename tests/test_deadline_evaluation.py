import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from rag.experiments.deadline_eval.evaluate import retrieval_summary, generation_summary
from rag.experiments.deadline_eval.measure import trial
from rag.experiments.deadline_eval.seed import DATA, FIELDS, bind_samples


class DeadlineEvaluationTests(unittest.TestCase):
    def test_retrieval_denominators_keep_unsupported_questions_separate(self):
        rows = [
            {"expected_ids": [1], "rank": 1, "results": [{}], "seconds": 1},
            {"expected_ids": [2], "rank": 3, "results": [{}], "seconds": 2},
            {"expected_ids": [3], "rank": None, "results": [{}], "seconds": 3},
            {"expected_ids": [], "rank": None, "results": [{}], "seconds": 4},
            {"expected_ids": [], "rank": None, "results": [], "seconds": 5},
        ]
        summary = retrieval_summary(rows)
        self.assertEqual(summary["answerable_questions"], 3)
        self.assertEqual(summary["unsupported_questions"], 2)
        self.assertEqual(summary["hit_at_1_count"], 1)
        self.assertEqual(summary["hit_at_3_count"], 2)
        self.assertEqual(summary["unsupported_retrieval_nonempty_count"], 1)

    def test_generation_failure_does_not_hide_known_provider_usage(self):
        usage = {"input_tokens": 100, "output_tokens": 25, "total_tokens": 125}
        record = {
            "state": "finished", "http_status": 502, "expected_status": "answered",
            "response": {}, "provider_result": {"usage": usage},
            "source_fields_match_database": None, "api_seconds": 2,
        }
        summary = generation_summary([record])
        self.assertEqual(summary["http_200"], 0)
        self.assertEqual(summary["answerable_denominator"], 1)
        self.assertEqual(summary["provider_tokens"], usage)
        self.assertEqual(summary["provider_usage_known_count"], 1)

    def test_interrupted_generation_is_not_replayed(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            marker = {"state": "started", "query_id": "q01", "mode": "baseline"}
            (output / "q01.baseline.json").write_text(json.dumps(marker))
            client = Mock()
            result = trial(client, {"query_id": "q01"}, "baseline", {}, output, 10)
            self.assertEqual(result, marker)
            client.post.assert_not_called()

    def test_sample_binding_preserves_project_scope_and_line_endings(self):
        sample = {"sample_id": "a", "snippet": {
            "project_name": "p", "language": "python", "code": "a\r\nb"
        }}
        rows = [
            {"id": 1, "project_name": "p", "language": "python", "code": "a\nb"},
            {"id": 2, "project_name": "other", "language": "python", "code": "a\nb"},
            {"id": 3, "project_name": "p", "language": "typescript", "code": "a\nb"},
        ]
        result = bind_samples([sample], rows)
        self.assertEqual([x["id"] for x in result["a"]], [1])
        self.assertEqual(rows[0]["code"], "a\nb")

    def test_repository_samples_match_recorded_source_ranges(self):
        data = json.loads(DATA.read_text())
        for sample in data["snippets"]:
            self.assertEqual(set(sample["snippet"]), set(FIELDS))
            if sample["provenance"]["kind"] != "repository_working_tree":
                continue
            source = sample["snippet"]
            import hashlib
            recorded = DATA.parent / "results/2026-11-16-local/source_snapshot" / source["file_path"]
            self.assertEqual(hashlib.sha256(recorded.read_bytes()).hexdigest(),
                             sample["provenance"]["file_sha256"])
            lines = recorded.read_text().splitlines()
            actual = "\n".join(lines[source["start_line"] - 1:source["end_line"]])
            self.assertEqual(actual, source["code"], sample["sample_id"])

    def test_seed_does_not_retry_an_unchanged_invalid_input(self):
        from unittest.mock import patch
        from rag.experiments.deadline_eval.seed import seed_samples
        payload = {"project_name": "p", "language": "python", "code": "too long",
                   "file_path": "test.py", "function_name": None, "start_line": 1, "end_line": 1}
        row = {**payload, "id": 99, "embedding": None, "embedding_status": "failed",
               "embedding_error": "embedding_input_invalid"}
        data = {"snippets": [{"sample_id": "bad", "snippet": payload}]}
        with (
            patch("rag.experiments.deadline_eval.seed.snapshot", return_value=[row]),
            patch("rag.experiments.deadline_eval.seed.embed_code") as embed,
        ):
            with self.assertRaisesRegex(RuntimeError, "input problem"):
                seed_samples(data, apply=True)
        embed.assert_not_called()

    def test_versioned_questions_have_explicit_expected_samples_and_status(self):
        data = json.loads(DATA.read_text())
        ids = {s["sample_id"] for s in data["snippets"]}
        self.assertEqual(len(data["queries"]), 25)
        self.assertEqual(sum(bool(q["expected_samples"]) for q in data["queries"]), 20)
        self.assertEqual(len({q["query_id"] for q in data["queries"]}), 25)
        for query in data["queries"]:
            self.assertTrue(set(query["expected_samples"]) <= ids)
            self.assertEqual(query["expected_status"],
                             "answered" if query["expected_samples"] else "insufficient_context")


if __name__ == "__main__":
    unittest.main()
