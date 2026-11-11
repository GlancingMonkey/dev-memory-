import json
import os
import re
from collections.abc import Iterator
from functools import lru_cache
from pathlib import Path
from time import monotonic
from typing import Literal

from dotenv import load_dotenv
from openai import OpenAI
from pydantic import BaseModel, ConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODEL = "gpt-6.1-sol"
MAX_INPUT_TOKENS = 8_000
MAX_OUTPUT_TOKENS = 4_096
REQUEST_TIMEOUT_SECONDS = 30.0

class ModelAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["answered", "insufficient_context"]
    answer: str
    citation_ids: list[str]


class LLMServiceError(Exception):
    pass


class LLMTimeoutError(Exception):
    pass


class LLMResponseError(Exception):
    pass


def _format_config() -> dict:
    return {
        "format": {
            "type": "json_schema",
            "name": "rag_answer",
            "strict": True,
            "schema": ModelAnswer.model_json_schema(),
        }
    }


@lru_cache(maxsize=1)
def _client() -> OpenAI:
    load_dotenv(PROJECT_ROOT / ".env")
    if not os.getenv("OPENAI_API_KEY"):
        raise LLMServiceError("OpenAI API key is not configured")
    return OpenAI(max_retries=0, timeout=REQUEST_TIMEOUT_SECONDS)


def _remaining(deadline: float) -> float:
    remaining = deadline - monotonic()
    if remaining <= 0:
        raise LLMTimeoutError
    return remaining


def count_input_tokens(
    *,
    messages: list[dict[str, str]],
    deadline: float,
) -> int:
    """Count the same message and schema shape that is sent for generation."""
    try:
        response = _client().responses.input_tokens.count(
            model=MODEL,
            input=messages,
            reasoning={"effort": "low"},
            text=_format_config(),
            timeout=_remaining(deadline),
        )
    except LLMTimeoutError:
        raise
    except Exception as error:
        from openai import APITimeoutError

        if isinstance(error, APITimeoutError):
            raise LLMTimeoutError from None
        raise LLMServiceError from None
    return response.input_tokens


def count_context_tokens(*, context: str, deadline: float) -> int:
    """Count serialized source records without estimating from characters."""
    try:
        response = _client().responses.input_tokens.count(
            model=MODEL,
            input=context,
            timeout=_remaining(deadline),
        )
    except LLMTimeoutError:
        raise
    except Exception as error:
        from openai import APITimeoutError

        if isinstance(error, APITimeoutError):
            raise LLMTimeoutError from None
        raise LLMServiceError from None
    return response.input_tokens


def generate_answer(
    *,
    messages: list[dict[str, str]],
    deadline: float,
) -> tuple[ModelAnswer, str, dict[str, int]]:
    """Generate once with retries disabled and return provider-reported usage."""
    try:
        response = _client().responses.create(
            model=MODEL,
            input=messages,
            reasoning={"effort": "low"},
            max_output_tokens=MAX_OUTPUT_TOKENS,
            text=_format_config(),
            timeout=_remaining(deadline),
        )
    except LLMTimeoutError:
        raise
    except Exception as error:
        from openai import APITimeoutError

        if isinstance(error, APITimeoutError):
            raise LLMTimeoutError from None
        raise LLMServiceError from None

    return _parse_completed_response(response)


def _parse_completed_response(response) -> tuple[ModelAnswer, str, dict[str, int]]:
    if response.status != "completed" or not response.output_text:
        raise LLMResponseError
    try:
        answer = ModelAnswer.model_validate_json(response.output_text)
    except Exception:
        raise LLMResponseError from None

    usage = response.usage
    if usage is None or not response.model:
        raise LLMResponseError
    tokens = {
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "total_tokens": usage.total_tokens,
    }
    if any(not isinstance(value, int) or value < 0 for value in tokens.values()):
        raise LLMResponseError
    if tokens["total_tokens"] != tokens["input_tokens"] + tokens["output_tokens"]:
        raise LLMResponseError
    return answer, response.model, tokens


def _partial_json_string(text: str, field: str) -> str | None:
    match = re.search(r'"' + re.escape(field) + r'"\s*:\s*"', text)
    if match is None:
        return None

    index = match.end()
    encoded = []
    while index < len(text):
        character = text[index]
        if character == '"':
            try:
                return json.loads('"' + "".join(encoded) + '"')
            except json.JSONDecodeError:
                return None
        if character == "\\":
            if index + 1 >= len(text):
                break
            escape = text[index + 1]
            if escape == "u":
                if index + 6 > len(text):
                    break
                digits = text[index + 2 : index + 6]
                if any(value not in "0123456789abcdefABCDEF" for value in digits):
                    return None
                encoded.append(text[index : index + 6])
                index += 6
                continue
            if escape not in '"\\/bfnrt':
                return None
            encoded.append(text[index : index + 2])
            index += 2
            continue
        if ord(character) < 0x20:
            return None
        encoded.append(character)
        index += 1

    try:
        return json.loads('"' + "".join(encoded) + '"')
    except json.JSONDecodeError:
        return None


def generate_answer_stream(
    *,
    messages: list[dict[str, str]],
    deadline: float,
) -> Iterator[tuple[str, object]]:
    """Stream answer text deltas and finish with the validated provider result."""
    stream = None
    output_text = ""
    emitted_answer = ""
    completed_response = None
    try:
        stream = _client().responses.create(
            model=MODEL,
            input=messages,
            reasoning={"effort": "low"},
            max_output_tokens=MAX_OUTPUT_TOKENS,
            text=_format_config(),
            stream=True,
            timeout=_remaining(deadline),
        )
        for event in stream:
            _remaining(deadline)
            if event.type == "response.output_text.delta":
                output_text += event.delta
                status = re.search(r'"status"\s*:\s*"(answered|insufficient_context)"', output_text)
                if status is not None and status.group(1) == "answered":
                    partial = _partial_json_string(output_text, "answer")
                    if partial is not None:
                        if not partial.startswith(emitted_answer):
                            raise LLMResponseError
                        delta = partial[len(emitted_answer) :]
                        if delta:
                            emitted_answer = partial
                            yield "delta", delta
            elif event.type == "response.completed":
                completed_response = event.response
                break
            elif event.type == "error":
                raise LLMServiceError from None

        if completed_response is None:
            raise LLMResponseError
        result = _parse_completed_response(completed_response)
        answer, _, _ = result
        if answer.status == "answered":
            if not answer.answer.startswith(emitted_answer):
                raise LLMResponseError
            remainder = answer.answer[len(emitted_answer) :]
            if remainder:
                yield "delta", remainder
        elif emitted_answer:
            raise LLMResponseError
        yield "complete", result
    except (LLMTimeoutError, LLMResponseError, LLMServiceError):
        raise
    except Exception as error:
        from openai import APITimeoutError

        if isinstance(error, APITimeoutError):
            raise LLMTimeoutError from None
        raise LLMServiceError from None
    finally:
        if stream is not None and hasattr(stream, "close"):
            try:
                stream.close()
            except Exception:
                pass
