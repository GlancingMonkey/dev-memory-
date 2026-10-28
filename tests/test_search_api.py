import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.main import app
from rag.embedding import EmbeddingInputError

# 테스트에서만 사용하는 검증용 벡터
FAKE_VECTOR = [1.0] + [0.0] * 767


class SearchApiTests(unittest.TestCase):
    def test_empty_results_returns_200(self):
        with (
            patch(
                "backend.routers.search.embed_query",
                return_value=FAKE_VECTOR,
            ),
            patch(
                "backend.routers.search.search_snippets",
                return_value=[],
            ),
            TestClient(app) as client,
        ):
            response = client.get(
                "/search",
                params={"q": "테스트 질문", "limit": 3},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"results": []})

    def test_embedding_input_error_returns_422(self):
        with (
            patch(
                "backend.routers.search.embed_query",
                side_effect=EmbeddingInputError("simulated invalid query"),
            ),
            patch(
                "backend.routers.search.search_snippets"
            ) as search,
            TestClient(app) as client,
        ):
            response = client.get(
                "/search",
                params={"q": "테스트 질문"},
            )

        self.assertEqual(response.status_code, 422)
        self.assertIsInstance(response.json()["detail"], str)
        search.assert_not_called()

    def test_model_failure_returns_503(self):
        with (
            patch(
                "backend.routers.search.embed_query",
                side_effect=ValueError("simulated model failure"),
            ),
            patch(
                "backend.routers.search.search_snippets"
            ) as search,
            patch("backend.routers.search.logger") as logger,
            TestClient(app) as client,
        ):
            response = client.get(
                "/search",
                params={"q": "테스트 질문"},
            )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.json(),
            {"detail": "Search service unavailable"},
        )
        search.assert_not_called()
        logger.exception.assert_called_once()

    def test_database_failure_returns_503(self):
        with (
            patch(
                "backend.routers.search.embed_query",
                return_value=FAKE_VECTOR,
            ),
            patch(
                "backend.routers.search.search_snippets",
                side_effect=RuntimeError("simulated database failure"),
            ),
            patch("backend.routers.search.logger") as logger,
            TestClient(app) as client,
        ):
            response = client.get(
                "/search",
                params={"q": "테스트 질문"},
            )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.json(),
            {"detail": "Search service unavailable"},
        )
        logger.exception.assert_called_once()


if __name__ == "__main__":
    unittest.main()