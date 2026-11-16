"""Prepare only the versioned evaluation snippets; dry-run unless --apply."""
import argparse
import json
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from psycopg.rows import dict_row

from backend.database import connect_db, save_snippet_embedding
from backend.main import app
from rag.embedding import embed_code

DATA = Path(__file__).with_name("samples.json")
FIELDS = ("project_name", "file_path", "language", "function_name",
          "start_line", "end_line", "code")


def code_key(row):
    return (row["project_name"].strip(), row["language"].strip().lower(),
            row["code"].replace("\r\n", "\n").replace("\r", "\n"))


def snapshot():
    with connect_db() as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        conn.row_factory = dict_row
        return conn.execute("""
            SELECT id, project_name, file_path, language, function_name,
                   start_line, end_line, code, embedding::text AS embedding,
                   embedding_status, embedding_error,
                   created_at::text, updated_at::text
            FROM public.snippets ORDER BY id
        """).fetchall()


def bind_samples(samples, rows):
    return {
        sample["sample_id"]: [
            row for row in rows
            if code_key(row) == code_key(sample["snippet"])
        ]
        for sample in samples
    }


def seed_samples(data, *, apply=False):
    before = snapshot()
    bindings = bind_samples(data["snippets"], before)
    actions = []
    allowed_updates = set()
    if not apply:
        return {"mode": "read-only", "actions": [
            {"sample_id": s["sample_id"], "existing_ids": [r["id"] for r in bindings[s["sample_id"]]],
             "needs_preparation": not any(r["embedding"] is not None for r in bindings[s["sample_id"]])}
            for s in data["snippets"]
        ]}
    with (
        patch("backend.main.warmup_model"),
        patch("backend.llm._client") as llm,
        TestClient(app) as client,
    ):
        for sample in data["snippets"]:
            sid = sample["sample_id"]
            found = bindings[sid]
            if any(row["embedding"] is not None for row in found):
                actions.append({"sample_id": sid, "action": "existing", "ids": [r["id"] for r in found if r["embedding"] is not None]})
                continue
            if found:
                row = found[0]
                if row["embedding_status"] not in ("pending", "failed"):
                    raise RuntimeError("Unexpected existing embedding state")
                if row["embedding_error"] == "embedding_input_invalid":
                    raise RuntimeError("Resolve the original input problem before retrying this ID")
                vector = embed_code(row["code"])
                ok = save_snippet_embedding(row["id"], row["project_name"], row["code"], vector)
                if not ok:
                    raise RuntimeError("Guarded retry did not update a row; inspect before repeating")
                allowed_updates.add(row["id"])
                actions.append({"sample_id": sid, "action": "retried_existing_id", "id": row["id"]})
            else:
                response = client.post("/snippets", json=sample["snippet"])
                body = response.json()
                actions.append({"sample_id": sid, "action": "post", "http": response.status_code, "response": body})
                if response.status_code != 200 or body.get("embedding_status") != "ready":
                    raise RuntimeError("Sample preparation did not reach ready; inspect the saved ID")
            print("Prepared evaluation sample:", sid, actions[-1]["action"], flush=True)
        llm.assert_not_called()

    after = snapshot()
    by_id = {row["id"]: row for row in after}
    for original in before:
        current = by_id[original["id"]]
        assert all(current[key] == original[key] for key in FIELDS)
        if original["embedding"] is not None:
            assert current["embedding"] == original["embedding"]
        if original["id"] not in allowed_updates:
            assert current == original, "An unrelated row changed"
    bindings = bind_samples(data["snippets"], after)
    assert all(any(row["embedding"] is not None and row["embedding_status"] == "ready"
                   for row in found) for found in bindings.values())
    return {
        "mode": "apply", "actions": actions, "rows_before": len(before), "rows_after": len(after),
        "original_code_metadata_and_existing_vectors_preserved": True,
        "intentional_retry_ids": sorted(allowed_updates),
        "new_ids": sorted(set(by_id) - {row["id"] for row in before}),
        "bindings": {sid: [row["id"] for row in found if row["embedding"] is not None]
                     for sid, found in bindings.items()},
        "llm_generation_calls": 0,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Output exists; preserve the previous record and choose a new path")
    data = json.loads(DATA.read_text())
    result = seed_samples(data, apply=args.apply)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
