"""Tiny local dense-retrieval comparison. No DB, storage API, or generation."""
import argparse
import csv
import hashlib
import importlib.metadata
import json
import platform
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter

import numpy as np

MODELS = {
    "e5": ("intfloat/multilingual-e5-base", 768),
    "bge": ("BAAI/bge-m3", 1024),
    "qwen": ("Qwen/Qwen3-Embedding-0.6B", 1024),
}
QWEN_INSTRUCTION = (
    "Instruct: Given a software development question, retrieve relevant "
    "documentation or source code that answers the question.\nQuery: "
)
BASE = Path(__file__).resolve().parent


def prepare(texts, model_key, query=False):
    if model_key == "e5":
        prefix = "query: " if query else "passage: "
    else:
        prefix = QWEN_INSTRUCTION if model_key == "qwen" and query else ""
    return [prefix + text for text in texts]


def read_samples(path):
    raw = path.read_bytes()
    data = json.loads(raw.decode("utf-8-sig"))
    docs, queries = data["documents"], data["queries"]
    ids = [d["id"] for d in docs]
    assert len(ids) >= 3 and len(set(ids)) == len(ids), "Need 3+ unique documents"
    assert queries and len({q["id"] for q in queries}) == len(queries)
    assert all(d["text"].strip() for d in docs)
    assert all(q["expected"] in ids and q["text"].strip() for q in queries)
    assert all(q["group"] in {"ko_doc", "ko_code", "en_code"} for q in queries)
    return docs, queries, hashlib.sha256(raw).hexdigest()


def evaluate(doc_vectors, query_vectors, docs, queries):
    scores = query_vectors @ doc_vectors.T  # Cosine, because both are normalized.
    rows = []
    for q, similarities in zip(queries, scores):
        order = np.argsort(-similarities, kind="stable")
        rank = next(i + 1 for i, j in enumerate(order) if docs[j]["id"] == q["expected"])
        rows.append({
            "query_id": q["id"], "group": q["group"], "query": q["text"],
            "expected": q["expected"], "expected_rank": rank,
            "hit_at_1": int(rank == 1), "hit_at_3": int(rank <= 3),
            "reciprocal_rank": 1 / rank,
            "top3": [{"id": docs[j]["id"], "score": float(similarities[j])} for j in order[:3]],
        })
    groups = {}
    for group in ["all", *sorted({q["group"] for q in queries})]:
        selected = rows if group == "all" else [r for r in rows if r["group"] == group]
        groups[group] = {"n": len(selected), **{
            name: float(np.mean([r[key] for r in selected]))
            for name, key in [("hit_at_1", "hit_at_1"), ("hit_at_3", "hit_at_3"), ("mrr", "reciprocal_rank")]
        }}
    return rows, groups


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=MODELS, default="e5")
    parser.add_argument("--samples", type=Path, default=BASE / "samples.json")
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--revision", default="main", help="Use a model commit SHA to reproduce a run")
    parser.add_argument("--offline", action="store_true", help="Only use cached model files")
    parser.add_argument("--check-data", action="store_true", help="Validate samples without loading a model")
    args = parser.parse_args()
    if args.repeats < 1 or args.threads < 1:
        parser.error("repeats and threads must be positive")
    docs, queries, data_hash = read_samples(args.samples)
    if args.check_data:
        print(f"OK: {len(docs)} documents, {len(queries)} queries; SHA256={data_hash}")
        return

    import torch
    from sentence_transformers import SentenceTransformer

    torch.set_num_threads(args.threads)
    if args.device == "cuda" and not torch.cuda.is_available():
        parser.error("CUDA is unavailable; use --device cpu")
    model_id, expected_dim = MODELS[args.model]
    start = perf_counter()
    model = SentenceTransformer(
        model_id, device=args.device, revision=args.revision,
        cache_folder=str(BASE / "cache"), local_files_only=args.offline,
        trust_remote_code=False, model_kwargs={"torch_dtype": torch.float32},
    )
    load_seconds = perf_counter() - start  # Includes download if files are not cached.
    model.max_seq_length = 512
    doc_inputs = prepare([d["text"] for d in docs], args.model)
    query_inputs = prepare([q["text"] for q in queries], args.model, query=True)
    lengths = [len(model.tokenizer(t, truncation=False)["input_ids"]) for t in doc_inputs + query_inputs]
    if max(lengths) > 512:
        raise ValueError("Sample exceeds 512 tokens, including prefix. Shorten it before comparing.")

    def sync():
        if args.device == "cuda":
            torch.cuda.synchronize()

    def timed_encode(texts, batch_size):
        sync()
        start = perf_counter()
        vectors = model.encode(
            texts, batch_size=batch_size, prompt="", normalize_embeddings=True,
            convert_to_numpy=True, show_progress_bar=False,
        )
        sync()
        return vectors, (perf_counter() - start) * 1000

    # Warm both corpus-batch and single-query paths; do not count warm-up.
    timed_encode(doc_inputs, 4)
    timed_encode(query_inputs[:1], 1)
    doc_ms, query_ms, query_vectors = [], [], []
    for repeat in range(args.repeats):
        doc_vectors, elapsed = timed_encode(doc_inputs, 4)
        doc_ms.append(elapsed)
        for text in query_inputs:
            vector, elapsed = timed_encode([text], 1)
            query_ms.append(elapsed)
            if repeat == 0:
                query_vectors.append(vector[0])
    assert doc_vectors.shape == (len(docs), expected_dim), "Unexpected vector dimension"
    rows, quality = evaluate(doc_vectors, np.asarray(query_vectors), docs, queries)
    result = {
        "model": model_id, "requested_revision": args.revision,
        "resolved_revision": getattr(model[0].auto_model.config, "_commit_hash", None),
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "device": args.device, "dtype": str(next(model.parameters()).dtype),
        "hardware": torch.cuda.get_device_name() if args.device == "cuda" else platform.processor(),
        "platform": platform.platform(), "python": platform.python_version(),
        "packages": {p: importlib.metadata.version(p) for p in ["torch", "sentence-transformers", "transformers", "numpy"]},
        "dimension": int(doc_vectors.shape[1]), "max_tokens": 512,
        "max_observed_tokens": max(lengths), "normalized": True,
        "threads": args.threads, "document_batch_size": 4, "query_batch_size": 1,
        "repeats": args.repeats, "data_sha256": data_hash,
        "query_prefix": prepare([""], args.model, query=True)[0],
        "document_prefix": prepare([""], args.model)[0],
        "load_seconds_including_possible_download": load_seconds,
        "query_encoding_p50_ms": float(np.percentile(query_ms, 50)),
        "query_encoding_p95_ms": float(np.percentile(query_ms, 95)),
        "document_encoding_docs_per_second": len(docs) / (float(np.median(doc_ms)) / 1000),
        "document_batch_ms_raw": doc_ms, "query_ms_raw": query_ms,
        "quality": quality, "per_query": rows,
    }
    out = BASE / "results" / (args.model + "_" + datetime.now().strftime("%Y%m%d_%H%M%S_%f"))
    out.mkdir(parents=True, exist_ok=False)
    (out / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    with (out / "per_query.csv").open("w", newline="", encoding="utf-8-sig") as stream:
        fields = ["query_id", "group", "query", "expected", "expected_rank", "hit_at_1", "hit_at_3", "reciprocal_rank", "top3"]
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({**row, "top3": json.dumps(row["top3"], ensure_ascii=False)})
    print(json.dumps({"model": model_id, "dimension": expected_dim, "quality": quality,
                      "query_p50_ms": result["query_encoding_p50_ms"],
                      "query_p95_ms": result["query_encoding_p95_ms"]}, ensure_ascii=False, indent=2))
    print(f"Results: {out}")


if __name__ == "__main__":
    main()
