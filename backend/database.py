import math
import os
from pathlib import Path

import psycopg
from dotenv import load_dotenv
from pgvector import Vector
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row

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


def search_snippets(
    query_vector: list[float],
    limit: int = 10,
) -> list[dict]:
    if not 1 <= limit <= 20:
        raise ValueError("limit must be between 1 and 20")

    if len(query_vector) != 768:
        raise ValueError("query_vector must have 768 dimensions")

    if (
        not all(math.isfinite(value) for value in query_vector)
        or not any(query_vector)
    ):
        raise ValueError("query_vector must be finite and non-zero")

    vector = Vector(query_vector)

    with connect_db() as connection:
        register_vector(connection)
        connection.row_factory = dict_row

        rows = connection.execute(
            """
            SELECT id, project_name, file_path, language, function_name,
                   start_line, end_line, code,
                   embedding <=> %s AS cosine_distance
            FROM public.snippets
            WHERE embedding IS NOT NULL
              AND vector_norm(embedding) > 0
            ORDER BY cosine_distance ASC, id ASC
            LIMIT %s
            """,
            (vector, limit),
        ).fetchall()

    for row in rows:
        distance = float(row.pop("cosine_distance"))

        if not math.isfinite(distance):
            raise RuntimeError("Search returned a non-finite distance")

        row["score"] = max(-1.0, min(1.0, 1.0 - distance))

    return rows