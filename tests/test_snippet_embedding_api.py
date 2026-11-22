import unittest
from contextlib import ExitStack
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.routers.snippets import router
from rag.embedding import EmbeddingInputError

# API 동작 검증용 가짜 값이다. 실제 DB나 모델 성능 측정에 사용하지 않는다.
TEST_ID = 123
FAKE_VECTOR = [1.0] + [0.0] * 767
INTERNAL_ERROR = "TEST_INTERNAL_FAILURE"
PAYLOAD = {
    "project_name": "snippet-api-unit-test",
    "file_path": "sample.py",
    "language": "python",
    "function_name": "add",
    "start_line": 1,
    "end_line": 2,
    "code": "def add(a, b):\n    return a + b",
}
READY_STATE = {
    "embedding_status": "ready",
    "embedding_error": None,
    "embedding_missing": False,
    "embedding_valid": True,
}
FAILED_STATE = {
    "embedding_status": "failed",
    "embedding_error": "embedding_generation_failed",
    "embedding_missing": True,
    "embedding_valid": False,
}


class SnippetEmbeddingApiTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)

        defaults = {
            "insert_snippet": TEST_ID,
            "embed_code": FAKE_VECTOR,
            "save_snippet_embedding": True,
            "mark_snippet_embedding_failed": True,
            "get_snippet_embedding_state": None,
        }
        self.calls = {
            name: self.stack.enter_context(
                patch(
                    f"backend.routers.snippets.{name}",
                    return_value=value,
                )
            )
            for name, value in defaults.items()
        }
        self.stack.enter_context(patch("backend.routers.snippets.logger"))

        app = FastAPI()
        app.include_router(router)
        self.client = self.stack.enter_context(TestClient(app))

    def check_saved_response(self, response, http_status, state, error):
        self.assertEqual(response.status_code, http_status)
        self.assertEqual(
            response.json(),
            {
                "id": TEST_ID,
                "message": "snippet saved",
                "embedding_status": state,
                "embedding_error": error,
            },
        )
        self.assertNotIn(INTERNAL_ERROR, response.text)

    def check_recorded_failure(self, error_code):
        response = self.client.post("/snippets", json=PAYLOAD)
        self.check_saved_response(response, 200, "failed", error_code)
        self.calls["insert_snippet"].assert_called_once()
        self.calls["mark_snippet_embedding_failed"].assert_called_once_with(
            snippet_id=TEST_ID,
            project_name=PAYLOAD["project_name"],
            expected_code=PAYLOAD["code"],
            error_code=error_code,
        )

    def test_ready_response_and_original_code_forwarding(self):
        response = self.client.post("/snippets", json=PAYLOAD)
        self.check_saved_response(response, 200, "ready", None)
        self.calls["insert_snippet"].assert_called_once()
        self.calls["embed_code"].assert_called_once_with(PAYLOAD["code"])
        self.calls["save_snippet_embedding"].assert_called_once_with(
            snippet_id=TEST_ID,
            project_name=PAYLOAD["project_name"],
            expected_code=PAYLOAD["code"],
            embedding=FAKE_VECTOR,
        )
        self.calls["mark_snippet_embedding_failed"].assert_not_called()

    def test_embedding_input_error_preserves_id(self):
        self.calls["embed_code"].side_effect = EmbeddingInputError(
            INTERNAL_ERROR
        )
        self.check_recorded_failure("embedding_input_invalid")
        self.calls["save_snippet_embedding"].assert_not_called()

    def test_model_error_preserves_id(self):
        self.calls["embed_code"].side_effect = RuntimeError(INTERNAL_ERROR)
        self.check_recorded_failure("embedding_generation_failed")
        self.calls["save_snippet_embedding"].assert_not_called()

    def test_vector_storage_error_preserves_id(self):
        self.calls["save_snippet_embedding"].side_effect = RuntimeError(
            INTERNAL_ERROR
        )
        self.check_recorded_failure("embedding_storage_failed")

    def test_original_storage_error_stops_embedding(self):
        self.calls["insert_snippet"].side_effect = RuntimeError(INTERNAL_ERROR)
        response = self.client.post("/snippets", json=PAYLOAD)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.json(), {"detail": "Snippet storage unavailable"}
        )
        self.assertNotIn(INTERNAL_ERROR, response.text)
        for name in (
            "embed_code",
            "save_snippet_embedding",
            "mark_snippet_embedding_failed",
            "get_snippet_embedding_state",
        ):
            self.calls[name].assert_not_called()

    def test_zero_update_requires_confirmed_state(self):
        self.calls["save_snippet_embedding"].return_value = False
        cases = [
            (READY_STATE, 200, "ready", None),
            (FAILED_STATE, 200, "failed", "embedding_generation_failed"),
            (
                {**FAILED_STATE, "embedding_status": "pending", "embedding_error": None},
                503, None, "embedding_storage_failed",
            ),
            (None, 503, None, "embedding_storage_failed"),
            (
                {**READY_STATE, "embedding_valid": False},
                503, None, "embedding_storage_failed",
            ),
            (
                {**FAILED_STATE, "embedding_missing": False},
                503, None, "embedding_storage_failed",
            ),
            (
                {**FAILED_STATE, "embedding_error": INTERNAL_ERROR},
                503, None, "embedding_storage_failed",
            ),
        ]
        for index, (state, http_status, status, error) in enumerate(cases, 1):
            with self.subTest(state=state):
                self.calls["get_snippet_embedding_state"].return_value = state
                response = self.client.post("/snippets", json=PAYLOAD)
                self.check_saved_response(response, http_status, status, error)
                self.assertEqual(
                    self.calls["insert_snippet"].call_count, index
                )
        self.calls["mark_snippet_embedding_failed"].assert_not_called()

    def test_failure_recording_and_read_errors_keep_saved_id(self):
        self.calls["embed_code"].side_effect = RuntimeError(INTERNAL_ERROR)
        self.calls["mark_snippet_embedding_failed"].side_effect = RuntimeError(
            INTERNAL_ERROR
        )
        self.calls["get_snippet_embedding_state"].side_effect = RuntimeError(
            INTERNAL_ERROR
        )
        response = self.client.post("/snippets", json=PAYLOAD)
        self.check_saved_response(
            response, 503, None, "embedding_storage_failed"
        )
        self.calls["insert_snippet"].assert_called_once()

    def test_concurrent_ready_state_is_not_reported_as_failed(self):
        self.calls["embed_code"].side_effect = RuntimeError(INTERNAL_ERROR)
        self.calls["mark_snippet_embedding_failed"].return_value = False
        self.calls["get_snippet_embedding_state"].return_value = READY_STATE
        response = self.client.post("/snippets", json=PAYLOAD)
        self.check_saved_response(response, 200, "ready", None)
        self.calls["save_snippet_embedding"].assert_not_called()

    def test_missing_code_returns_422_before_storage(self):
        invalid_payload = {key: value for key, value in PAYLOAD.items() if key != "code"}
        response = self.client.post("/snippets", json=invalid_payload)
        self.assertEqual(response.status_code, 422)
        self.calls["insert_snippet"].assert_not_called()
        self.calls["embed_code"].assert_not_called()


if __name__ == "__main__":
    unittest.main()
