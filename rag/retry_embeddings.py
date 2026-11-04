"""Inspect one snippet, or explicitly retry it with --apply."""

import argparse

from psycopg.rows import dict_row

from backend.database import (
    connect_db,
    get_snippet_embedding_state,
    mark_snippet_embedding_failed,
    save_snippet_embedding,
)
from rag.embedding import EmbeddingInputError, embed_code


def _report_current_state(row: dict) -> int:
    try:
        state = get_snippet_embedding_state(
            snippet_id=row["id"],
            project_name=row["project_name"],
            expected_code=row["code"],
        )
    except Exception as error:
        print(f"State confirmation failed: {type(error).__name__}")
        state = None

    if state is not None:
        if (
            state.get("embedding_status") == "ready"
            and state.get("embedding_valid") is True
            and state.get("embedding_error") is None
        ):
            print("Result: skip (ready embedding already confirmed in DB)")
            return 0
        if (
            state.get("embedding_status") == "failed"
            and state.get("embedding_missing") is True
        ):
            print("Result: failed (stored failure state confirmed)")
            return 1

    print("Result: unconfirmed (row changed, missing, or DB unavailable)")
    return 1


def _record_failure(row: dict, error_code: str) -> int:
    try:
        recorded = mark_snippet_embedding_failed(
            snippet_id=row["id"],
            project_name=row["project_name"],
            expected_code=row["code"],
            error_code=error_code,
        )
    except Exception as error:
        print(f"Failure status write not confirmed: {type(error).__name__}")
        recorded = False

    if recorded:
        print(f"Result: failed ({error_code}); original snippet preserved")
        return 1
    return _report_current_state(row)


def _apply(row: dict) -> int:
    print("Generating embedding for this ID...", flush=True)
    try:
        vector = embed_code(row["code"])
    except EmbeddingInputError:
        return _record_failure(row, "embedding_input_invalid")
    except Exception as error:
        print(f"Embedding generation failed: {type(error).__name__}")
        return _record_failure(row, "embedding_generation_failed")

    try:
        saved = save_snippet_embedding(
            snippet_id=row["id"],
            project_name=row["project_name"],
            expected_code=row["code"],
            embedding=vector,
        )
    except Exception as error:
        print(f"Embedding storage failed: {type(error).__name__}")
        return _record_failure(row, "embedding_storage_failed")

    if saved:
        print(f"Result: ready (embedding saved to existing id={row['id']})")
        return 0
    return _report_current_state(row)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Inspect or explicitly retry one snippet embedding."
    )
    parser.add_argument("--project", required=True)
    parser.add_argument("--id", dest="snippet_id", type=int, required=True)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Generate and save an embedding; default is read-only.",
    )
    args = parser.parse_args()

    if not args.project.strip():
        parser.error("--project must not be empty")
    if args.snippet_id <= 0:
        parser.error("--id must be a positive integer")

    print("Mode:", "apply" if args.apply else "read-only")

    try:
        with connect_db() as conn:
            conn.execute("SET TRANSACTION READ ONLY")
            conn.row_factory = dict_row
            row = conn.execute(
                """
                SELECT id, project_name, file_path, function_name, code,
                       embedding_status, embedding_error,
                       embedding IS NULL AS embedding_missing
                FROM public.snippets
                WHERE id = %s AND project_name = %s
                """,
                (args.snippet_id, args.project),
            ).fetchone()
    except Exception as error:
        print(f"Result: DB read failed ({type(error).__name__}); not processed")
        return 1

    if row is None:
        print("No matching snippet for the given id and project.")
        return 1

    for name in (
        "id", "project_name", "file_path", "function_name",
        "embedding_status", "embedding_error", "embedding_missing",
    ):
        print(f"{name}: {row[name]}")

    if not row["embedding_missing"]:
        print("Result: skip (embedding already exists)")
        return 0

    if row["embedding_status"] not in ("pending", "failed"):
        print("Result: skip (inconsistent state; inspect DB first)")
        return 1 if args.apply else 0

    if (
        row["embedding_status"] == "failed"
        and row["embedding_error"] == "embedding_input_invalid"
    ):
        print("Result: skip (invalid input; resolve input issue before retry)")
        return 1 if args.apply else 0

    if not args.apply:
        print("Result: candidate (use --apply to process this ID)")
        return 0

    return _apply(row)


if __name__ == "__main__":
    raise SystemExit(main())
