import asyncio
from contextlib import ExitStack
from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import llm
from backend.routers.study import router
from backend.schemas.study import ConceptsRequest, REQUESTS, RESULTS, StudyRequest
from backend.study_prompts import DATA, study_prompt
from backend.study_runner import RunnerInputError, RunnerTimeout, RunnerUnavailable, command


FIXTURES = json.loads((Path(__file__).parent / "fixtures/study_responses.json").read_text())
BASE = {"code": "def add(a,b):\n    return a + b", "language": "python", "function_name": "add"}
EXTRAS = {"explain": {"answer": "더해요"}, "translate": {"target": "typescript"},
          "distractors": {"call": "add(1,2)", "answer": "3"},
          "narrate": {"call": "add(1,2)", "steps": ["start", "return"]},
          "concepts": {"known_ids": [], "concept_ids": ["condition"]}}


class StudyApiTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.generator = self.stack.enter_context(patch("backend.routers.study.generate_study_json"))
        app = FastAPI()
        app.include_router(router)
        self.client = self.stack.enter_context(TestClient(app))

    def test_all_modes_return_extension_shapes_without_db_or_embedding(self):
        with patch("backend.database.connect_db") as db, patch("rag.embedding.embed_code") as embed:
            for mode, fixture in FIXTURES.items():
                with self.subTest(mode=mode):
                    self.generator.return_value = fixture
                    response = self.client.post("/study/" + mode, json={**BASE, **EXTRAS.get(mode, {})})
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json(), fixture)
                    self.assertIsNone(self.generator.call_args.kwargs["session"])
            db.assert_not_called()
            embed.assert_not_called()

    def test_invalid_mode_inputs_do_not_call_provider(self):
        cases = [("unknown", BASE), ("explain", BASE), ("translate", BASE),
                 ("distractors", BASE), ("plain", {**BASE, "code": " "}),
                 ("plain", {**BASE, "code": "x" * 8001}),
                 ("narrate", {**BASE, "steps": []})]
        for mode, body in cases:
            with self.subTest(mode=mode, keys=list(body)):
                self.assertEqual(self.client.post("/study/" + mode, json=body).status_code, 422)
        self.generator.assert_not_called()

    def test_personal_session_is_used_and_closed(self):
        for provider in ("openai", "anthropic", "google"):
            with self.subTest(provider=provider), patch("backend.routers.study.from_headers") as headers:
                session = Mock(provider=provider)
                headers.return_value = session
                self.generator.return_value = FIXTURES["plain"]
                response = self.client.post("/study/plain", json=BASE,
                    headers={"X-LLM-API-Key": "TEST_ONLY_KEY", "X-LLM-Provider": provider})
                self.assertEqual(response.status_code, 200)
                self.assertIs(self.generator.call_args.kwargs["session"], session)
                session.close.assert_called_once()

    def test_bad_headers_never_echo_key_or_fall_back(self):
        response = self.client.post("/study/plain", json=BASE, headers={"X-LLM-API-Key": "TEST_ONLY_PRIVATE"})
        self.assertEqual(response.status_code, 401)
        self.assertNotIn("TEST_ONLY_PRIVATE", response.text)
        self.generator.assert_not_called()

    def test_safe_error_statuses_and_session_cleanup(self):
        for exception, status in [(llm.LLMKeyError(401), 401), (llm.LLMKeyError(403), 403),
                                  (llm.LLMTimeoutError(), 504), (llm.LLMResponseError(), 502),
                                  (RuntimeError("TEST_ONLY_SECRET"), 503)]:
            with self.subTest(status=status), patch("backend.routers.study.from_headers") as headers:
                session = Mock()
                headers.return_value = session
                self.generator.side_effect = exception
                response = self.client.post("/study/plain", json=BASE)
                self.assertEqual(response.status_code, status)
                self.assertNotIn("TEST_ONLY_SECRET", response.text)
                session.close.assert_called_once()

    def test_invalid_ai_shapes_and_line_references_are_rejected(self):
        cases = [("plain", {}), ("lines", {"lines": [{"line":99,"plain":"bad"}]}),
                 ("bug", {**FIXTURES["bug"], "line":99}),
                 ("narrate", {"summary":"s","steps":["only one"]}),
                 ("narrate", {"summary":"s","steps":["",""]}),
                 ("distractors", {"choices":["3","4","5"]}),
                 ("distractors", {"choices":["4","4"]}),
                 ("distractors", {"choices":[" ","4"]})]
        for mode, fixture in cases:
            with self.subTest(mode=mode):
                self.generator.return_value = fixture
                response = self.client.post("/study/" + mode, json={**BASE, **EXTRAS.get(mode,{})})
                self.assertEqual(response.status_code, 502)

    def test_unknown_concept_id_is_null_like_extension_parser(self):
        fixture = deepcopy(FIXTURES["concepts"])
        fixture["concepts"][0]["id"] = "invented"
        self.generator.return_value = fixture
        response = self.client.post("/study/concepts", json={**BASE, **EXTRAS["concepts"]})
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["concepts"][0]["id"])

    def test_static_execution_paths_do_not_reach_llm(self):
        with patch("backend.routers.study.execute", new_callable=AsyncMock) as execute:
            execute.return_value = {"cases":[{"call":"add(1,2)","output":"3","error":"","expected":"3","ok":True}]}
            response = self.client.post("/study/run", json={**BASE,"tests":[{"call":"add(1,2)","expected":"3"}]})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(response.json()["cases"][0]["ok"])
            self.generator.assert_not_called()

    def test_execution_errors_are_safe(self):
        for exc, status in [(RunnerTimeout(),504), (RunnerUnavailable(),503),
                            (RunnerInputError("잘못된 호출"),422), (RuntimeError("TEST_ONLY_SECRET"),503)]:
            with self.subTest(status=status), patch("backend.routers.study.execute", new_callable=AsyncMock) as execute:
                execute.side_effect = exc
                response = self.client.post("/study/trace", json={**BASE,"call":"add(1,2)"})
                self.assertEqual(response.status_code, status)
                self.assertNotIn("TEST_ONLY_SECRET", response.text)

    def test_execution_requires_supported_language_and_cases(self):
        with patch("backend.routers.study.execute", new_callable=AsyncMock) as execute:
            self.assertEqual(self.client.post("/study/run",json=BASE).status_code,422)
            self.assertEqual(self.client.post("/study/trace",json={**BASE,"language":"java","call":"f()"}).status_code,422)
            self.assertEqual(self.client.post("/study/run",json={**BASE,"calls":["f()"]*21}).status_code,422)
            execute.assert_not_called()


class StudyContractTests(unittest.TestCase):
    def test_prompts_match_known_frontend_markers(self):
        for mode in RESULTS:
            request = REQUESTS.get(mode, StudyRequest).model_validate({**BASE,**EXTRAS.get(mode,{})})
            messages = study_prompt(mode, request)
            self.assertEqual(messages[0]["content"],DATA["system"])
            self.assertIn("1: def add(a,b):\n2:     return a + b",messages[1]["content"])
            self.assertTrue(messages[1]["content"].endswith(DATA["shapes"][mode]))

    def test_runner_command_has_no_host_mounts_or_inherited_keys(self):
        args = command("code-memory-study-test", "python")
        for required in ("--network=none","--read-only","--cap-drop=ALL","--security-opt=no-new-privileges",
                         "--pids-limit=32","--memory=256m","--user=65534:65534","--pull=never"):
            self.assertIn(required,args)
        for forbidden in ("--privileged","--volume","-v","--mount","--env","-e"):
            self.assertNotIn(forbidden,args)

    def test_disabled_runner_never_starts_a_process(self):
        from backend.study_runner import execute
        with patch.dict("os.environ",{"STUDY_RUNNER_ENABLED":"false"}), patch("asyncio.create_subprocess_exec") as spawn:
            with self.assertRaises(RunnerUnavailable):
                asyncio.run(execute("trace", REQUESTS.get("plain",StudyRequest)(**BASE)))
            spawn.assert_not_called()

    def test_runner_loads_env_before_checking_enabled(self):
        from backend.study_runner import execute
        with tempfile.TemporaryDirectory() as directory:
            env_path = Path(directory) / ".env"
            env_path.write_text("STUDY_RUNNER_ENABLED=true\nSTUDY_RUNNER_IMAGE=fixture-runner:local\n")
            with patch.dict(os.environ), patch("backend.study_runner.ENV_PATH", env_path), \
                 patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, side_effect=FileNotFoundError) as spawn:
                os.environ.pop("STUDY_RUNNER_ENABLED", None)
                os.environ.pop("STUDY_RUNNER_IMAGE", None)
                with self.assertRaises(RunnerUnavailable):
                    asyncio.run(execute("trace", StudyRequest(**BASE)))
                self.assertIn("fixture-runner:local", spawn.call_args_list[0].args)


if __name__ == "__main__":
    unittest.main()
