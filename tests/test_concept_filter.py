from unittest.mock import MagicMock, patch
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.database import insert_snippet, search_snippets
from backend.routers.search import router
from backend.schemas.search import SearchFilters
from backend.schemas.snippet import SnippetCreateRequest


VECTOR = [1.0] + [0.0] * 767
PAYLOAD = {"project_name":"p","file_path":"f.py","language":"python","function_name":"f",
           "start_line":1,"end_line":2,"code":"def f(x):\n    return x"}


class ConceptFilterTests(unittest.TestCase):
    def test_optional_concepts_preserve_old_request(self):
        self.assertIsNone(SnippetCreateRequest(**PAYLOAD).concepts)
        self.assertEqual(SnippetCreateRequest(**PAYLOAD,concepts=[" loop ","loop","condition"]).concepts,["loop","condition"])
        for invalid in ([" "],[1],["x"*101]):
            with self.subTest(invalid=invalid),self.assertRaises(ValidationError):
                SnippetCreateRequest(**PAYLOAD,concepts=invalid)

    def test_insert_only_references_concepts_column_when_supplied(self):
        for concepts in (None, [], ["loop"]):
            connection = MagicMock()
            connection.__enter__.return_value = connection
            cursor = connection.cursor.return_value.__enter__.return_value
            cursor.fetchone.return_value = (1,)
            with self.subTest(concepts=concepts),patch("backend.database.connect_db",return_value=connection):
                self.assertEqual(insert_snippet(SnippetCreateRequest(**PAYLOAD,concepts=concepts)),1)
            sql,args = cursor.execute.call_args.args
            self.assertEqual("concepts" in sql, concepts is not None)
            self.assertEqual(args[-1], PAYLOAD["code"] if concepts is None else concepts)

    def test_concept_is_parameterized_before_top_k(self):
        connection = MagicMock()
        connection.__enter__.return_value = connection
        connection.execute.return_value.fetchall.return_value = []
        value = "x'); DROP TABLE snippets; --"
        with patch("backend.database.connect_db",return_value=connection),patch("backend.database.register_vector"):
            self.assertEqual(search_snippets(VECTOR,limit=2,concept=value),[])
        sql,args = connection.execute.call_args.args
        self.assertIn("%s = ANY(concepts)",sql)
        self.assertNotIn(value,sql)
        self.assertEqual(args[-2:],(value,2))

    def test_old_filters_shape_is_preserved_without_concept(self):
        self.assertEqual(SearchFilters().model_dump(),{"project":None,"language":None})
        self.assertEqual(SearchFilters(concept=" loop ").model_dump(),{"project":None,"language":None,"concept":"loop"})

    def test_search_endpoint_passes_concept_and_returns_applied_filter(self):
        app = FastAPI()
        app.include_router(router)
        with TestClient(app) as client,patch("backend.routers.search.embed_query",return_value=VECTOR),patch("backend.routers.search.search_snippets",return_value=[]) as search:
            response = client.get("/search",params={"q":"반복 코드","concept":" loop "})
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.json()["filters"]["concept"],"loop")
            search.assert_called_once_with(VECTOR,limit=10,project=None,language=None,concept="loop")
        with TestClient(app) as client,patch("backend.routers.search.embed_query") as embed:
            self.assertEqual(client.get("/search",params={"q":"test","concept":"x"*101}).status_code,422)
            embed.assert_not_called()


if __name__ == "__main__":
    unittest.main()
