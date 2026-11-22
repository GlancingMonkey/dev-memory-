"""One-attempt API measurements and original-data checks for deadline evaluation."""
import json
from dataclasses import asdict
from pathlib import Path
from time import monotonic
from unittest.mock import patch

import backend.routers.ask as ask_api
from backend.llm import count_context_tokens, count_input_tokens
from rag.context import build_context, build_rag_messages
from rag.experiments.deadline_eval.seed import FIELDS


def write_json(path, value):
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    tmp.replace(path)


def trial(client, query, mode, expected_rows, output, limit):
    path = output / (query["query_id"] + "." + mode + ".json")
    if path.exists():
        # A started record is never automatically replayed: billing is uncertain.
        return json.loads(path.read_text())
    write_json(path, {"state": "started", "query_id": query["query_id"], "mode": mode,
                      "note": "Do not automatically retry an interrupted generation."})
    stages = {}
    captured = {}
    token_calls = {"reference": 0, "input": 0}
    real_embed = ask_api.embed_query
    real_search = ask_api.search_snippets
    real_context_count = ask_api.count_context_tokens
    real_input_count = ask_api.count_input_tokens
    real_generate = ask_api.generate_answer

    def measured(name, fn, *args, **kwargs):
        started = monotonic()
        try:
            return fn(*args, **kwargs)
        finally:
            stages[name] = stages.get(name, 0) + monotonic() - started

    def embed(*args, **kwargs):
        return measured("embedding", real_embed, *args, **kwargs)

    def search(*args, **kwargs):
        rows = measured("database_search", real_search, *args, **kwargs)
        captured["candidates"] = rows
        return rows

    def reference(*args, **kwargs):
        token_calls["reference"] += 1
        return measured("reference_count", real_context_count, *args, **kwargs)

    def final_count(*args, **kwargs):
        token_calls["input"] += 1
        value = measured("input_count", real_input_count, *args, **kwargs)
        captured["full_input_tokens"] = value
        return value

    def context(rows, **kwargs):
        value = build_context(rows, deduplicate=mode == "optimized", **kwargs)
        captured["context"] = value
        return value

    def generate(*args, **kwargs):
        captured["generation_called"] = True
        answer, model, usage = measured("generation", real_generate, *args, **kwargs)
        captured["provider_result"] = {"answer": answer.model_dump(), "model": model, "usage": usage}
        return answer, model, usage

    started = monotonic()
    with (
        patch.object(ask_api, "embed_query", embed),
        patch.object(ask_api, "search_snippets", search),
        patch.object(ask_api, "count_context_tokens", reference),
        patch.object(ask_api, "count_input_tokens", final_count),
        patch.object(ask_api, "build_context", context),
        patch.object(ask_api, "generate_answer", generate),
    ):
        response = client.post("/ask", json={"q": query["question"], "limit": limit})
    seconds = monotonic() - started
    body = response.json()
    ctx = captured.get("context")
    source_match = all(
        source["id"] in expected_rows
        and all(source[field] == expected_rows[source["id"]][field] for field in FIELDS)
        for source in body.get("sources", [])
    )
    record = {
        "state": "finished", "query_id": query["query_id"], "mode": mode,
        "question": query["question"], "expected_status": query["expected_status"],
        "expected_summary": query["expected_summary"], "http_status": response.status_code,
        "response": body, "api_seconds": seconds, "stage_seconds": stages,
        "token_count_calls": token_calls, "candidate_rows": captured.get("candidates", []),
        "selected_ids": [s.id for s in ctx.sources] if ctx else [],
        "exclusions": [asdict(x) for x in ctx.exclusions] if ctx else [],
        "reference_tokens": ctx.token_count if ctx else 0,
        "full_input_tokens": captured.get("full_input_tokens"),
        "generation_called": captured.get("generation_called", False),
        "provider_result": captured.get("provider_result"),
        "source_fields_match_database": source_match,
        "quality_review": None,
    }
    write_json(path, record)
    return record


def budget_probe(candidates):
    calls = []
    deadline = monotonic() + 120

    def counter(text):
        started = monotonic()
        value = count_context_tokens(context=text, deadline=deadline)
        calls.append({"tokens": value, "seconds": monotonic() - started})
        return value
    context = build_context(candidates, count_tokens=counter, token_budget=512)
    assert context.token_count <= 512
    original = {row["id"]: row for row in candidates}
    assert all(all(s.to_dict()[field] == original[s.id][field] for field in FIELDS)
               for s in context.sources)
    input_tokens = count_input_tokens(
        messages=build_rag_messages("참고 코드의 동작을 설명해줘", context),
        deadline=deadline,
    ) if context.has_sources else 0
    return {
        "purpose": "Real reference-token boundary check; not the production 4000-token setting",
        "token_budget": 512, "reference_tokens": context.token_count,
        "full_input_tokens": input_tokens,
        "selected_ids": [s.id for s in context.sources],
        "exclusions": [asdict(x) for x in context.exclusions],
        "calls": calls, "generation_calls": 0, "original_fields_preserved": True,
    }
