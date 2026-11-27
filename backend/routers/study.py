"""Study AI responses and isolated execution; no DB/RAG side effects."""

import json
import logging
from time import monotonic
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import ValidationError

from backend import llm
from backend.request_llm import KEY_HEADER, PROVIDER_HEADER, from_headers
from backend.schemas.study import (
    REQUESTS, RESULTS, ConceptsRequest, ConceptsResult, RunRequest, RunResult,
    StudyRequest, TraceRequest, TraceResult,
)
from backend.study_llm import generate_study_json
from backend.study_prompts import DATA, study_prompt
from backend.study_runner import RunnerInputError, RunnerTimeout, RunnerUnavailable, execute

router = APIRouter(prefix="/study", tags=["study"])
logger = logging.getLogger(__name__)
HEADERS = {"parameters": [
    {"in": "header", "name": KEY_HEADER, "required": False,
     "schema": {"type": "string", "format": "password"}},
    {"in": "header", "name": PROVIDER_HEADER, "required": False,
     "schema": {"type": "string", "enum": ["openai", "anthropic", "google"]}},
]}
StudyMode = Literal["explain", "why", "review", "task", "bug", "translate", "plain", "lines", "distractors", "narrate"]


def error(status, code, message):
    return HTTPException(status, detail={"code": code, "message": message})


def check_result(mode, raw, request):
    result = RESULTS[mode].model_validate(raw)
    line_count = len(request.code.split("\n"))
    for field in ("points", "items", "concepts"):
        for item in getattr(result, field, []):
            if any(number > line_count for number in item.lines):
                raise ValueError("Response line is outside input code")
    if mode == "lines" and any(item.line > line_count for item in result.lines):
        raise ValueError("Response line is outside input code")
    if mode == "bug" and result.line > len(result.code.split("\n")):
        raise ValueError("Bug line is outside generated code")
    if mode == "narrate" and (len(result.steps) != len(request.steps) or not any(result.steps)):
        raise ValueError("Narration does not match trace steps")
    if mode == "distractors":
        choices = [item.strip() for item in result.choices]
        if not all(choices) or len(set(choices)) != len(choices) or request.answer.strip() in choices:
            raise ValueError("Distractors must be distinct and exclude the answer")
    if mode == "concepts":
        known = set(request.concept_ids or DATA["concepts"])
        seen = set()
        concepts = []
        for concept in result.concepts:
            if concept.name in seen:
                continue
            seen.add(concept.name)
            if concept.id not in known:
                concept.id = None
            concepts.append(concept)
        result.concepts = concepts
    return result


def generate(mode, request, http_request):
    session = from_headers(http_request.headers)
    try:
        messages = study_prompt(mode, request)
        if len(json.dumps(messages, ensure_ascii=False)) > 80_000:
            raise error(422, "study_input_invalid", "공부 요청이 너무 커요. 실행 기록이나 설명을 줄여 주세요.")
        raw = generate_study_json(
            messages=messages, schema=RESULTS[mode].model_json_schema(),
            deadline=monotonic() + llm.REQUEST_TIMEOUT_SECONDS, session=session,
        )
        try:
            return check_result(mode, raw, request)
        except (ValidationError, ValueError, TypeError):
            raise llm.LLMResponseError from None
    except llm.LLMKeyError as exc:
        raise error(exc.status_code, "llm_key_invalid" if exc.status_code == 401 else "llm_key_forbidden",
                    "AI 키와 해당 제공자의 모델 사용 권한을 확인해 주세요.") from None
    except llm.LLMTimeoutError:
        raise error(504, "study_timeout", "공부 AI 응답 시간이 초과됐어요.") from None
    except llm.LLMResponseError:
        raise error(502, "study_response_invalid", "AI 응답 형식을 확인할 수 없어요.") from None
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Study AI unavailable (%s)", type(exc).__name__)
        raise error(503, "study_service_unavailable", "공부 AI를 준비할 수 없어요. 서버 설정을 확인해 주세요.") from None
    finally:
        if session is not None:
            session.close()


@router.post("/concepts", response_model=ConceptsResult, openapi_extra=HEADERS)
def concepts(request: ConceptsRequest, http_request: Request):
    return generate("concepts", request, http_request)


async def run_isolated(mode, request):
    if request.language not in ("python", "typescript", "javascript"):
        raise error(422, "study_execution_input_invalid", "실행은 python, typescript, javascript를 지원해요.")
    if mode == "run" and not (request.calls or request.tests):
        raise error(422, "study_execution_input_invalid", "calls 또는 tests를 하나 이상 입력해 주세요.")
    try:
        result = await execute(mode, request)
        model = TraceResult if mode == "trace" else RunResult
        return model.model_validate(result).model_dump(exclude_none=True) if mode == "trace" else model.model_validate(result).model_dump()
    except RunnerTimeout:
        raise error(504, "study_execution_timeout", "실행이 5초를 초과해서 멈췄어요.") from None
    except RunnerInputError as exc:
        raise error(422, "study_execution_failed", str(exc)) from None
    except (RunnerUnavailable, ValidationError):
        raise error(503, "study_runner_unavailable", "격리 실행기를 준비할 수 없어요. 서버의 실행기 설정을 확인해 주세요.") from None
    except Exception as exc:
        logger.error("Study runner unavailable (%s)", type(exc).__name__)
        raise error(503, "study_runner_unavailable", "격리 실행 결과를 확인할 수 없어요.") from None


@router.post("/trace")
async def trace(request: TraceRequest):
    return await run_isolated("trace", request)


@router.post("/run")
async def run(request: RunRequest):
    return await run_isolated("run", request)


@router.post("/{mode}", openapi_extra=HEADERS)
def study(mode: StudyMode, payload: dict, http_request: Request):
    try:
        request = REQUESTS.get(mode, StudyRequest).model_validate(payload)
    except ValidationError as exc:
        raise HTTPException(422, detail=exc.errors(include_input=False, include_context=False)) from None
    return generate(mode, request, http_request).model_dump(by_alias=True)
