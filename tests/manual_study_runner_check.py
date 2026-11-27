"""Opt-in real isolated execution checks; no DB or paid model calls.

At repository root:
uv run --locked python - --apply < tests/manual_study_runner_check.py
Build backend/runner's image first. Only generated runner containers are used.
"""

import argparse
import json
import os
from pathlib import Path
import subprocess
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.routers.study import router


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    if not parser.parse_args().apply:
        print("No execution. Use --apply after building the isolated runner image.")
        return 0
    app = FastAPI()
    app.include_router(router)
    records = []
    with patch.dict(os.environ, {"STUDY_RUNNER_ENABLED":"true", "OPENAI_API_KEY":"TEST_ONLY_HOST_SECRET"}), TestClient(app) as client:
        def request(label, mode, code, language="python", status=200, **fields):
            response = client.post("/study/" + mode, json={"code":code,"language":language,"function_name":None,**fields})
            assert response.status_code == status, (label, response.status_code, response.text)
            body = response.json()
            records.append({"label":label,"mode":mode,"status":response.status_code,"body":body})
            print(label + ": OK", flush=True)
            return body

        for language, code in (
            ("python", "def add(a,b):\n    return a + b"),
            ("typescript", "function add(a: number,b: number): number {\n const total=a+b;\n return total;\n}"),
            ("javascript", "function add(a,b) {\n return a+b;\n}"),
        ):
            result = request(language+" trace", "trace", code, language, call="add(1,2)")
            assert result["value"] == "3" and 1 <= len(result["steps"]) <= 400
            result = request(language+" run", "run", code, language, tests=[{"call":"add(1,2)","expected":"3"}])
            assert result["cases"][0]["ok"] is True
        for language, code in (
            ("python", "def count():\n    i=0\n    while True:\n        i+=1"),
            ("typescript", "function count(): void {\n let i=0;\n while(true) { i++; }\n}"),
        ):
            result = request(language+" 400-step cap", "trace", code, language, call="count()")
            assert result["truncated"] is True and len(result["steps"]) <= 400
            result = request(language+" run step cap", "run", code, language, calls=["count()"])
            assert result["cases"][0]["error"]
        result = request("runtime exception", "run", "def fail():\n    return 1/0", calls=["fail()"])
        assert "ZeroDivisionError" in result["cases"][0]["error"]
        request("syntax error", "trace", "def fail(:", status=422, call="fail()")
        request("5-second timeout", "trace", "import time\ndef wait():\n    time.sleep(30)", status=504, call="wait()")
        result = request("no host files, socket or keys", "run",
            "import os\ndef probe():\n    return [os.getuid(),os.path.exists('/workspaces/capstone-rag'),os.path.exists('/var/run/docker.sock'),os.getenv('OPENAI_API_KEY')]", calls=["probe()"])
        assert result["cases"][0]["output"] == "[65534, False, False, None]"
        result = request("read-only filesystem", "run", "def write():\n    open('/runner/blocked', 'w').write('x')", calls=["write()"])
        assert result["cases"][0]["error"]
        result = request("external network blocked", "run", "import socket\ndef connect():\n    s=socket.socket(); s.settimeout(0.2)\n    return s.connect_ex(('1.1.1.1',80))", calls=["connect()"])
        assert result["cases"][0]["output"] != "0"
        request("bounded stdout", "trace", "import os\ndef flood():\n    os.write(1, b'x'*5000000)", status=422, call="flood()")
    path = Path("out/reports/2026-11-27-study")
    path.mkdir(parents=True, exist_ok=True)
    (path / "isolated-runner-check.json").write_text(json.dumps(records,ensure_ascii=False,indent=2))
    print(f"Isolated runner checks: {len(records)} passed; DB/LLM calls: 0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
