import logging
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query

from backend.database import search_snippets
from backend.schemas.search import SearchResponse, SearchResult
from rag.embedding import EmbeddingInputError, embed_query

router = APIRouter(tags=["search"])
logger = logging.getLogger(__name__)


@router.get("/search", response_model=SearchResponse)
def search_snippets_endpoint(
    q: Annotated[str, Query(min_length=1)],
    limit: Annotated[int, Query(ge=1, le=20)] = 10,
) -> SearchResponse:
    question = q.strip()

    if not question:
        raise HTTPException(
            status_code=422,
            detail="검색 질문을 입력해주세요.",
        )

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
        results = search_snippets(query_vector, limit=limit)
    except Exception:
        logger.exception("Failed to search snippets")
        raise HTTPException(
            status_code=503,
            detail="Search service unavailable",
        ) from None

    return SearchResponse(
        results=[SearchResult(**row) for row in results]
    )