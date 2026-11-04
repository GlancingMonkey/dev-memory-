import io
import unittest
from contextlib import ExitStack, redirect_stdout
from unittest.mock import MagicMock, patch

from rag import retry_embeddings as retry
from rag.embedding import EmbeddingInputError

# 테스트 전용 값이다. 실제 DB나 모델을 호출하지 않는다.
TEST_ID = 123
PROJECT = "retry-unit-test"
FAKE_VECTOR = [1.0] + [0.0] * 767
INTERNAL_ERROR = "TEST_INTERNAL_FAILURE"


class RetryEmbeddingTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.row = {
            "id": TEST_ID,
            "project_name": PROJECT,
            "file_path": "sample.py",
            "function_name": "add",
            "code": "    def add(a, b):\r\n        return a + b\r\n",
            "embedding_status": "pending",
            "embedding_error": None,
            "embedding_missing": True,
        }
        self.connection = MagicMock()
        self.connection.__enter__.return_value = self.connection
        self.connection.execute.return_value.fetchone.return_value = self.row
        defaults = {
            "connect_db": self.connection,
            "embed_code": FAKE_VECTOR,
            "save_snippet_embedding": True,
            "mark_snippet_embedding_failed": True,
            "get_snippet_embedding_state": None,
        }
        self.calls = {
            name: self.stack.enter_context(
                patch.object(retry, name, return_value=value)
            )
            for name, value in defaults.items()
        }

    def run_cli(self, apply=False, project=PROJECT):
        arguments = [
            "retry_embeddings", "--project", project,
            "--id", str(TEST_ID),
        ]
        if apply:
            arguments.append("--apply")
        output = io.StringIO()
        with patch("sys.argv", arguments), redirect_stdout(output):
            result = retry.main()
        self.assertNotIn(INTERNAL_ERROR, output.getvalue())
        return result, output.getvalue()

    def check_not_processed(self):
        for name in (
            "embed_code", "save_snippet_embedding",
            "mark_snippet_embedding_failed", "get_snippet_embedding_state",
        ):
            self.calls[name].assert_not_called()

    def test_default_is_read_only(self):
        result, output = self.run_cli()
        self.assertEqual(result, 0)
        self.assertIn("Mode: read-only", output)
        self.assertIn("Result: candidate", output)
        self.check_not_processed()

    def test_existing_embedding_skips_even_with_apply(self):
        self.row.update(embedding_status="ready", embedding_missing=False)
        result, output = self.run_cli(apply=True)
        self.assertEqual(result, 0)
        self.assertIn("Result: skip", output)
        self.check_not_processed()

    def test_missing_or_wrong_project_does_not_process(self):
        self.connection.execute.return_value.fetchone.return_value = None
        result, output = self.run_cli(apply=True, project="other-project")
        self.assertEqual(result, 1)
        self.assertIn("No matching snippet", output)
        self.assertEqual(
            self.connection.execute.call_args.args[1],
            (TEST_ID, "other-project"),
        )
        self.check_not_processed()

    def test_apply_preserves_id_project_and_original_code(self):
        def embed(code):
            self.connection.__exit__.assert_called_once()
            return FAKE_VECTOR

        self.calls["embed_code"].side_effect = embed
        result, output = self.run_cli(apply=True)
        self.assertEqual(result, 0)
        self.assertIn("Result: ready", output)
        self.calls["embed_code"].assert_called_once_with(self.row["code"])
        self.calls["save_snippet_embedding"].assert_called_once_with(
            snippet_id=TEST_ID,
            project_name=PROJECT,
            expected_code=self.row["code"],
            embedding=FAKE_VECTOR,
        )
        self.calls["mark_snippet_embedding_failed"].assert_not_called()

    def test_input_error_records_safe_reason(self):
        self.calls["embed_code"].side_effect = EmbeddingInputError(
            INTERNAL_ERROR
        )
        result, output = self.run_cli(apply=True)
        self.assertEqual(result, 1)
        self.assertIn("embedding_input_invalid", output)
        self.assertEqual(
            self.calls["mark_snippet_embedding_failed"].call_args.kwargs,
            {
                "snippet_id": TEST_ID,
                "project_name": PROJECT,
                "expected_code": self.row["code"],
                "error_code": "embedding_input_invalid",
            },
        )
        self.calls["save_snippet_embedding"].assert_not_called()

    def test_model_error_records_safe_reason(self):
        self.calls["embed_code"].side_effect = RuntimeError(INTERNAL_ERROR)
        result, output = self.run_cli(apply=True)
        self.assertEqual(result, 1)
        self.assertIn("embedding_generation_failed", output)
        self.assertEqual(
            self.calls["mark_snippet_embedding_failed"].call_args.kwargs[
                "error_code"
            ],
            "embedding_generation_failed",
        )

    def test_storage_error_records_safe_reason(self):
        self.calls["save_snippet_embedding"].side_effect = RuntimeError(
            INTERNAL_ERROR
        )
        result, output = self.run_cli(apply=True)
        self.assertEqual(result, 1)
        self.assertIn("embedding_storage_failed", output)
        self.assertEqual(
            self.calls["mark_snippet_embedding_failed"].call_args.kwargs[
                "error_code"
            ],
            "embedding_storage_failed",
        )

    def test_previously_invalid_input_is_not_retried(self):
        self.row.update(
            embedding_status="failed",
            embedding_error="embedding_input_invalid",
        )
        for apply, expected_result in ((False, 0), (True, 1)):
            with self.subTest(apply=apply):
                result, output = self.run_cli(apply=apply)
                self.assertEqual(result, expected_result)
                self.assertIn("invalid input", output)
        self.check_not_processed()

    def test_concurrent_ready_embedding_is_confirmed(self):
        self.calls["save_snippet_embedding"].return_value = False
        self.calls["get_snippet_embedding_state"].return_value = {
            "embedding_status": "ready",
            "embedding_error": None,
            "embedding_missing": False,
            "embedding_valid": True,
        }
        result, output = self.run_cli(apply=True)
        self.assertEqual(result, 0)
        self.assertIn("Result: skip", output)
        self.calls["mark_snippet_embedding_failed"].assert_not_called()

    def test_zero_update_without_confirmed_state_is_not_success(self):
        self.calls["save_snippet_embedding"].return_value = False
        result, output = self.run_cli(apply=True)
        self.assertEqual(result, 1)
        self.assertIn("Result: unconfirmed", output)
        self.calls["mark_snippet_embedding_failed"].assert_not_called()

    def test_initial_database_failure_stops_processing(self):
        self.calls["connect_db"].side_effect = RuntimeError(INTERNAL_ERROR)
        result, output = self.run_cli(apply=True)
        self.assertEqual(result, 1)
        self.assertIn("DB read failed", output)
        self.check_not_processed()

    def test_failure_state_outage_never_claims_ready(self):
        for name in (
            "embed_code", "mark_snippet_embedding_failed",
            "get_snippet_embedding_state",
        ):
            self.calls[name].side_effect = RuntimeError(INTERNAL_ERROR)
        result, output = self.run_cli(apply=True)
        self.assertEqual(result, 1)
        self.assertIn("Result: unconfirmed", output)
        self.assertNotIn("Result: ready", output)


if __name__ == "__main__":
    unittest.main()
