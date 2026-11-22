"""Inject one retry failure, recover the same ID, and verify preservation."""

import argparse
import math
from unittest.mock import patch

from psycopg.rows import dict_row

from backend.database import connect_db, search_snippets
from rag import retry_embeddings
from rag.embedding import embed_query

SNIPPET_FIELDS = (
    "project_name", "file_path", "language", "function_name",
    "start_line", "end_line", "code",
)
IMMUTABLE_FIELDS = ("id", *SNIPPET_FIELDS, "created_at")


def snapshot():
    with connect_db() as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        conn.row_factory = dict_row
        rows = conn.execute("""
            SELECT id, project_name, file_path, language, function_name,
                   start_line, end_line, code, created_at, updated_at,
                   embedding::text AS embedding_text,
                   vector_dims(embedding) AS dimension,
                   vector_norm(embedding) AS norm,
                   embedding_status, embedding_error
            FROM public.snippets
            ORDER BY id
        """).fetchall()
    return {row["id"]: row for row in rows}


def check_preservation(before, after, target_id):
    if set(before) != set(after):
        raise RuntimeError("Snippet IDs or row count changed")
    for snippet_id, original in before.items():
        current = after[snippet_id]
        if snippet_id == target_id:
            if any(current[name] != original[name] for name in IMMUTABLE_FIELDS):
                raise RuntimeError("Target original code or metadata changed")
        elif current != original:
            raise RuntimeError(f"Another snippet changed: id={snippet_id}")


def run_cli(project, snippet_id):
    arguments = [
        "retry_embeddings", "--project", project,
        "--id", str(snippet_id), "--apply",
    ]
    with patch("sys.argv", arguments):
        return retry_embeddings.main()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--id", dest="snippet_id", type=int, required=True)
    parser.add_argument("--query", required=True)
    args = parser.parse_args()
    if not args.project.strip() or args.snippet_id <= 0 or not args.query.strip():
        parser.error("Provide a project, positive ID, and non-empty query")

    before = snapshot()
    original = before.get(args.snippet_id)
    if original is None or original["project_name"] != args.project:
        raise RuntimeError("No matching target ID and project")
    if original["embedding_text"] is not None:
        raise RuntimeError("Target already has an embedding; choose an unprocessed row")
    if original["embedding_status"] not in ("pending", "failed"):
        raise RuntimeError("Target is not pending or failed")
    if original["embedding_error"] == "embedding_input_invalid":
        raise RuntimeError("Resolve the input issue before retrying this row")

    print("Phase: simulated generation failure", flush=True)
    with patch.object(
        retry_embeddings,
        "embed_code",
        side_effect=RuntimeError("TEST_ONLY_RETRY_FAILURE"),
    ):
        failed_exit = run_cli(args.project, args.snippet_id)

    after_failure = snapshot()
    check_preservation(before, after_failure, args.snippet_id)
    failed = after_failure[args.snippet_id]
    if (
        failed_exit != 1
        or failed["embedding_status"] != "failed"
        or failed["embedding_error"] != "embedding_generation_failed"
        or failed["embedding_text"] is not None
    ):
        raise RuntimeError("Simulated failure was not preserved correctly")
    print("Failure recorded: OK", flush=True)

    print("\nPhase: real E5 retry", flush=True)
    real_embed_code = retry_embeddings.embed_code
    with patch.object(retry_embeddings, "embed_code", wraps=real_embed_code) as embed:
        retry_exit = run_cli(args.project, args.snippet_id)
        embed.assert_called_once_with(original["code"])

    after_ready = snapshot()
    check_preservation(before, after_ready, args.snippet_id)
    ready = after_ready[args.snippet_id]
    norm = ready["norm"]
    if (
        retry_exit != 0
        or ready["embedding_status"] != "ready"
        or ready["embedding_error"] is not None
        or ready["dimension"] != 768
        or norm is None
        or not math.isfinite(norm)
        or not math.isclose(norm, 1.0, abs_tol=1e-5)
    ):
        raise RuntimeError("Real retry did not produce a valid ready embedding")
    print("Retry ready: OK", flush=True)

    print("\nPhase: repeat skips the existing embedding", flush=True)
    with (
        patch.object(retry_embeddings, "embed_code") as embed,
        patch.object(retry_embeddings, "save_snippet_embedding") as save,
        patch.object(retry_embeddings, "mark_snippet_embedding_failed") as mark,
    ):
        repeat_exit = run_cli(args.project, args.snippet_id)
        embed.assert_not_called()
        save.assert_not_called()
        mark.assert_not_called()

    after_skip = snapshot()
    if repeat_exit != 0 or after_skip != after_ready:
        raise RuntimeError("Repeated execution changed the DB or did not skip")
    print("Repeat skip: OK", flush=True)

    print("\nPhase: semantic search", flush=True)
    results = search_snippets(embed_query(args.query), limit=20)
    matching = [item for item in results if item["id"] == args.snippet_id]
    if len(matching) != 1:
        raise RuntimeError("Retried ID was not found in search Top-20")
    if any(matching[0][name] != original[name] for name in SNIPPET_FIELDS):
        raise RuntimeError("Search returned different code or metadata")
    if snapshot() != after_skip:
        raise RuntimeError("Search changed snippet data")

    rank = next(index for index, item in enumerate(results, 1) if item["id"] == args.snippet_id)
    print("\nRetried id:", args.snippet_id)
    print("Rows before:", len(before))
    print("Rows after:", len(after_skip))
    print("Stored dimension:", ready["dimension"])
    print("Stored norm:", format(norm, ".6f"))
    print("Original code, metadata and other vectors preserved: True")
    print("Search target rank:", rank)
    print("RAG retry integration checks: OK")


if __name__ == "__main__":
    main()
