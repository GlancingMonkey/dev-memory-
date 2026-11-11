import unittest
import json
import re
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.main import app
from backend.llm import LLMServiceError, LLMTimeoutError, ModelAnswer
from rag.context import build_context
from rag.embedding import EmbeddingInputError

DB_SOURCE = {
    "id": 17,
    "project_name": "demo",
    "file_path": "src/math.py",
    "language": "python",
    "function_name": "add",
    "start_line": 1,
    "end_line": 2,
    "code": "def add(a, b):\n    return a + b",
    "score": 0.91,
}
USAGE = {"input_tokens": 120, "output_tokens": 32, "total_tokens": 152}
RAG_CONTEXT = build_context([DB_SOURCE], count_tokens=lambda _: 80)


class AskApiTests(unittest.TestCase):
    def client(self):
        return TestClient(app)

    def test_no_search_results_skip_token_count_and_generation(self):
        with (
            patch("backend.main.warmup_model"),
            patch("backend.routers.ask.embed_query", return_value=[1.0]),
            patch("backend.routers.ask.search_snippets", return_value=[]),
            patch("backend.routers.ask.count_context_tokens") as count_context,
            patch("backend.routers.ask.count_input_tokens") as count_input,
            patch("backend.routers.ask.generate_answer") as generate,
            self.client() as client,
        ):
            response = client.post("/ask", json={"q": "  질문  "})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "insufficient_context")
        self.assertEqual(response.json()["sources"], [])
        self.assertIsNone(response.json()["model"])
        self.assertIsNone(response.json()["usage"])
        count_context.assert_not_called()
        count_input.assert_not_called()
        generate.assert_not_called()

    def test_answer_sources_are_copied_from_db_results(self):
        with (
            patch("backend.main.warmup_model"),
            patch("backend.routers.ask.embed_query", return_value=[1.0]),
            patch("backend.routers.ask.search_snippets", return_value=[DB_SOURCE]),
            patch("backend.routers.ask.build_context", return_value=RAG_CONTEXT),
            patch("backend.routers.ask.count_context_tokens", return_value=80),
            patch("backend.routers.ask.count_input_tokens", return_value=120),
            patch(
                "backend.routers.ask.generate_answer",
                return_value=(
                    ModelAnswer(
                        status="answered",
                        answer="add는 두 값을 더합니다. [S1]",
                        citation_ids=["S1"],
                    ),
                    "gpt-6.1-sol",
                    USAGE,
                ),
            ) as generate,
            self.client() as client,
        ):
            response = client.post("/ask", json={"q": "add는 무엇을 하나요?"})

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "answered")
        self.assertEqual(body["sources"], [{"citation_id": "S1", **DB_SOURCE}])
        self.assertEqual(body["usage"], USAGE)
        generate.assert_called_once()

    def test_unknown_or_unmatched_citation_returns_502(self):
        with (
            patch("backend.main.warmup_model"),
            patch("backend.routers.ask.embed_query", return_value=[1.0]),
            patch("backend.routers.ask.search_snippets", return_value=[DB_SOURCE]),
            patch("backend.routers.ask.build_context", return_value=RAG_CONTEXT),
            patch("backend.routers.ask.count_context_tokens", return_value=80),
            patch("backend.routers.ask.count_input_tokens", return_value=120),
            patch(
                "backend.routers.ask.generate_answer",
                return_value=(
                    ModelAnswer(
                        status="answered",
                        answer="add는 두 값을 더합니다. [S9]",
                        citation_ids=["S9"],
                    ),
                    "gpt-6.1-sol",
                    USAGE,
                ),
            ),
            self.client() as client,
        ):
            response = client.post("/ask", json={"q": "add는 무엇을 하나요?"})

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"]["code"], "llm_response_invalid")

    def test_invalid_embedding_input_returns_422(self):
        with (
            patch("backend.main.warmup_model"),
            patch(
                "backend.routers.ask.embed_query",
                side_effect=EmbeddingInputError("question exceeds limit"),
            ),
            patch("backend.routers.ask.search_snippets") as search,
            self.client() as client,
        ):
            response = client.post("/ask", json={"q": "question"})

        self.assertEqual(response.status_code, 422)
        search.assert_not_called()

    def test_history_larger_than_two_turns_is_rejected(self):
        with (
            patch("backend.main.warmup_model"),
            patch("backend.routers.ask.embed_query") as embed,
            self.client() as client,
        ):
            response = client.post(
                "/ask",
                json={
                    "q": "질문",
                    "history": [
                        {"q": f"q{i}", "answer": f"a{i}"}
                        for i in range(3)
                    ],
                },
            )

        self.assertEqual(response.status_code, 422)
        embed.assert_not_called()

    def test_llm_service_failure_returns_503(self):
        with (
            patch("backend.main.warmup_model"),
            patch("backend.routers.ask.embed_query", return_value=[1.0]),
            patch("backend.routers.ask.search_snippets", return_value=[DB_SOURCE]),
            patch(
                "backend.routers.ask.count_context_tokens",
                side_effect=LLMServiceError,
            ),
            patch("backend.routers.ask.generate_answer") as generate,
            self.client() as client,
        ):
            response = client.post("/ask", json={"q": "add는 무엇을 하나요?"})

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"]["code"], "ask_service_unavailable")
        generate.assert_not_called()

    def test_generation_timeout_returns_504_without_retry(self):
        with (
            patch("backend.main.warmup_model"),
            patch("backend.routers.ask.embed_query", return_value=[1.0]),
            patch("backend.routers.ask.search_snippets", return_value=[DB_SOURCE]),
            patch("backend.routers.ask.build_context", return_value=RAG_CONTEXT),
            patch("backend.routers.ask.count_context_tokens", return_value=80),
            patch("backend.routers.ask.count_input_tokens", return_value=120),
            patch(
                "backend.routers.ask.generate_answer",
                side_effect=LLMTimeoutError,
            ) as generate,
            self.client() as client,
        ):
            response = client.post("/ask", json={"q": "add는 무엇을 하나요?"})

        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.json()["detail"]["code"], "ask_timeout")
        generate.assert_called_once()

    def test_sse_stream_includes_sources_deltas_final_response_and_history_count(self):
        prior = {"q": "앞 질문", "answer": "앞 답변 [S1]"}
        answer = ModelAnswer(
            status="answered",
            answer="add는 두 값을 더합니다. [S1]",
            citation_ids=["S1"],
        )
        with (
            patch("backend.main.warmup_model"),
            patch("backend.routers.ask.embed_query", return_value=[1.0]),
            patch("backend.routers.ask.search_snippets", return_value=[DB_SOURCE]),
            patch("backend.routers.ask.build_context", return_value=RAG_CONTEXT),
            patch("backend.routers.ask.count_context_tokens", return_value=80),
            patch("backend.routers.ask.count_input_tokens", return_value=120) as count_input,
            patch(
                "backend.routers.ask.generate_answer_stream",
                return_value=iter([
                    ("delta", "add는 두 값을 더합니다. "),
                    ("delta", "[S1]"),
                    ("complete", (answer, "gpt-6.1-sol", USAGE)),
                ]),
            ) as generate,
            self.client() as client,
        ):
            response = client.post(
                "/ask",
                json={"q": "add는 무엇을 하나요?", "stream": True, "history": [prior]},
            )

        self.assertEqual(response.status_code, 200)
        self.assertIn("text/event-stream", response.headers["content-type"])
        events = re.findall(r"event: ([^\n]+)", response.text)
        self.assertEqual(events, ["sources", "delta", "delta", "done"])
        done_payload = re.search(r"event: done\ndata: (.+)\n", response.text)
        self.assertIsNotNone(done_payload)
        done = json.loads(done_payload.group(1))
        self.assertEqual(done["history_used"], 1)
        self.assertEqual(done["sources"], [{"citation_id": "S1", **DB_SOURCE}])
        sent_history = json.loads(count_input.call_args.kwargs["messages"][1]["content"])
        self.assertEqual(sent_history["history"], [prior])
        generate.assert_called_once()

    def test_empty_stream_skips_generation_and_emits_sources_then_done(self):
        with (
            patch("backend.main.warmup_model"),
            patch("backend.routers.ask.embed_query", return_value=[1.0]),
            patch("backend.routers.ask.search_snippets", return_value=[]),
            patch("backend.routers.ask.count_context_tokens") as count_context,
            patch("backend.routers.ask.generate_answer_stream") as generate,
            self.client() as client,
        ):
            response = client.post("/ask", json={"q": "질문", "stream": True})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            re.findall(r"event: ([^\n]+)", response.text),
            ["sources", "done"],
        )
        self.assertIn('"history_used": 0', response.text)
        count_context.assert_not_called()
        generate.assert_not_called()

    def test_stream_timeout_becomes_error_event(self):
        with (
            patch("backend.main.warmup_model"),
            patch("backend.routers.ask.embed_query", return_value=[1.0]),
            patch("backend.routers.ask.search_snippets", return_value=[DB_SOURCE]),
            patch("backend.routers.ask.build_context", return_value=RAG_CONTEXT),
            patch("backend.routers.ask.count_context_tokens", return_value=80),
            patch("backend.routers.ask.count_input_tokens", return_value=120),
            patch(
                "backend.routers.ask.generate_answer_stream",
                side_effect=LLMTimeoutError,
            ),
            self.client() as client,
        ):
            response = client.post("/ask", json={"q": "질문", "stream": True})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            re.findall(r"event: ([^\n]+)", response.text),
            ["sources", "error"],
        )
        self.assertIn('"status": 504', response.text)


if __name__ == "__main__":
    unittest.main()
