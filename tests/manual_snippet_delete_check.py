"""Opt-in DELETE integration check in a new, disposable PostgreSQL database.

Run at the repository root:
    uv run --locked python - --apply < tests/manual_snippet_delete_check.py

The configured database is read only. Only the database created by this run
is populated and dropped. Models are mocked; PostgreSQL and API calls are real.
"""

import argparse
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import uuid
from unittest.mock import patch

from fastapi.testclient import TestClient
import psycopg
from psycopg import sql

from backend import database
from backend.main import app
from backend.schemas.snippet import SnippetCreateRequest
from rag.embedding import EmbeddingInputError


FAKE_VECTOR = [1.0] + [0.0] * 767
PAYLOAD = {
    "project_name": "delete-check",
    "file_path": "first.py",
    "language": "python",
    "function_name": "add",
    "start_line": 1,
    "end_line": 2,
    "code": "def add(a, b):\n    return a + b",
}


def snapshot(connection):
    with connection.transaction():
        connection.execute("SET TRANSACTION READ ONLY")
        rows = connection.execute(
            "SELECT to_jsonb(s) FROM public.snippets AS s ORDER BY id"
        ).fetchall()
    digest = hashlib.sha256(
        json.dumps(rows, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()
    return len(rows), digest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if not args.apply:
        print("No changes. Use --apply to create and remove a disposable test DB.")
        return 0

    admin = database.connect_db()
    admin.autocommit = True
    test_database = "snippet_delete_check_" + uuid.uuid4().hex
    created = False
    try:
        original_database = admin.info.dbname
        before = snapshot(admin)
        dsn = os.environ["DATABASE_URL"]
        assert test_database != original_database
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(test_database)))
        created = True

        def connect_test_db():
            return psycopg.connect(dsn, dbname=test_database, connect_timeout=5)

        with connect_test_db() as connection:
            connection.execute(Path("database/init.sql").read_text())

        with ExitStack() as stack:
            stack.enter_context(patch("backend.database.connect_db", side_effect=connect_test_db))
            stack.enter_context(patch("backend.main.warmup_model"))
            embed_code = stack.enter_context(
                patch("backend.routers.snippets.embed_code", return_value=FAKE_VECTOR)
            )
            stack.enter_context(patch("backend.routers.search.embed_query", return_value=FAKE_VECTOR))
            llm = stack.enter_context(patch("backend.llm._client"))
            stack.enter_context(patch("backend.routers.snippets.logger"))
            client = stack.enter_context(TestClient(app))

            ids = []
            for fields in ({}, {"file_path": "duplicate.py"}, {
                "project_name": "other-project", "language": "typescript",
            }):
                response = client.post("/snippets", json={**PAYLOAD, **fields})
                assert response.status_code == 200
                assert response.json()["embedding_status"] == "ready"
                ids.append(response.json()["id"])
            target, duplicate, other = ids
            with connect_test_db() as connection:
                unchanged_rows = connection.execute(
                    "SELECT to_jsonb(s) FROM public.snippets s WHERE id <> %s ORDER BY id",
                    (target,),
                ).fetchall()
            assert client.get("/filters").json()["projects"] == [
                {"name": "delete-check", "count": 2},
                {"name": "other-project", "count": 1},
            ]

            response = client.delete(f"/snippets/{target}")
            assert response.status_code == 200
            assert response.json() == {"id": target, "message": "snippet deleted"}
            assert client.delete(f"/snippets/{target}").status_code == 404
            assert client.delete("/snippets/0").status_code == 422
            assert client.delete(f"/snippets/{2**63}").status_code == 422
            assert client.get("/filters").json()["projects"] == [
                {"name": "delete-check", "count": 1},
                {"name": "other-project", "count": 1},
            ]
            response = client.get("/search", params={"q": "test", "limit": 20})
            assert response.status_code == 200
            assert {row["id"] for row in response.json()["results"]} == {duplicate, other}

            embed_code.side_effect = EmbeddingInputError("TEST_ONLY_INVALID_INPUT")
            response = client.post("/snippets", json={**PAYLOAD, "file_path": "failed.py"})
            assert response.json()["embedding_status"] == "failed"
            assert client.delete(f"/snippets/{response.json()['id']}").status_code == 200
            pending = database.insert_snippet(SnippetCreateRequest(**PAYLOAD))
            assert client.delete(f"/snippets/{pending}").status_code == 200

            with patch("backend.routers.snippets.delete_snippet", side_effect=RuntimeError("TEST_ONLY_ERROR")):
                response = client.delete(f"/snippets/{duplicate}")
            assert response.status_code == 503
            assert response.json() == {"detail": "Snippet deletion unavailable"}
            with connect_test_db() as connection:
                remaining = connection.execute(
                    "SELECT to_jsonb(s) FROM public.snippets s ORDER BY id"
                ).fetchall()
            assert remaining == unchanged_rows
            llm.assert_not_called()
        print("Real PostgreSQL/API: ready, pending and failed deletion OK")
        print("Other rows and duplicate preserved: True")
        print("Fresh search and filter counts updated: True")
        print("HTTP 200 / 404 / 422 / 503: OK")
        print("Embedding mocked; LLM calls: 0")
    finally:
        try:
            if created:
                admin.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(test_database)))
                print("Disposable test database removed: True")
            if "before" in locals():
                after = snapshot(admin)
                assert before == after, "Configured database snapshot changed"
                print("Configured DB rows and full snapshot preserved: True")
        finally:
            admin.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
