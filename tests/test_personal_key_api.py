import json
import asyncio
import unittest
from contextlib import ExitStack
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from backend.llm import LLMKeyError, ModelAnswer
from backend.main import app
from backend.routers.ask import _PersonalStreamingResponse, _streaming_response
from starlette.requests import ClientDisconnect

KEY = "TEST_ONLY_PERSONAL_API_KEY"
SOURCE = {"id": 17, "project_name": "demo", "file_path": "math.py", "language": "python",
          "function_name": "add", "start_line": 1, "end_line": 2,
          "code": "def add(a, b):\n    return a + b", "score": 0.9}
USAGE = {"input_tokens": 120, "output_tokens": 30, "total_tokens": 150}
ANSWER = ModelAnswer(status="answered", answer="더합니다. [S1]", citation_ids=["S1"])


class PersonalKeyApiTests(unittest.TestCase):
    def fixtures(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch("backend.main.warmup_model"))
        stack.enter_context(patch("backend.routers.ask.embed_query", return_value=[1.0]))
        self.search = stack.enter_context(patch("backend.routers.ask.search_snippets", return_value=[SOURCE]))
        self.server_count = stack.enter_context(patch("backend.routers.ask.count_context_tokens"))
        self.server_generate = stack.enter_context(patch("backend.routers.ask.generate_answer"))
        self.session = Mock()
        self.session.count_context_tokens.return_value = 80
        self.session.count_input_tokens.return_value = 120
        self.session.generate_answer.return_value = (ANSWER, "provider-test-snapshot", USAGE)
        self.session.generate_answer_stream.return_value = iter([
            ("delta", ANSWER.answer), ("complete", (ANSWER, "provider-test-snapshot", USAGE)),
        ])
        self.factory = stack.enter_context(patch("backend.request_llm.RequestLLM", return_value=self.session))
        return stack.enter_context(TestClient(app))

    def headers(self, provider="openai"):
        return {"X-LLM-API-Key": KEY, "X-LLM-Provider": provider}

    def test_all_three_providers_use_personal_counts_generation_and_original_sources(self):
        client = self.fixtures()
        for provider in ("openai", "anthropic", "google"):
            response = client.post("/ask", headers=self.headers(provider), json={"q": "설명해줘"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["sources"], [{"citation_id": "S1", **SOURCE}])
            self.assertEqual(response.json()["usage"], USAGE)
            self.factory.assert_called_with(provider, KEY)
        self.assertEqual(self.session.count_context_tokens.call_count, 3)
        self.assertEqual(self.session.count_input_tokens.call_count, 3)
        self.assertEqual(self.session.generate_answer.call_count, 3)
        self.assertEqual(self.session.close.call_count, 3)
        self.server_count.assert_not_called()
        self.server_generate.assert_not_called()

    def test_stream_keeps_session_until_final_event_then_closes(self):
        client = self.fixtures()
        def stream(**kwargs):
            self.session.close.assert_not_called()
            yield "delta", ANSWER.answer
            yield "complete", (ANSWER, "provider-test-snapshot", USAGE)
        self.session.generate_answer_stream.side_effect = stream
        response = client.post("/ask", headers=self.headers(), json={"q": "설명해줘", "stream": True})
        self.assertEqual(response.status_code, 200)
        self.assertIn("event: done", response.text)
        self.session.close.assert_called_once()

    def test_auth_error_before_stream_is_http_401_without_fallback_or_secret(self):
        client = self.fixtures()
        self.session.count_context_tokens.side_effect = LLMKeyError(401)
        response = client.post("/ask", headers=self.headers(), json={"q": "설명해줘", "stream": True})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["detail"]["code"], "llm_key_invalid")
        self.assertNotIn(KEY, response.text)
        self.session.generate_answer_stream.assert_not_called()
        self.server_generate.assert_not_called()
        self.session.close.assert_called_once()

    def test_permission_error_is_http_403_without_provider_exception(self):
        client = self.fixtures()
        self.session.generate_answer.side_effect = LLMKeyError(403)
        response = client.post("/ask", headers=self.headers("anthropic"), json={"q": "설명해줘"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["detail"]["code"], "llm_key_forbidden")
        self.assertNotIn(KEY, response.text)
        self.session.close.assert_called_once()

    def test_auth_error_after_stream_is_safe_error_event_without_done(self):
        client = self.fixtures()
        def stream(**kwargs):
            raise LLMKeyError(401)
            yield
        self.session.generate_answer_stream.side_effect = stream
        response = client.post("/ask", headers=self.headers(), json={"q": "설명해줘", "stream": True})
        self.assertEqual(response.status_code, 200)
        self.assertIn('"status": 401', response.text)
        self.assertIn('"code": "llm_key_invalid"', response.text)
        self.assertNotIn("event: done", response.text)
        self.assertNotIn(KEY, response.text)
        self.session.close.assert_called_once()

    def test_no_sources_skip_provider_calls_and_close_session(self):
        client = self.fixtures()
        self.search.return_value = []
        response = client.post("/ask", headers=self.headers("google"), json={"q": "설명해줘"})
        self.assertEqual(response.json()["status"], "insufficient_context")
        self.assertIsNone(response.json()["usage"])
        self.session.count_context_tokens.assert_not_called()
        self.session.generate_answer.assert_not_called()
        self.session.close.assert_called_once()

    def test_partial_headers_are_rejected_before_retrieval_and_do_not_echo_key(self):
        client = self.fixtures()
        response = client.post("/ask", headers={"X-LLM-API-Key": KEY}, json={"q": "설명해줘"})
        self.assertEqual(response.status_code, 401)
        self.assertNotIn(KEY, response.text)
        self.factory.assert_not_called()
        self.search.assert_not_called()

    def test_disconnected_stream_closes_personal_client(self):
        session = Mock()
        response = _PersonalStreamingResponse(_streaming_response(iter(["data: test\n\n"])), session)
        async def send(message):
            raise OSError("client disconnected")
        async def receive():
            return {"type": "http.disconnect"}
        scope = {"type": "http", "asgi": {"spec_version": "2.4"}}
        with self.assertRaises(ClientDisconnect):
            asyncio.run(response(scope, receive, send))
        session.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
