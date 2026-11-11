import json
import logging
import re
from time import monotonic

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from backend.database import search_snippets
from backend.llm import (
    LLMResponseError,
    LLMTimeoutError,
    MAX_INPUT_TOKENS,
    REQUEST_TIMEOUT_SECONDS,
    count_context_tokens,
    count_input_tokens,
    generate_answer,
    generate_answer_stream,
)
from backend.schemas.ask import (
    AskRequest,
    AskResponse,
    AskSource,
    AskUsage,
)
from rag.context import (
    DEFAULT_CONTEXT_BUDGET,
    build_context,
    build_rag_messages,
)
from rag.embedding import EmbeddingInputError, embed_query

router = APIRouter(tags=["ask"])
logger = logging.getLogger(__name__)

ANSWER_CITATION = re.compile(r"\[(S[1-9][0-9]*)\]")
INSUFFICIENT_ANSWER = (
    "저장된 코드만으로는 질문에 답할 근거가 부족합니다. "
    "검색 조건이나 질문을 바꿔 주세요."
)


def _error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message},
    )


def _check_deadline(deadline: float) -> None:
    if monotonic() >= deadline:
        raise LLMTimeoutError


@router.post("/ask", response_model=AskResponse)
def ask_endpoint(
    request: AskRequest,
) -> AskResponse | StreamingResponse:
    question = request.q.strip()
    if not question:
        raise HTTPException(status_code=422, detail="질문을 입력해주세요.")

    deadline = monotonic() + REQUEST_TIMEOUT_SECONDS

    try:
        query_vector = embed_query(question)
        _check_deadline(deadline)
        results = search_snippets(query_vector, limit=request.limit)
        _check_deadline(deadline)
    except EmbeddingInputError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None
    except LLMTimeoutError:
        raise _error(
            504,
            "ask_timeout",
            "AI 질문 처리 시간이 초과되었습니다. 다시 실행해 주세요.",
        ) from None
    except Exception as error:
        logger.error("Ask retrieval unavailable (%s)", type(error).__name__)
        raise _error(
            503,
            "ask_service_unavailable",
            "AI 질문을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.",
        ) from None

    if not results:
        if request.stream:
            return _streaming_response(_empty_stream())
        return _insufficient_context()

    try:
        token_budget = DEFAULT_CONTEXT_BUDGET
        history = [turn.model_dump() for turn in request.history]
        count_context = lambda text: count_context_tokens(
            context=text,
            deadline=deadline,
        )
        context = build_context(
            results,
            count_tokens=count_context,
            token_budget=token_budget,
        )
        if not context.has_sources:
            if request.stream:
                return _streaming_response(_empty_stream())
            return _insufficient_context()

        messages = build_rag_messages(question, context, history=history)
        input_tokens = count_input_tokens(messages=messages, deadline=deadline)
        while input_tokens > MAX_INPUT_TOKENS:
            if history:
                history.pop(0)
                messages = build_rag_messages(question, context, history=history)
                input_tokens = count_input_tokens(messages=messages, deadline=deadline)
                continue
            if token_budget <= 1:
                raise HTTPException(
                    status_code=422,
                    detail="요청이 최대 입력 토큰을 초과합니다.",
                )
            token_budget = max(1, token_budget // 2)
            context = build_context(
                results,
                count_tokens=count_context,
                token_budget=token_budget,
            )
            if not context.has_sources:
                if request.stream:
                    return _streaming_response(_empty_stream())
                return _insufficient_context()
            messages = build_rag_messages(question, context, history=history)
            input_tokens = count_input_tokens(messages=messages, deadline=deadline)

        _check_deadline(deadline)
        if request.stream:
            return _streaming_response(
                _stream_answer(context, messages, len(history), deadline)
            )
        model_answer, model_name, usage = generate_answer(
            messages=messages,
            deadline=deadline,
        )
    except HTTPException:
        raise
    except LLMTimeoutError:
        raise _error(
            504,
            "ask_timeout",
            "AI 질문 처리 시간이 초과되었습니다. 다시 실행해 주세요.",
        ) from None
    except LLMResponseError:
        raise _error(
            502,
            "llm_response_invalid",
            "AI 답변 형식을 검증할 수 없습니다. 질문을 다시 실행해 주세요.",
        ) from None
    except Exception as error:
        logger.error("Ask generation unavailable (%s)", type(error).__name__)
        raise _error(
            503,
            "ask_service_unavailable",
            "AI 질문을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.",
        ) from None

    return _answer_response(
        model_answer,
        model_name,
        usage,
        context,
        history_used=len(history),
    )


def _answer_response(
    model_answer,
    model_name: str,
    usage: dict[str, int],
    context,
    *,
    history_used: int,
) -> AskResponse:
    if model_answer.status == "insufficient_context":
        if model_answer.citation_ids or ANSWER_CITATION.search(model_answer.answer):
            raise _invalid_model_response()
        return _insufficient_context(
            model=model_name,
            usage=usage,
            history_used=history_used,
        )

    answer = model_answer.answer.strip()
    answer_ids = ANSWER_CITATION.findall(answer)
    supplied_ids = model_answer.citation_ids
    valid_ids = {source.citation_id for source in context.sources}
    if (
        not answer
        or not answer_ids
        or len(supplied_ids) != len(set(supplied_ids))
        or set(answer_ids) != set(supplied_ids)
        or not set(supplied_ids).issubset(valid_ids)
    ):
        raise _invalid_model_response()

    try:
        cited_sources = context.cited_sources(supplied_ids)
    except ValueError:
        raise _invalid_model_response() from None

    return AskResponse(
        status="answered",
        answer=answer,
        sources=[
            AskSource(**source) for source in cited_sources
        ],
        model=model_name,
        usage=AskUsage(**usage),
        history_used=history_used,
    )


def _sse_event(name: str, payload: dict) -> str:
    return f"event: {name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _streaming_response(content) -> StreamingResponse:
    return StreamingResponse(
        content,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def _empty_stream():
    response = _insufficient_context(history_used=0)
    yield _sse_event("sources", {"sources": []})
    yield _sse_event("done", response.model_dump())


def _stream_answer(context, messages, history_used: int, deadline: float):
    yield _sse_event(
        "sources",
        {"sources": [source.to_dict() for source in context.sources]},
    )
    try:
        final = None
        for kind, value in generate_answer_stream(messages=messages, deadline=deadline):
            if kind == "delta":
                yield _sse_event("delta", {"text": value})
            elif kind == "complete":
                final = value
        if final is None:
            raise LLMResponseError
        model_answer, model_name, usage = final
        response = _answer_response(
            model_answer,
            model_name,
            usage,
            context,
            history_used=history_used,
        )
        yield _sse_event("done", response.model_dump())
    except HTTPException as error:
        detail = error.detail
        if isinstance(detail, dict):
            detail = detail.get("message", "AI 답변을 확인할 수 없습니다.")
        yield _sse_event("error", {"status": error.status_code, "detail": str(detail)})
    except LLMTimeoutError:
        yield _sse_event(
            "error",
            {"status": 504, "detail": "AI 질문 처리 시간이 초과되었습니다. 다시 실행해 주세요."},
        )
    except LLMResponseError:
        error = _invalid_model_response()
        detail = error.detail["message"]
        yield _sse_event("error", {"status": 502, "detail": detail})
    except Exception as error:
        logger.error("Ask stream unavailable (%s)", type(error).__name__)
        yield _sse_event(
            "error",
            {
                "status": 503,
                "detail": "AI 질문을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.",
            },
        )


def _invalid_model_response() -> HTTPException:
    return _error(
        502,
        "llm_response_invalid",
        "AI 답변의 출처를 검증할 수 없습니다. 질문을 다시 실행해 주세요.",
    )


def _insufficient_context(
    *,
    model: str | None = None,
    usage: dict[str, int] | None = None,
    history_used: int = 0,
) -> AskResponse:
    return AskResponse(
        status="insufficient_context",
        answer=INSUFFICIENT_ANSWER,
        sources=[],
        model=model,
        usage=AskUsage(**usage) if usage is not None else None,
        history_used=history_used,
    )
