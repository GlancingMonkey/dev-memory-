"""Read-only comparison of real search rows, source serialization and DB data.

Run from the repository root:
uv run --locked python - --query "..." < tests/manual_context_check.py
This intentionally does NOT validate a token budget or call any LLM.
"""

import argparse
import json
import sys

from psycopg.rows import dict_row

from backend.database import connect_db, search_snippets
from rag.context import prepare_sources, render_context
from rag.embedding import embed_query

STORED_FIELDS = (
    "id", "project_name", "file_path", "language", "function_name",
    "start_line", "end_line", "code",
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--query", required=True)
    parser.add_argument("--limit", type=int, default=3, choices=range(1, 21))
    args = parser.parse_args()
    if not args.query.strip():
        parser.error("--query must not be empty")

    print("Mode: read-only source inspection")
    print("Generating query embedding...", flush=True)
    rows = search_snippets(embed_query(args.query.strip()), limit=args.limit)
    sources = prepare_sources(rows)
    if not sources:
        print("No searchable snippets; comparison was not performed.")
        return 1

    decoded = json.loads(render_context(sources))["sources"]
    if decoded != [source.to_dict() for source in sources]:
        raise AssertionError("JSON/source fields differ")

    with connect_db() as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        conn.row_factory = dict_row
        for row, source in zip(rows, sources):
            actual = conn.execute(
                """
                SELECT id, project_name, file_path, language, function_name,
                       start_line, end_line, code
                FROM public.snippets
                WHERE id = %s
                """,
                (source.id,),
            ).fetchone()
            expected = {name: row[name] for name in STORED_FIELDS}
            if actual != expected:
                raise AssertionError("Search row and current DB row differ")
            if {name: source.to_dict()[name] for name in STORED_FIELDS} != actual:
                raise AssertionError("Source and current DB row differ")
            print(
                f"{source.citation_id}: id={source.id}, "
                f"function={source.function_name}, "
                f"file={source.file_path}:{source.start_line}-{source.end_line}"
            )

    print("DB/source/JSON fields match: True")
    print("Token budget: NOT CHECKED (LLM counter not connected)")
    print("LLM calls: 0")
    print("Read-only Context check: OK")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(
            f"Read-only Context check failed: {type(error).__name__}. "
            "Check local configuration/server logs; do not share credentials.",
            file=sys.stderr,
        )
        raise SystemExit(1) from None
