import logging
import re
from time import monotonic

from fastapi import APIRouter, HTTPException

from backend.database import search_snippets
from backend.llm import (
    LLMResponseError,
    LLMTimeoutError,
    MAX_INPUT_TOKENS,
    REQUEST_TIMEOUT_SECONDS,
    count_context_tokens,
    count_input_tokens,
    generate_answer,
)
from backend.schemas.ask import AskRequest, AskResponse, AskSource, AskUsage
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
) -> AskResponse:
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
        return _insufficient_context()

    try:
        token_budget = DEFAULT_CONTEXT_BUDGET
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
            return _insufficient_context()

        messages = build_rag_messages(question, context)
        input_tokens = count_input_tokens(messages=messages, deadline=deadline)
        while input_tokens > MAX_INPUT_TOKENS:
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
                return _insufficient_context()
            messages = build_rag_messages(question, context)
            input_tokens = count_input_tokens(messages=messages, deadline=deadline)

        _check_deadline(deadline)
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

    if model_answer.status == "insufficient_context":
        if model_answer.citation_ids or ANSWER_CITATION.search(model_answer.answer):
            raise _invalid_model_response()
        return _insufficient_context(model=model_name, usage=usage)

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
) -> AskResponse:
    return AskResponse(
        status="insufficient_context",
        answer=INSUFFICIENT_ANSWER,
        sources=[],
        model=model,
        usage=AskUsage(**usage) if usage is not None else None,
    )
