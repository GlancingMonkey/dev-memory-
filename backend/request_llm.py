"""Request-scoped personal credentials. No keys in caches, files or environment."""

import os
import re

import httpx
from dotenv import load_dotenv
from fastapi import HTTPException
from openai import OpenAI

from backend import llm

KEY_HEADER = "X-LLM-API-Key"
PROVIDER_HEADER = "X-LLM-Provider"
PROVIDERS = {"openai", "anthropic", "google"}
DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5"
DEFAULT_GOOGLE_MODEL = "gemini-3.1-flash-lite"


def _integer(value) -> int:
    if type(value) is not int or value < 0:
        raise llm.LLMResponseError from None
    return value


def from_headers(headers):
    """Validate manually so framework validation never echoes a secret input."""
    keys, providers = headers.getlist(KEY_HEADER), headers.getlist(PROVIDER_HEADER)
    if not keys and not providers:
        return None
    if len(keys) != 1 or len(providers) != 1:
        raise _credentials_error()
    key, provider = keys[0].strip(), providers[0].strip().lower()
    if not key or len(key) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in key):
        raise _credentials_error()
    if provider not in PROVIDERS:
        raise HTTPException(422, detail={
            "code": "llm_provider_unsupported",
            "message": "AI 제공자는 openai, anthropic, google 중에서 선택해 주세요.",
        })
    return RequestLLM(provider, key)


def _credentials_error():
    return HTTPException(401, detail={
        "code": "llm_key_invalid", "message": "AI 키와 제공자 설정을 확인해 주세요.",
    })


class RequestLLM:
    def __init__(self, provider: str, key: str):
        if provider not in PROVIDERS:
            raise ValueError("Unsupported provider")
        self.provider = provider
        self._key = key
        self._client = None
        self._closed = False
        load_dotenv(llm.PROJECT_ROOT / ".env")
        self.model = {
            "openai": llm.MODEL,
            "anthropic": os.getenv("ANTHROPIC_MODEL") or DEFAULT_ANTHROPIC_MODEL,
            "google": os.getenv("GEMINI_MODEL") or DEFAULT_GOOGLE_MODEL,
        }[provider]

    def _connection(self):
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,150}", self.model):
            raise llm.LLMServiceError from None
        if self._closed:
            raise llm.LLMServiceError from None
        if self._client is None:
            if self.provider == "openai":
                self._client = OpenAI(
                    api_key=self._key, base_url="https://api.openai.com/v1",
                    max_retries=0, timeout=llm.REQUEST_TIMEOUT_SECONDS,
                    http_client=httpx.Client(follow_redirects=False, timeout=llm.REQUEST_TIMEOUT_SECONDS),
                )
                # Personal credentials must not inherit the server's account selectors.
                self._client.organization = None
                self._client.project = None
            else:
                self._client = httpx.Client(
                    timeout=llm.REQUEST_TIMEOUT_SECONDS, follow_redirects=False,
                )
        return self._client

    def close(self):
        if self._closed:
            return
        self._closed = True
        self._key = ""
        if self._client is not None:
            try:
                self._client.close()
            except Exception:
                pass

    def _post(self, method: str, payload: dict, deadline: float) -> dict:
        if self.provider == "anthropic":
            url = "https://api.anthropic.com/v1/" + method
            headers = {"x-api-key": self._key, "anthropic-version": "2026-10-21"}
        else:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:{method}"
            headers = {"x-goog-api-key": self._key}
        try:
            response = self._connection().post(
                url, headers=headers, json=payload, timeout=llm._remaining(deadline),
            )
            llm._remaining(deadline)
            if response.status_code in (401, 403):
                raise llm.LLMKeyError(response.status_code)
            if self.provider == "google" and response.status_code == 400:
                error = response.json().get("error", {})
                reasons = {d.get("reason") for d in error.get("details", []) if isinstance(d, dict)}
                if reasons & {"API_KEY_INVALID", "API_KEY_EXPIRED"}:
                    raise llm.LLMKeyError(401)
            if not 200 <= response.status_code < 300:
                raise llm.LLMServiceError from None
            try:
                result = response.json()
            except ValueError:
                raise llm.LLMResponseError from None
            if not isinstance(result, dict):
                raise llm.LLMResponseError from None
            return result
        except (llm.LLMKeyError, llm.LLMTimeoutError, llm.LLMResponseError, llm.LLMServiceError):
            raise
        except httpx.TimeoutException:
            raise llm.LLMTimeoutError from None
        except Exception:
            raise llm.LLMServiceError from None

    def _payload(self, messages: list[dict[str, str]], *, structured=True) -> dict:
        system = "\n".join(m["content"] for m in messages if m["role"] in ("system", "developer"))
        turns = [m for m in messages if m["role"] not in ("system", "developer")]
        if self.provider == "anthropic":
            payload = {"model": self.model, "messages": turns}
            if system:
                payload["system"] = system
            if structured:
                payload["output_config"] = {"format": {
                    "type": "json_schema", "schema": llm.ModelAnswer.model_json_schema(),
                }}
        else:
            payload = {"model": "models/" + self.model, "contents": [
                {"role": "model" if m["role"] == "assistant" else "user",
                 "parts": [{"text": m["content"]}]} for m in turns
            ]}
            if system:
                payload["systemInstruction"] = {"parts": [{"text": system}]}
            if structured:
                payload["generationConfig"] = {
                    "responseMimeType": "application/json",
                    "responseJsonSchema": llm.ModelAnswer.model_json_schema(),
                    "maxOutputTokens": llm.MAX_OUTPUT_TOKENS,
                }
        return payload

    def count_context_tokens(self, *, context: str, deadline: float) -> int:
        if self.provider == "openai":
            return llm.count_context_tokens(context=context, deadline=deadline, client=self._connection())
        payload = self._payload([{"role": "user", "content": context}], structured=False)
        return self._count(payload, deadline)

    def count_input_tokens(self, *, messages, deadline: float) -> int:
        if self.provider == "openai":
            return llm.count_input_tokens(messages=messages, deadline=deadline, client=self._connection())
        return self._count(self._payload(messages), deadline)

    def _count(self, payload: dict, deadline: float) -> int:
        if self.provider == "anthropic":
            return _integer(self._post("messages/count_tokens", payload, deadline).get("input_tokens"))
        return _integer(self._post("countTokens", {"generateContentRequest": payload}, deadline).get("totalTokens"))

    def generate_answer(self, *, messages, deadline: float):
        if self.provider == "openai":
            return llm.generate_answer(messages=messages, deadline=deadline, client=self._connection())
        try:
            payload = self._payload(messages)
            if self.provider == "anthropic":
                payload["max_tokens"] = llm.MAX_OUTPUT_TOKENS
                result = self._post("messages", payload, deadline)
                if result.get("stop_reason") != "end_turn":
                    raise llm.LLMResponseError from None
                text = "".join(b["text"] for b in result.get("content", []) if b.get("type") == "text")
                usage = result.get("usage", {})
                input_tokens = sum(_integer(usage.get(name, 0)) for name in (
                    "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
                ))
                # The base input count is mandatory, even if there are cache fields.
                _integer(usage.get("input_tokens"))
                output_tokens = _integer(usage.get("output_tokens"))
                total_tokens = input_tokens + output_tokens
                model = result.get("model")
            else:
                result = self._post("generateContent", payload, deadline)
                candidates = result.get("candidates", [])
                if len(candidates) != 1 or candidates[0].get("finishReason") != "STOP":
                    raise llm.LLMResponseError from None
                text = "".join(p["text"] for p in candidates[0].get("content", {}).get("parts", [])
                               if "text" in p and not p.get("thought"))
                usage = result.get("usageMetadata", {})
                input_tokens = _integer(usage.get("promptTokenCount"))
                output_tokens = _integer(usage.get("candidatesTokenCount")) + _integer(usage.get("thoughtsTokenCount", 0))
                total_tokens = _integer(usage.get("totalTokenCount"))
                if total_tokens != input_tokens + output_tokens:
                    raise llm.LLMResponseError from None
                model = result.get("modelVersion")
            if not isinstance(model, str) or not model:
                raise llm.LLMResponseError from None
            try:
                answer = llm.ModelAnswer.model_validate_json(text)
            except Exception:
                raise llm.LLMResponseError from None
            return answer, model, {
                "input_tokens": input_tokens, "output_tokens": output_tokens, "total_tokens": total_tokens,
            }
        except (llm.LLMServiceError, llm.LLMTimeoutError, llm.LLMResponseError):
            raise
        except Exception:
            raise llm.LLMResponseError from None

    def generate_answer_stream(self, *, messages, deadline: float):
        if self.provider == "openai":
            yield from llm.generate_answer_stream(messages=messages, deadline=deadline, client=self._connection())
            return
        # Native JSON generation once; adapt the validated result to existing SSE.
        # This deliberately does not claim provider-token streaming for Claude/Gemini.
        result = self.generate_answer(messages=messages, deadline=deadline)
        if result[0].status == "answered":
            yield "delta", result[0].answer
        yield "complete", result
