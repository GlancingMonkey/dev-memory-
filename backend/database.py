import math
import os
from pathlib import Path

import psycopg
from dotenv import load_dotenv
from pgvector import Vector
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row

from backend.schemas.snippet import SnippetCreateRequest
from backend.schemas.search import SearchFilters

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


def delete_snippet(snippet_id: int) -> bool:
    """지정한 ID 한 행을 삭제하고 커밋이 확인된 뒤 결과를 반환한다."""
    if type(snippet_id) is not int or not 1 <= snippet_id <= 2**63 - 1:
        raise ValueError("snippet_id must be a positive BIGINT")

    with connect_db() as connection:
        row = connection.execute(
            """
            DELETE FROM public.snippets
            WHERE id = %s
            RETURNING id
            """,
            (snippet_id,),
        ).fetchone()

    return row is not None


def search_snippets(
    query_vector: list[float],
    limit: int = 10,
    *,
    project: str | None = None,
    language: str | None = None,
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

    filters = SearchFilters(project=project, language=language)
    conditions = ["embedding IS NOT NULL", "vector_norm(embedding) > 0"]
    params: list = [Vector(query_vector)]
    if filters.project is not None:
        conditions.append("btrim(project_name) = %s")
        params.append(filters.project)
    if filters.language is not None:
        conditions.append("lower(btrim(language)) = %s")
        params.append(filters.language)
    where_sql = " AND ".join(conditions)
    params.append(limit)

    with connect_db() as connection:
        register_vector(connection)
        connection.row_factory = dict_row

        rows = connection.execute(
            f"""
            SELECT id, project_name, file_path, language, function_name,
                   start_line, end_line, code,
                   embedding <=> %s AS cosine_distance
            FROM public.snippets
            WHERE {where_sql}
            ORDER BY cosine_distance ASC, id ASC
            LIMIT %s
            """,
            tuple(params),
        ).fetchall()

    for row in rows:
        distance = float(row.pop("cosine_distance"))

        if not math.isfinite(distance):
            raise RuntimeError("Search returned a non-finite distance")

        row["score"] = max(-1.0, min(1.0, 1.0 - distance))

    return rows


def save_snippet_embedding(
    snippet_id: int,
    project_name: str,
    expected_code: str,
    embedding: list[float],
) -> bool:
    """원문이 일치하는 미처리 행에 벡터와 완료 상태를 저장한다."""
    if len(embedding) != 768:
        raise ValueError("embedding must have 768 dimensions")

    if (
        not all(math.isfinite(value) for value in embedding)
        or not any(embedding)
    ):
        raise ValueError("embedding must be finite and non-zero")

    vector = Vector(embedding)

    with connect_db() as connection:
        register_vector(connection)

        row = connection.execute(
            """
            UPDATE public.snippets
            SET embedding = %s,
                embedding_status = 'ready',
                embedding_error = NULL,
                updated_at = NOW()
            WHERE id = %s
              AND project_name = %s
              AND code = %s
              AND embedding IS NULL
              AND embedding_status IN ('pending', 'failed')
            RETURNING id
            """,
            (
                vector,
                snippet_id,
                project_name,
                expected_code,
            ),
        ).fetchone()

    return row is not None


def mark_snippet_embedding_failed(
    snippet_id: int,
    project_name: str,
    expected_code: str,
    error_code: str,
) -> bool:
    """원문이 일치하는 미완료 행에 안전한 실패 코드를 기록한다."""
    allowed_errors = {
        "embedding_input_invalid",
        "embedding_generation_failed",
        "embedding_storage_failed",
    }
    if error_code not in allowed_errors:
        raise ValueError("Unsupported embedding error code")

    with connect_db() as connection:
        row = connection.execute(
            """
            UPDATE public.snippets
            SET embedding_status = 'failed',
                embedding_error = %s,
                updated_at = NOW()
            WHERE id = %s
              AND project_name = %s
              AND code = %s
              AND embedding IS NULL
              AND embedding_status IN ('pending', 'failed')
            RETURNING id
            """,
            (
                error_code,
                snippet_id,
                project_name,
                expected_code,
            ),
        ).fetchone()

    return row is not None


def get_snippet_embedding_state(
    snippet_id: int,
    project_name: str,
    expected_code: str,
) -> dict | None:
    """같은 ID·프로젝트·원문에 해당하는 임베딩 상태를 조회한다."""
    with connect_db() as connection:
        connection.execute("SET TRANSACTION READ ONLY")
        connection.row_factory = dict_row

        row = connection.execute(
            """
            SELECT embedding_status,
                   embedding_error,
                   embedding IS NULL AS embedding_missing,
                   (
                       embedding IS NOT NULL
                       AND vector_dims(embedding) = 768
                       AND vector_norm(embedding) > 0
                   ) AS embedding_valid
            FROM public.snippets
            WHERE id = %s
              AND project_name = %s
              AND code = %s
            """,
            (
                snippet_id,
                project_name,
                expected_code,
            ),
        ).fetchone()

    return row


def get_filter_options() -> dict[str, list[dict]]:
    """현재 검색 가능한 스니펫의 프로젝트·언어별 행 수를 반환한다."""
    with connect_db() as connection:
        connection.execute("SET TRANSACTION READ ONLY")
        connection.row_factory = dict_row
        rows = connection.execute(
            """
            WITH searchable AS (
                SELECT btrim(project_name) AS project_name,
                       lower(btrim(language)) AS language
                FROM public.snippets
                WHERE embedding IS NOT NULL
                  AND vector_norm(embedding) > 0
            )
            SELECT 'projects' AS kind, project_name AS name, COUNT(*) AS count
            FROM searchable
            WHERE project_name <> ''
            GROUP BY project_name
            UNION ALL
            SELECT 'languages' AS kind, language AS name, COUNT(*) AS count
            FROM searchable
            WHERE language <> ''
            GROUP BY language
            ORDER BY kind ASC, name ASC
            """
        ).fetchall()

    options: dict[str, list[dict]] = {"projects": [], "languages": []}
    for row in rows:
        options[row["kind"]].append({
            "name": row["name"],
            "count": row["count"],
        })
    return options


def delete_snippet(snippet_id: int) -> bool:
    """지정한 ID 한 건을 삭제하고, 실제 삭제 여부를 반환한다."""
    if type(snippet_id) is not int or snippet_id <= 0:
        raise ValueError("snippet_id must be a positive integer")

    with connect_db() as connection:
        row = connection.execute(
            "DELETE FROM public.snippets WHERE id = %s RETURNING id",
            (snippet_id,),
        ).fetchone()

    return row is not None
