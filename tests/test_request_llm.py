import json
import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock, patch

import httpx
from fastapi import HTTPException
from openai import AuthenticationError, PermissionDeniedError
from starlette.datastructures import Headers

from backend import llm
from backend.request_llm import KEY_HEADER, PROVIDER_HEADER, RequestLLM, from_headers

KEY = "TEST_ONLY_PERSONAL_KEY_A"
ANSWER = {"status": "answered", "answer": "더합니다. [S1]", "citation_ids": ["S1"]}
MESSAGES = [{"role": "developer", "content": "근거로만 답하세요"},
            {"role": "user", "content": "설명해줘"}]


class HeaderTests(unittest.TestCase):
    def test_absent_headers_preserve_server_default(self):
        self.assertIsNone(from_headers(Headers()))

    def test_key_is_request_scoped_and_not_in_repr_or_environment(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "TEST_ONLY_SERVER_KEY"}):
            session = from_headers(Headers({KEY_HEADER: KEY, PROVIDER_HEADER: " OpenAI "}))
            self.assertEqual(session.provider, "openai")
            self.assertNotIn(KEY, repr(session))
            self.assertEqual(os.environ["OPENAI_API_KEY"], "TEST_ONLY_SERVER_KEY")
            session.close()
            self.assertEqual(session._key, "")

    def test_malformed_or_partial_headers_do_not_echo_credentials(self):
        for headers in (
            Headers({KEY_HEADER: KEY}), Headers({PROVIDER_HEADER: "openai"}),
            Headers({KEY_HEADER: "", PROVIDER_HEADER: "openai"}),
            Headers({KEY_HEADER: KEY + " space", PROVIDER_HEADER: "openai"}),
            Headers({KEY_HEADER: "a" * 4097, PROVIDER_HEADER: "openai"}),
            Headers(raw=[(b'x-llm-api-key', KEY.encode()), (b'x-llm-api-key', b'other'),
                         (b'x-llm-provider', b'openai')]),
        ):
            with self.subTest(headers_count=len(headers)):
                with self.assertRaises(HTTPException) as raised:
                    from_headers(headers)
                self.assertEqual(raised.exception.status_code, 401)
                self.assertNotIn(KEY, str(raised.exception.detail))

    def test_unknown_provider_never_silently_uses_server_key(self):
        with self.assertRaises(HTTPException) as raised:
            from_headers(Headers({KEY_HEADER: KEY, PROVIDER_HEADER: "unknown"}))
        self.assertEqual(raised.exception.status_code, 422)


class PersonalOpenAITests(unittest.TestCase):
    def test_all_operations_use_same_personal_client_and_close_once(self):
        client = Mock()
        with (
            patch("backend.request_llm.OpenAI", return_value=client) as factory,
            patch("backend.llm._client") as server_client,
            patch("backend.llm.count_context_tokens", return_value=10) as count_context,
            patch("backend.llm.count_input_tokens", return_value=20) as count_input,
            patch("backend.llm.generate_answer", return_value="result") as generate,
            patch("backend.llm.generate_answer_stream", return_value=iter([])) as stream,
        ):
            session = RequestLLM("openai", KEY)
            session.count_context_tokens(context="source", deadline=10**20)
            session.count_input_tokens(messages=MESSAGES, deadline=10**20)
            session.generate_answer(messages=MESSAGES, deadline=10**20)
            list(session.generate_answer_stream(messages=MESSAGES, deadline=10**20))
            for operation in (count_context, count_input, generate, stream):
                self.assertIs(operation.call_args.kwargs["client"], client)
            self.assertEqual(factory.call_args.kwargs["api_key"], KEY)
            self.assertEqual(factory.call_args.kwargs["base_url"], "https://api.openai.com/v1")
            self.assertEqual(factory.call_args.kwargs["max_retries"], 0)
            self.assertFalse(factory.call_args.kwargs["http_client"].follow_redirects)
            self.addCleanup(factory.call_args.kwargs["http_client"].close)
            factory.assert_called_once()
            server_client.assert_not_called()
            session.close(); session.close()
        client.close.assert_called_once()
        self.assertIsNone(client.organization)
        self.assertIsNone(client.project)

    def test_sdk_auth_errors_are_safe_for_count_and_generation(self):
        response = httpx.Response(401, request=httpx.Request("POST", "https://api.openai.com/v1/responses"))
        for error_type, expected in ((AuthenticationError, 401), (PermissionDeniedError, 403)):
            for operation in (llm.count_context_tokens, llm.count_input_tokens, llm.generate_answer):
                client = Mock()
                failure = error_type(KEY, response=response, body={"key": KEY})
                client.responses.create.side_effect = failure
                client.responses.input_tokens.count.side_effect = failure
                kwargs = {"context": "source"} if operation is llm.count_context_tokens else {"messages": MESSAGES}
                with self.subTest(operation=operation.__name__, status=expected):
                    with self.assertRaises(llm.LLMKeyError) as raised:
                        operation(**kwargs, deadline=10**20, client=client)
                    self.assertEqual(raised.exception.status_code, expected)
                    self.assertNotIn(KEY, str(raised.exception))


class NativeProviderTests(unittest.TestCase):
    def session(self, provider, replies):
        requests = []
        def handler(request):
            requests.append(request)
            reply = replies[len(requests)-1]
            if isinstance(reply, Exception):
                raise reply
            return httpx.Response(200, json=reply)
        session = RequestLLM(provider, KEY)
        session._client = httpx.Client(transport=httpx.MockTransport(handler))
        self.addCleanup(session.close)
        return session, requests

    def anthropic_response(self):
        return {"model": "claude-test-snapshot", "stop_reason": "end_turn",
                "content": [{"type": "text", "text": json.dumps(ANSWER)}],
                "usage": {"input_tokens": 100, "cache_creation_input_tokens": 10,
                          "cache_read_input_tokens": 20, "output_tokens": 30}}

    def google_response(self):
        return {"modelVersion": "gemini-test-snapshot", "candidates": [{"finishReason": "STOP",
                 "content": {"parts": [{"thought": True, "text": "private thinking"},
                                        {"text": json.dumps(ANSWER)}]}}],
                "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 20,
                                  "thoughtsTokenCount": 10, "totalTokenCount": 130}}

    def test_anthropic_native_payload_count_cache_usage_and_headers(self):
        session, requests = self.session("anthropic", [{"input_tokens": 25}, {"input_tokens": 50}, self.anthropic_response()])
        self.assertEqual(session.count_context_tokens(context="source", deadline=10**20), 25)
        self.assertEqual(session.count_input_tokens(messages=MESSAGES, deadline=10**20), 50)
        answer, model, usage = session.generate_answer(messages=MESSAGES, deadline=10**20)
        counted, generated = [json.loads(r.content) for r in requests[1:]]
        generated.pop("max_tokens")
        self.assertEqual(counted, generated)
        self.assertEqual(counted["system"], MESSAGES[0]["content"])
        self.assertEqual(counted["output_config"]["format"]["schema"], llm.ModelAnswer.model_json_schema())
        self.assertTrue(all(r.headers["x-api-key"] == KEY for r in requests))
        self.assertTrue(all(r.url.host == "api.anthropic.com" for r in requests))
        self.assertEqual(answer.citation_ids, ["S1"])
        self.assertEqual(model, "claude-test-snapshot")
        self.assertEqual(usage, {"input_tokens": 130, "output_tokens": 30, "total_tokens": 160})

    def test_google_full_request_count_and_thinking_usage(self):
        session, requests = self.session("google", [{"totalTokens": 25}, {"totalTokens": 50}, self.google_response()])
        session.count_context_tokens(context="source", deadline=10**20)
        session.count_input_tokens(messages=MESSAGES, deadline=10**20)
        answer, model, usage = session.generate_answer(messages=MESSAGES, deadline=10**20)
        counted = json.loads(requests[1].content)["generateContentRequest"]
        self.assertEqual(counted, json.loads(requests[2].content))
        self.assertEqual(counted["systemInstruction"]["parts"][0]["text"], MESSAGES[0]["content"])
        self.assertEqual(counted["generationConfig"]["responseJsonSchema"], llm.ModelAnswer.model_json_schema())
        self.assertTrue(all(r.headers["x-goog-api-key"] == KEY for r in requests))
        self.assertTrue(all(KEY not in str(r.url) for r in requests))
        self.assertEqual(answer.answer, ANSWER["answer"])
        self.assertEqual(model, "gemini-test-snapshot")
        self.assertEqual(usage, {"input_tokens": 100, "output_tokens": 30, "total_tokens": 130})

    def test_native_json_adapts_to_sse_once(self):
        for provider, reply in (("anthropic", self.anthropic_response()), ("google", self.google_response())):
            session, requests = self.session(provider, [reply])
            events = list(session.generate_answer_stream(messages=MESSAGES, deadline=10**20))
            self.assertEqual([k for k,v in events], ["delta", "complete"])
            self.assertEqual(events[0][1], ANSWER["answer"])
            self.assertEqual(len(requests), 1)

    def test_missing_usage_incomplete_and_unknown_fields_are_not_successes(self):
        for provider, original in (("anthropic", self.anthropic_response()), ("google", self.google_response())):
            bad = deepcopy(original)
            if provider == "anthropic":
                bad["stop_reason"] = "max_tokens"
            else:
                bad["candidates"][0]["finishReason"] = "MAX_TOKENS"
            missing = deepcopy(original)
            missing.pop("usage" if provider == "anthropic" else "usageMetadata")
            for reply in (bad, missing):
                session, requests = self.session(provider, [reply])
                with self.assertRaises(llm.LLMResponseError):
                    session.generate_answer(messages=MESSAGES, deadline=10**20)
                self.assertEqual(len(requests), 1)

    def test_bad_google_totals_are_rejected(self):
        reply = self.google_response(); reply["usageMetadata"]["totalTokenCount"] = 999
        session, _ = self.session("google", [reply])
        with self.assertRaises(llm.LLMResponseError):
            session.generate_answer(messages=MESSAGES, deadline=10**20)

    def test_malformed_provider_content_is_not_a_valid_answer(self):
        for provider, reply in (("google", {"candidates": None}),
                                ("anthropic", {"stop_reason": "end_turn", "content": [None]})):
            session, _ = self.session(provider, [reply])
            with self.assertRaises(llm.LLMResponseError):
                session.generate_answer(messages=MESSAGES, deadline=10**20)

    def test_invalid_model_setting_does_not_send_a_request(self):
        with patch.dict(os.environ, {"GEMINI_MODEL": "../../other?key=value"}):
            session = RequestLLM("google", KEY)
            with patch("backend.request_llm.httpx.Client") as factory:
                with self.assertRaises(llm.LLMServiceError):
                    session.count_context_tokens(context="source", deadline=10**20)
                factory.assert_not_called()
            session.close()

    def test_auth_rate_limit_timeout_and_google_invalid_key_are_safe(self):
        cases = [(401, {}, llm.LLMKeyError), (403, {}, llm.LLMKeyError),
                 (429, {"message": KEY}, llm.LLMServiceError),
                 (400, {"error": {"details": [{"reason": "API_KEY_INVALID"}], "message": KEY}}, llm.LLMKeyError)]
        for status, body, error_type in cases:
            with self.subTest(status=status):
                session = RequestLLM("google", KEY)
                session._client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(status, json=body)))
                self.addCleanup(session.close)
                with self.assertRaises(error_type) as raised:
                    session.count_context_tokens(context="source", deadline=10**20)
                self.assertNotIn(KEY, str(raised.exception))
        session, _ = self.session("anthropic", [httpx.ReadTimeout(KEY)])
        with self.assertRaises(llm.LLMTimeoutError):
            session.count_context_tokens(context="source", deadline=10**20)

    def test_concurrent_personal_keys_never_cross_requests(self):
        def run(key):
            session = RequestLLM("google", key)
            seen = []
            def handler(request):
                seen.append(request.headers["x-goog-api-key"])
                return httpx.Response(200, json={"totalTokens": 10})
            session._client = httpx.Client(transport=httpx.MockTransport(handler))
            try:
                session.count_context_tokens(context="source", deadline=10**20)
                return seen
            finally:
                session.close()
        with ThreadPoolExecutor(max_workers=2) as executor:
            self.assertEqual(list(executor.map(run, [KEY, KEY + "_B"])), [[KEY], [KEY + "_B"]])


if __name__ == "__main__":
    unittest.main()
