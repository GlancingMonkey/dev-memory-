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
from rag.context import INSUFFICIENT_ANSWER, render_context, select_context
from rag.embedding import EmbeddingInputError, embed_query

router = APIRouter(tags=["ask"])
logger = logging.getLogger(__name__)

ANSWER_CITATION = re.compile(r"\[(S[1-9][0-9]*)\]")


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
        return AskResponse(
            status="insufficient_context",
            answer=INSUFFICIENT_ANSWER,
            sources=[],
            model=None,
            usage=None,
        )

    try:
        sources, context = select_context(
            results,
            lambda value: count_context_tokens(
                context=value,
                deadline=deadline,
            ),
        )
        if not sources:
            return AskResponse(
                status="insufficient_context",
                answer=INSUFFICIENT_ANSWER,
                sources=[],
                model=None,
                usage=None,
            )

        input_tokens = count_input_tokens(
            question=question,
            context=context,
            deadline=deadline,
        )
        while input_tokens > MAX_INPUT_TOKENS and sources:
            sources.pop()
            if not sources:
                context = ""
                return AskResponse(
                    status="insufficient_context",
                    answer=INSUFFICIENT_ANSWER,
                    sources=[],
                    model=None,
                    usage=None,
                )
            context = render_context(sources)
            input_tokens = count_input_tokens(
                question=question,
                context=context,
                deadline=deadline,
            )

        _check_deadline(deadline)
        model_answer, model_name, usage = generate_answer(
            question=question,
            context=context,
            deadline=deadline,
        )
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
        if model_answer.citation_ids:
            raise _invalid_model_response()
        return AskResponse(
            status="insufficient_context",
            answer=INSUFFICIENT_ANSWER,
            sources=[],
            model=model_name,
            usage=AskUsage(**usage),
        )

    answer = model_answer.answer.strip()
    answer_ids = ANSWER_CITATION.findall(answer)
    supplied_ids = model_answer.citation_ids
    valid_ids = {f"S{index}" for index in range(1, len(sources) + 1)}
    if (
        not answer
        or not answer_ids
        or len(supplied_ids) != len(set(supplied_ids))
        or set(answer_ids) != set(supplied_ids)
        or not set(supplied_ids).issubset(valid_ids)
    ):
        raise _invalid_model_response()

    source_by_id = {
        f"S{index}": source for index, source in enumerate(sources, start=1)
    }
    return AskResponse(
        status="answered",
        answer=answer,
        sources=[
            AskSource(citation_id=citation_id, **source_by_id[citation_id].model_dump())
            for citation_id in supplied_ids
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
