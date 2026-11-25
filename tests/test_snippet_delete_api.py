import unittest
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from backend.database import delete_snippet
from backend.main import app


TEST_ID = 123
INTERNAL_ERROR = "TEST_ONLY_PRIVATE_CONNECTION_DETAILS"


class SnippetDeleteApiTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch("backend.main.warmup_model"))
        self.delete = self.stack.enter_context(
            patch("backend.routers.snippets.delete_snippet", return_value=True)
        )
        self.logger = self.stack.enter_context(
            patch("backend.routers.snippets.logger")
        )
        self.client = self.stack.enter_context(TestClient(app))

    def test_success_returns_the_requested_id_without_model_calls(self):
        with (
            patch("backend.routers.snippets.embed_code") as embed_code,
            patch("backend.routers.search.embed_query") as embed_query,
            patch("backend.llm._client") as llm_client,
        ):
            response = self.client.delete(f"/snippets/{TEST_ID}")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(), {"id": TEST_ID, "message": "snippet deleted"}
        )
        self.delete.assert_called_once_with(TEST_ID)
        embed_code.assert_not_called()
        embed_query.assert_not_called()
        llm_client.assert_not_called()

    def test_missing_snippet_is_404(self):
        self.delete.return_value = False
        response = self.client.delete(f"/snippets/{TEST_ID}")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json(), {"detail": "Snippet not found"})

    def test_repeat_deletion_does_not_report_a_second_success(self):
        self.delete.side_effect = [True, False]
        first = self.client.delete(f"/snippets/{TEST_ID}")
        second = self.client.delete(f"/snippets/{TEST_ID}")
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 404)
        self.assertEqual(self.delete.call_count, 2)

    def test_invalid_ids_are_rejected_before_database_access(self):
        for value in ("0", "-1", "abc", "1;DELETE", str(2**63)):
            with self.subTest(value=value):
                response = self.client.delete(f"/snippets/{value}")
                self.assertEqual(response.status_code, 422)
        self.delete.assert_not_called()

    def test_largest_bigint_can_be_looked_up(self):
        self.delete.return_value = False
        response = self.client.delete(f"/snippets/{2**63 - 1}")
        self.assertEqual(response.status_code, 404)
        self.delete.assert_called_once_with(2**63 - 1)

    def test_database_error_is_not_reported_as_missing_or_success(self):
        self.delete.side_effect = RuntimeError(INTERNAL_ERROR)
        response = self.client.delete(f"/snippets/{TEST_ID}")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.json(), {"detail": "Snippet deletion unavailable"}
        )
        self.assertNotIn(INTERNAL_ERROR, response.text)
        self.logger.error.assert_called_once_with(
            "Snippet deletion unavailable (%s)", "RuntimeError"
        )

    def test_collection_delete_is_not_a_bulk_delete_endpoint(self):
        response = self.client.delete("/snippets")
        self.assertEqual(response.status_code, 405)
        self.delete.assert_not_called()


class SnippetDeleteDatabaseTests(unittest.TestCase):
    def connection(self, row):
        connection = MagicMock()
        connection.__enter__.return_value = connection
        connection.execute.return_value.fetchone.return_value = row
        return connection

    def test_delete_is_limited_to_one_parameterized_id(self):
        connection = self.connection((TEST_ID,))
        with patch("backend.database.connect_db", return_value=connection):
            self.assertTrue(delete_snippet(TEST_ID))
        sql, parameters = connection.execute.call_args.args
        self.assertEqual(
            " ".join(sql.split()),
            "DELETE FROM public.snippets WHERE id = %s RETURNING id",
        )
        self.assertEqual(parameters, (TEST_ID,))
        connection.execute.assert_called_once()
        connection.__exit__.assert_called_once_with(None, None, None)

    def test_missing_id_returns_false(self):
        connection = self.connection(None)
        with patch("backend.database.connect_db", return_value=connection):
            self.assertFalse(delete_snippet(TEST_ID))

    def test_commit_failure_cannot_return_success(self):
        connection = self.connection((TEST_ID,))
        connection.__exit__.side_effect = RuntimeError(INTERNAL_ERROR)
        with patch("backend.database.connect_db", return_value=connection):
            with self.assertRaisesRegex(RuntimeError, INTERNAL_ERROR):
                delete_snippet(TEST_ID)

    def test_invalid_direct_inputs_never_open_a_connection(self):
        with patch("backend.database.connect_db") as connect:
            for value in (0, -1, True, 1.0, "1", "1 OR 1=1", 2**63):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    delete_snippet(value)
        connect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
