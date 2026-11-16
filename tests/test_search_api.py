import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.main import app
from rag.embedding import EmbeddingInputError

# 테스트에서만 사용하는 검증용 벡터
FAKE_VECTOR = [1.0] + [0.0] * 767


class SearchApiTests(unittest.TestCase):
    def setUp(self):
        warmup = patch("backend.main.warmup_model")
        warmup.start()
        self.addCleanup(warmup.stop)

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
        self.assertEqual(response.json(), {"results": [], "filters": {"project": None, "language": None}})

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

class SearchFilterTests(unittest.TestCase):
    def setUp(self):
        from contextlib import ExitStack
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch("backend.main.warmup_model"))
        self.client = self.stack.enter_context(TestClient(app))

    def test_optional_filters_normalize_and_are_passed_to_database(self):
        cases = [
            ({}, None, None),
            ({"project": "   ", "language": " "}, None, None),
            ({"project": " Team-App "}, "Team-App", None),
            ({"language": " PyThOn "}, None, "python"),
            ({"project": "Team-App", "language": "TypeScript"}, "Team-App", "typescript"),
            ({"project": "개인 코드 & tools"}, "개인 코드 & tools", None),
        ]
        for params, project, language in cases:
            with (
                self.subTest(params=params),
                patch("backend.routers.search.embed_query", return_value=FAKE_VECTOR),
                patch("backend.routers.search.search_snippets", return_value=[]) as search,
            ):
                response = self.client.get("/search", params={"q": "코드 찾아줘", "limit": 2, **params})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), {
                    "results": [],
                    "filters": {"project": project, "language": language},
                })
                search.assert_called_once_with(FAKE_VECTOR, limit=2, project=project, language=language)

    def test_long_normalized_filter_is_rejected_before_embedding(self):
        for name in ["project", "language"]:
            with (
                self.subTest(name=name),
                patch("backend.routers.search.embed_query") as embed,
                patch("backend.routers.search.search_snippets") as search,
            ):
                response = self.client.get("/search", params={"q": "코드", name: "x" * 201})
                self.assertEqual(response.status_code, 422)
                embed.assert_not_called()
                search.assert_not_called()

    def test_padding_does_not_count_toward_filter_limit(self):
        with (
            patch("backend.routers.search.embed_query", return_value=FAKE_VECTOR),
            patch("backend.routers.search.search_snippets", return_value=[]) as search,
        ):
            response = self.client.get("/search", params={"q": "코드", "project": " " * 50 + "p" * 200 + " "})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["filters"]["project"], "p" * 200)
        search.assert_called_once()

    def test_source_fields_are_preserved_in_filtered_response(self):
        row = {
            "id": 91, "project_name": "Team-App", "file_path": "src/app.ts",
            "language": "TypeScript", "function_name": None,
            "start_line": 3, "end_line": 4, "code": "const x = 1;\r\nconsole.log(x);",
            "score": 0.75,
        }
        with (
            patch("backend.routers.search.embed_query", return_value=FAKE_VECTOR),
            patch("backend.routers.search.search_snippets", return_value=[row]),
        ):
            response = self.client.get("/search", params={"q": "출력", "language": "typescript"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["results"], [row])


class SearchFilterDatabaseTests(unittest.TestCase):
    def test_user_filter_values_are_parameters_and_precede_limit(self):
        from unittest.mock import MagicMock
        from backend.database import search_snippets
        conn = MagicMock()
        conn.__enter__.return_value = conn
        conn.execute.return_value.fetchall.return_value = []
        project = "test' OR 1=1 --"
        with (
            patch("backend.database.connect_db", return_value=conn),
            patch("backend.database.register_vector"),
        ):
            self.assertEqual(search_snippets(FAKE_VECTOR, limit=1, project=project, language=" PyThOn "), [])
        sql, params = conn.execute.call_args.args
        self.assertNotIn(project, sql)
        self.assertEqual(params[1:], (project, "python", 1))
        self.assertLess(sql.index("btrim(project_name) = %s"), sql.index("LIMIT"))
        self.assertLess(sql.index("lower(btrim(language)) = %s"), sql.index("LIMIT"))

    def test_old_database_caller_works_without_filters(self):
        from unittest.mock import MagicMock
        from backend.database import search_snippets
        conn = MagicMock()
        conn.__enter__.return_value = conn
        conn.execute.return_value.fetchall.return_value = []
        with (
            patch("backend.database.connect_db", return_value=conn),
            patch("backend.database.register_vector"),
        ):
            self.assertEqual(search_snippets(FAKE_VECTOR, limit=3), [])
        sql, params = conn.execute.call_args.args
        self.assertNotIn("btrim(project_name) = %s", sql)
        self.assertNotIn("lower(btrim(language)) = %s", sql)
        self.assertEqual(params[-1], 3)


if __name__ == "__main__":
    unittest.main()