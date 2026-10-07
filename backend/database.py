import os
from pathlib import Path

import psycopg
from dotenv import load_dotenv

from backend.schemas.snippet import SnippetCreateRequest

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def connect_db():
    load_dotenv(PROJECT_ROOT / ".env")
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is not configured")
    return psycopg.connect(database_url, connect_timeout=5)


def insert_snippet(snippet: SnippetCreateRequest) -> int:
    with connect_db() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO snippets (
                    project_name, file_path, language, function_name,
                    start_line, end_line, code
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (
                    snippet.project_name,
                    snippet.file_path,
                    snippet.language,
                    snippet.function_name,
                    snippet.start_line,
                    snippet.end_line,
                    snippet.code,
                ),
            )
            row = cursor.fetchone()
            if row is None:
                raise RuntimeError("INSERT did not return an id")
            snippet_id = int(row[0])

    return snippet_id
