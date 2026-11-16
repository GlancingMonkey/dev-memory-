import unittest
from contextlib import ExitStack
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.main import app


class FilterOptionsApiTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch("backend.main.warmup_model"))
        self.client = self.stack.enter_context(TestClient(app))

    def test_returns_project_and_language_counts_without_model_calls(self):
        expected = {
            "projects": [
                {"name": "mvp-save-test", "count": 3},
                {"name": "other-project", "count": 2},
            ],
            "languages": [
                {"name": "python", "count": 4},
                {"name": "typescript", "count": 1},
            ],
        }
        with (
            patch(
                "backend.routers.filters.get_filter_options",
                return_value=expected,
            ) as options,
            patch("rag.embedding.embed_query") as embed_query,
            patch("rag.embedding.embed_code") as embed_code,
            patch("backend.llm._client") as llm_client,
        ):
            response = self.client.get("/filters")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), expected)
        options.assert_called_once_with()
        embed_query.assert_not_called()
        embed_code.assert_not_called()
        llm_client.assert_not_called()

    def test_no_searchable_snippets_returns_empty_arrays(self):
        with patch(
            "backend.routers.filters.get_filter_options",
            return_value={"projects": [], "languages": []},
        ):
            response = self.client.get("/filters")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"projects": [], "languages": []})

    def test_database_failure_returns_safe_503(self):
        with (
            patch(
                "backend.routers.filters.get_filter_options",
                side_effect=RuntimeError("TEST_ONLY_PRIVATE_CONNECTION_DETAILS"),
            ),
            patch("backend.routers.filters.logger") as logger,
        ):
            response = self.client.get("/filters")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.json(),
            {"detail": "Filter service unavailable"},
        )
        self.assertNotIn("TEST_ONLY_PRIVATE", response.text)
        logger.error.assert_called_once_with(
            "Filter options unavailable (%s)", "RuntimeError"
        )

    def test_invalid_count_does_not_become_a_success_response(self):
        with (
            patch(
                "backend.routers.filters.get_filter_options",
                return_value={
                    "projects": [{"name": "demo", "count": -1}],
                    "languages": [],
                },
            ),
            patch("backend.routers.filters.logger"),
        ):
            response = self.client.get("/filters")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.json(),
            {"detail": "Filter service unavailable"},
        )


if __name__ == "__main__":
    unittest.main()
