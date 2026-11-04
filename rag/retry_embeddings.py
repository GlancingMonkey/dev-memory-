import argparse

from psycopg.rows import dict_row

from backend.database import connect_db


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Inspect a snippet before retrying its embedding."
    )
    parser.add_argument("--project", required=True)
    parser.add_argument(
        "--id",
        dest="snippet_id",
        type=int,
        required=True,
    )
    args = parser.parse_args()

    if not args.project.strip():
        parser.error("--project must not be empty")
    if args.snippet_id <= 0:
        parser.error("--id must be a positive integer")

    with connect_db() as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        conn.row_factory = dict_row

        row = conn.execute(
            """
            SELECT id, project_name, file_path, function_name,
                   embedding IS NULL AS embedding_missing
            FROM public.snippets
            WHERE id = %s AND project_name = %s
            """,
            (args.snippet_id, args.project),
        ).fetchone()

    print("Mode: read-only")

    if row is None:
        print("No matching snippet for the given id and project.")
        return 1

    for name, value in row.items():
        print(f"{name}: {value}")

    if row["embedding_missing"]:
        print("Result: candidate (embedding is NULL)")
    else:
        print("Result: skip (embedding already exists)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())