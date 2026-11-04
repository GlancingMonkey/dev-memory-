"""실행 중인 Backend와 실제 DB를 검사한다. 긴 코드 테스트 행 하나를 추가한다."""

import json
import math
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from psycopg.rows import dict_row

from backend.database import connect_db

BASE_URL = "http://127.0.0.1:8000"
NORMAL_PAYLOAD = {
    "project_name": "mvp-auto-test-1104",
    "file_path": "safe_divide.py",
    "language": "python",
    "function_name": "safe_divide",
    "start_line": 1,
    "end_line": 4,
    "code": "def safe_divide(a, b):\n    if b == 0:\n        return None\n    return a / b",
}
SNAPSHOT_SQL = """
    SELECT id, project_name, file_path, language, function_name,
           start_line, end_line, code, created_at, updated_at,
           embedding::text AS embedding_text,
           embedding_status, embedding_error
    FROM public.snippets
    ORDER BY id
"""


def request_json(method, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(
        BASE_URL + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=30) as response:
            status = response.status
            text = response.read().decode("utf-8")
    except HTTPError as error:
        status = error.code
        text = error.read().decode("utf-8")
    try:
        body = json.loads(text)
    except json.JSONDecodeError:
        body = {"detail": text[:300]}
    return status, body


def take_snapshot():
    with connect_db() as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        conn.row_factory = dict_row
        return {row["id"]: row for row in conn.execute(SNAPSHOT_SQL)}



def main():
    health_status, health_body = request_json("GET", "/health")
    if health_status != 200 or health_body != {"status": "ok"}:
        raise RuntimeError(f"Backend health check failed: {health_body}")

    before = take_snapshot()
    normal_rows = [
        row for row in before.values()
        if all(row[key] == value for key, value in NORMAL_PAYLOAD.items())
        and row["embedding_status"] == "ready"
        and row["embedding_text"] is not None
    ]
    if not normal_rows:
        raise RuntimeError("Previously verified safe_divide snippet was not found")
    target = max(normal_rows, key=lambda row: row["id"])

    long_code = "value = 1\n" * 600
    long_payload = {
        "project_name": "auto-embedding-input-limit-test",
        "file_path": "long_input_probe.py",
        "language": "python",
        "function_name": None,
        "start_line": 1,
        "end_line": 600,
        "code": long_code,
    }

    print("Sending one long-code test request...", flush=True)
    save_status, save_body = request_json("POST", "/snippets", long_payload)
    print("Long input HTTP:", save_status)
    print("Long input response:", json.dumps(save_body, ensure_ascii=False))

    if save_status != 200 or not isinstance(save_body, dict):
        raise RuntimeError("Long-input request did not return the expected HTTP 200")
    long_id = save_body.get("id")
    if type(long_id) is not int or long_id <= 0 or long_id in before:
        raise RuntimeError("Expected a newly saved snippet ID")
    if save_body != {
        "id": long_id,
        "message": "snippet saved",
        "embedding_status": "failed",
        "embedding_error": "embedding_input_invalid",
    }:
        raise RuntimeError("Real input-limit handling did not match the API contract")

    question = "0으로 나누면 None을 반환하는 나눗셈 함수 찾아줘"
    print("Searching for the previously saved safe_divide snippet...", flush=True)
    search_status, search_body = request_json(
        "GET", "/search?" + urlencode({"q": question, "limit": 20})
    )
    if search_status != 200:
        raise RuntimeError(f"Search failed: HTTP {search_status}, {search_body}")
    results = search_body.get("results")
    if not isinstance(results, list) or len(results) > 20:
        raise RuntimeError("Invalid search results structure")

    scores = [item["score"] for item in results]
    if not all(math.isfinite(score) and -1 <= score <= 1 for score in scores):
        raise RuntimeError("Invalid search score")
    if scores != sorted(scores, reverse=True):
        raise RuntimeError("Search scores are not in descending order")
    if any(item["id"] == long_id for item in results):
        raise RuntimeError("A snippet without an embedding appeared in search")

    matches = [item for item in results if item["id"] == target["id"]]
    if len(matches) != 1:
        raise RuntimeError("Previously saved safe_divide was not found in Top-20")
    if any(matches[0][key] != value for key, value in NORMAL_PAYLOAD.items()):
        raise RuntimeError("Search returned different code or metadata")

    after = take_snapshot()
    stored = after.get(long_id)
    if stored is None or any(stored[key] != value for key, value in long_payload.items()):
        raise RuntimeError("Full long-input code or metadata was not preserved")
    if (
        stored["embedding_status"] != "failed"
        or stored["embedding_error"] != "embedding_input_invalid"
        or stored["embedding_text"] is not None
    ):
        raise RuntimeError("Long-input DB state is incorrect")
    if any(after.get(snippet_id) != row for snippet_id, row in before.items()):
        raise RuntimeError("An existing snippet changed during the checks")

    rank = next(index for index, item in enumerate(results, 1) if item["id"] == target["id"])
    print("\nLong input test id:", long_id)
    print("Full long code preserved: True")
    print("Real input limit handling: OK")
    print("Search target id:", target["id"])
    print("Search target rank:", rank)
    print("Semantic search regression: OK")
    print("Existing rows preserved: True")
    print("Manual input/search checks: OK")


if __name__ == "__main__":
    main()