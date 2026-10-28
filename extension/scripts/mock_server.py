# 백엔드 나오기 전까지 POST /snippets 를 받아주는 가짜 서버 (파이썬 기본 기능만 사용)
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from itertools import count

ids = count(1)
REQUIRED = ["project_name", "file_path", "language", "function_name",
            "start_line", "end_line", "code"]

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/snippets":
            self._json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")

        missing = [k for k in REQUIRED if k not in body]
        if missing:
            self._json(422, {"error": f"필드 누락: {missing}"})
            return

        new_id = next(ids)
        print(f"\n[받음] id={new_id}")
        print(json.dumps(body, ensure_ascii=False, indent=2))
        self._json(201, {"id": new_id})

    def _json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass   # 기본 접속 로그는 끔

print("mock server → http://localhost:8000  (Ctrl+C 로 종료)")
HTTPServer(("0.0.0.0", 8000), Handler).serve_forever()