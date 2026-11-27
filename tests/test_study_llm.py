import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from backend import llm
from backend.request_llm import RequestLLM
from backend.schemas.study import PlainResult
from backend.study_llm import generate_study_json, provider_schema


ANSWER = {"one_line":"더해요", "analogy":"합쳐요", "use":"합계"}
MESSAGES = [{"role":"system","content":"JSON"},{"role":"user","content":"code"}]


class StudyLLMTests(unittest.TestCase):
    def call(self, session=None):
        return generate_study_json(messages=MESSAGES, schema=PlainResult.model_json_schema(), deadline=10**20, session=session)

    def test_server_openai_uses_structured_output_once(self):
        client = Mock()
        client.responses.create.return_value = SimpleNamespace(status="completed",output_text=json.dumps(ANSWER))
        with patch("backend.llm._client",return_value=client):
            self.assertEqual(self.call(),ANSWER)
        args = client.responses.create.call_args.kwargs
        self.assertEqual(args["text"]["format"]["schema"],provider_schema(PlainResult.model_json_schema()))
        self.assertTrue(args["text"]["format"]["strict"])
        self.assertFalse(args["store"])
        client.responses.create.assert_called_once()

    def test_personal_openai_never_uses_server_client(self):
        session = RequestLLM("openai","TEST_ONLY_PERSONAL")
        client = Mock()
        client.responses.create.return_value = SimpleNamespace(status="completed",output_text=json.dumps(ANSWER))
        with patch.object(session,"_connection",return_value=client),patch("backend.llm._client") as server:
            self.assertEqual(self.call(session),ANSWER)
            server.assert_not_called()
        session.close()

    def test_native_providers_use_study_schema_not_rag_schema(self):
        for provider in ("anthropic","google"):
            session = RequestLLM(provider,"TEST_ONLY_PERSONAL")
            response = ({"stop_reason":"end_turn","content":[{"type":"text","text":json.dumps(ANSWER)}]}
                        if provider == "anthropic" else
                        {"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":json.dumps(ANSWER)}]}}]})
            with self.subTest(provider=provider),patch.object(session,"_post",return_value=response) as post:
                self.assertEqual(self.call(session),ANSWER)
                payload = post.call_args.args[1]
                schema = (payload["output_config"]["format"]["schema"] if provider == "anthropic"
                          else payload["generationConfig"]["responseJsonSchema"])
                self.assertEqual(schema,provider_schema(PlainResult.model_json_schema()))
                post.assert_called_once()
            session.close()

    def test_invalid_json_and_incomplete_output_are_rejected_without_retry(self):
        for status,text in (("incomplete",json.dumps(ANSWER)),("completed",""),("completed","not json"),("completed","[]")):
            client = Mock()
            client.responses.create.return_value = SimpleNamespace(status=status,output_text=text)
            with self.subTest(status=status,text=text),patch("backend.llm._client",return_value=client):
                with self.assertRaises(llm.LLMResponseError):
                    self.call()
                client.responses.create.assert_called_once()

    def test_native_truncated_output_is_not_accepted(self):
        session = RequestLLM("google","TEST_ONLY_PERSONAL")
        with patch.object(session,"_post",return_value={"candidates":[{"finishReason":"MAX_TOKENS"}]}):
            with self.assertRaises(llm.LLMResponseError):
                self.call(session)
        session.close()

    def test_provider_subset_preserves_required_fields_and_local_bounds(self):
        original = PlainResult.model_json_schema()
        subset = provider_schema(original)
        self.assertIn("maxLength", original["properties"]["one_line"])
        self.assertNotIn("maxLength", subset["properties"]["one_line"])
        self.assertIn("maxLength=300", subset["properties"]["one_line"]["description"])
        self.assertEqual(subset["required"], original["required"])
        self.assertFalse(subset["additionalProperties"])


if __name__ == "__main__":
    unittest.main()
