"""Evaluate existing E5 retrieval; --ask explicitly enables at most 50 generations."""
import argparse
import hashlib
import json
import platform
import statistics
import subprocess
from importlib.metadata import version
from pathlib import Path
from time import monotonic
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.llm import MODEL, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS
from backend.main import app
from rag.context import DEFAULT_CONTEXT_BUDGET, RAG_INSTRUCTIONS
from rag.embedding import MODEL_NAME, MODEL_REVISION, _load_model, warmup_model
from rag.experiments.deadline_eval.measure import budget_probe, trial, write_json
from rag.experiments.deadline_eval.seed import DATA, bind_samples, snapshot


def retrieval_summary(records):
    positives = [r for r in records if r["expected_ids"]]
    negatives = [r for r in records if not r["expected_ids"]]
    return {
        "answerable_questions": len(positives), "unsupported_questions": len(negatives),
        "hit_at_1_count": sum(r["rank"] == 1 for r in positives),
        "hit_at_3_count": sum(r["rank"] is not None and r["rank"] <= 3 for r in positives),
        "unsupported_retrieval_nonempty_count": sum(bool(r["results"]) for r in negatives),
        "search_median_seconds": statistics.median(r["seconds"] for r in records) if records else None,
    }


def generation_summary(records):
    complete = [r for r in records if r.get("state") == "finished"]
    usable = [r for r in complete if r["http_status"] == 200]
    usage = [r["provider_result"]["usage"] for r in complete if r.get("provider_result")]
    positives = [r for r in complete if r["expected_status"] == "answered"]
    negatives = [r for r in complete if r["expected_status"] == "insufficient_context"]
    return {
        "attempt_records": len(records), "finished": len(complete), "http_200": len(usable),
        "answerable_expected_source_hit": sum(r.get("expected_source_hit") is True for r in positives),
        "answerable_denominator": len(positives),
        "unsupported_status_correct": sum(r["response"].get("status") == "insufficient_context" for r in negatives),
        "unsupported_denominator": len(negatives),
        "source_fields_match_database": sum(r["source_fields_match_database"] for r in usable),
        "provider_usage_known_count": len(usage),
        "provider_tokens": {k: sum(u[k] for u in usage) for k in ("input_tokens", "output_tokens", "total_tokens")},
        "median_api_seconds": statistics.median(r["api_seconds"] for r in complete) if complete else None,
        "content_accuracy": "Requires separate review; source-hit is not answer correctness",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ask", action="store_true")
    parser.add_argument("--budget-probe", action="store_true")
    parser.add_argument("--limit", type=int, default=10, choices=range(1, 21))
    parser.add_argument("--max-questions", type=int, default=25)
    args = parser.parse_args()
    data = json.loads(DATA.read_text())
    if not 1 <= args.max_questions <= len(data["queries"]):
        parser.error("max-questions must be between 1 and the versioned question count")
    queries = data["queries"][:args.max_questions]
    rows_before = snapshot()
    rows_by_id = {row["id"]: row for row in rows_before}
    bindings = bind_samples(data["snippets"], rows_before)
    ready_ids = {sid: [r["id"] for r in found if r["embedding"] is not None]
                 for sid, found in bindings.items()}
    if any(not ids for ids in ready_ids.values()):
        parser.error("Some versioned samples are missing vectors. Inspect seed.py --help first.")

    args.output.mkdir(parents=True, exist_ok=True)
    code_paths = [
        "backend/database.py", "backend/routers/search.py", "backend/routers/ask.py",
        "backend/routers/filters.py", "backend/schemas/search.py", "backend/schemas/filters.py",
        "backend/llm.py", "rag/context.py", "rag/embedding.py",
        "rag/experiments/deadline_eval/measure.py", "rag/experiments/deadline_eval/evaluate.py",
    ]
    manifest = {
        "base_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "code_sha256": {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in code_paths},
        "samples_sha256": hashlib.sha256(DATA.read_bytes()).hexdigest(),
        "database_sha256": hashlib.sha256(json.dumps(rows_before, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
        "question_count": len(queries), "limit": args.limit, "generation_enabled": args.ask,
        "embedding_model": MODEL_NAME, "embedding_revision": MODEL_REVISION,
        "model": MODEL, "reasoning": "low", "context_budget": DEFAULT_CONTEXT_BUDGET,
        "input_limit": MAX_INPUT_TOKENS, "max_output_tokens": MAX_OUTPUT_TOKENS,
        "prompt_sha256": hashlib.sha256(RAG_INSTRUCTIONS.encode()).hexdigest(),
        "comparison": "Only exact-code selection differs; request count cache enabled in both modes",
        "timing": "In-process FastAPI elapsed time includes retrieval, counting, generation and validation; excludes startup/TCP/UI",
        "python": platform.python_version(),
        "libraries": {p: version(p) for p in ["torch", "sentence-transformers", "transformers", "numpy", "openai"]},
        "bindings": ready_ids,
    }
    manifest_path = args.output / "manifest.json"
    if manifest_path.exists():
        if json.loads(manifest_path.read_text()) != manifest:
            parser.error("Run conditions changed. Preserve this result and choose a new output directory.")
    else:
        write_json(manifest_path, manifest)
    cached_before = _load_model.cache_info().currsize > 0
    started = monotonic()
    warmup_model()
    write_json(args.output / "warmup.json", {"seconds": monotonic() - started, "model_already_loaded": cached_before})
    retrieval = []
    generations = {"baseline": [], "optimized": []}
    service_failure_pairs = 0
    generation_blocked = False
    with patch("backend.main.warmup_model"), TestClient(app) as client:
        options = client.get("/filters")
        assert options.status_code == 200
        write_json(args.output / "filter-options.json", options.json())
        for index, query in enumerate(queries):
            qid = query["query_id"]
            expected_ids = sorted({i for sid in query["expected_samples"] for i in ready_ids[sid]})
            path = args.output / (qid + ".retrieval.json")
            if path.exists():
                found = json.loads(path.read_text())
            else:
                started = monotonic()
                response = client.get("/search", params={"q": query["question"], "limit": args.limit})
                seconds = monotonic() - started
                assert response.status_code == 200, (qid, response.status_code)
                results = response.json()["results"]
                rank = next((n for n, row in enumerate(results, 1) if row["id"] in expected_ids), None)
                found = {"query_id": qid, "question": query["question"], "expected_ids": expected_ids,
                         "rank": rank, "seconds": seconds, "results": results}
                write_json(path, found)
            retrieval.append(found)
            if args.ask and not generation_blocked:
                order = ["baseline", "optimized"] if index % 2 == 0 else ["optimized", "baseline"]
                pair = []
                for mode in order:
                    record = trial(client, query, mode, rows_by_id, args.output, args.limit)
                    if record.get("state") == "finished":
                        record["expected_ids"] = expected_ids
                        record["expected_source_hit"] = (
                            bool(set(expected_ids) & {s["id"] for s in record["response"].get("sources", [])})
                            if expected_ids else None
                        )
                        record["same_retrieved_candidates"] = [
                            r["id"] for r in record["candidate_rows"]
                        ] == [r["id"] for r in found["results"]]
                        write_json(args.output / (qid + "." + mode + ".json"), record)
                    generations[mode].append(record)
                    pair.append(record)
                    print(qid, mode, "HTTP", record.get("http_status"), "reference", record.get("reference_tokens"), flush=True)
                if all(r.get("http_status") == 503 for r in pair):
                    service_failure_pairs += 1
                    if service_failure_pairs >= 2:
                        generation_blocked = True
                        print("Generation paused after repeated service failures; retrieval continues.", flush=True)
                else:
                    service_failure_pairs = 0
            print("Retrieval", qid, "rank", found["rank"], flush=True)
        if args.budget_probe:
            path = args.output / "budget-probe.json"
            if not path.exists():
                response = client.get("/search", params={"q": queries[0]["question"], "limit": 20})
                assert response.status_code == 200
                write_json(path, budget_probe(response.json()["results"]))
    assert snapshot() == rows_before, "DB changed during read-only evaluation"

    by_mode = {m: {r["query_id"]: r for r in values} for m, values in generations.items()}
    paired = []
    for query in queries:
        pair = [by_mode[m].get(query["query_id"], {}) for m in ("baseline", "optimized")]
        if all(r.get("state") == "finished" and r.get("http_status") == 200
               and r.get("same_retrieved_candidates") for r in pair):
            paired.append(pair)
    before = sum(pair[0]["reference_tokens"] for pair in paired)
    after = sum(pair[1]["reference_tokens"] for pair in paired)
    summary = {
        "retrieval": retrieval_summary(retrieval),
        "generation": {m: generation_summary(values) for m, values in generations.items()},
        "paired_success_count": len(paired), "paired_reference_tokens_before": before,
        "paired_reference_tokens_after": after,
        "weighted_reference_saving_percent": (before - after) / before * 100 if before else None,
        "generation_blocked": generation_blocked, "database_preserved": True,
        "note": "One observation per question/mode. Small curated dataset; no general superiority claim or UI timing.",
    }
    write_json(args.output / "summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
