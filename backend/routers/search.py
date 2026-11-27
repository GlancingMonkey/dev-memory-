import logging
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from pydantic import ValidationError

from backend.database import search_snippets
from backend.schemas.search import SearchFilters, SearchResponse, SearchResult
from rag.embedding import EmbeddingInputError, embed_query

router = APIRouter(tags=["search"])
logger = logging.getLogger(__name__)


@router.get("/search", response_model=SearchResponse)
def search_snippets_endpoint(
    q: Annotated[str, Query(min_length=1)],
    limit: Annotated[int, Query(ge=1, le=20)] = 10,
    project: str | None = None,
    language: str | None = None,
    concept: str | None = None,
) -> SearchResponse:
    question = q.strip()

    if not question:
        raise HTTPException(
            status_code=422,
            detail="검색 질문을 입력해주세요.",
        )

    try:
        filters = SearchFilters(project=project, language=language, concept=concept)
    except ValidationError:
        raise HTTPException(
            status_code=422,
            detail="프로젝트·언어는 200자, 개념 ID는 100자 이하여야 합니다.",
        ) from None

    try:
        query_vector = embed_query(question)
    except EmbeddingInputError as error:
        raise HTTPException(
            status_code=422,
            detail=str(error),
        ) from None
    except Exception:
        logger.exception("Failed to prepare query embedding")
        raise HTTPException(
            status_code=503,
            detail="Search service unavailable",
        ) from None

    try:
        concept_filter = {"concept": filters.concept} if filters.concept is not None else {}
        results = search_snippets(
            query_vector,
            limit=limit,
            project=filters.project,
            language=filters.language,
            **concept_filter,
        )
    except Exception:
        logger.exception("Failed to search snippets")
        raise HTTPException(
            status_code=503,
            detail="Search service unavailable",
        ) from None

    return SearchResponse(
        results=[SearchResult(**row) for row in results],
        filters=filters,
    )
