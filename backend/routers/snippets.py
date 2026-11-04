import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from backend.database import (
    get_snippet_embedding_state,
    insert_snippet,
    mark_snippet_embedding_failed,
    save_snippet_embedding,
)
from backend.schemas.snippet import SnippetCreateRequest
from rag.embedding import EmbeddingInputError, embed_code

router = APIRouter()
logger = logging.getLogger(__name__)

SAFE_EMBEDDING_ERRORS = {
    "embedding_input_invalid",
    "embedding_generation_failed",
    "embedding_storage_failed",
}


def _saved_response(
    snippet_id: int,
    embedding_status: str | None,
    embedding_error: str | None,
    status_code: int = 200,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "id": snippet_id,
            "message": "snippet saved",
            "embedding_status": embedding_status,
            "embedding_error": embedding_error,
        },
    )


def _response_from_db(
    snippet_id: int,
    snippet: SnippetCreateRequest,
) -> JSONResponse:
    try:
        state = get_snippet_embedding_state(
            snippet_id=snippet_id,
            project_name=snippet.project_name,
            expected_code=snippet.code,
        )
    except Exception:
        logger.exception("Embedding state read failed: id=%s", snippet_id)
        state = None

    if state is not None:
        if (
            state.get("embedding_status") == "ready"
            and state.get("embedding_valid") is True
            and state.get("embedding_error") is None
        ):
            return _saved_response(snippet_id, "ready", None)

        if (
            state.get("embedding_status") == "failed"
            and state.get("embedding_missing") is True
            and state.get("embedding_error") in SAFE_EMBEDDING_ERRORS
        ):
            return _saved_response(
                snippet_id, "failed", state["embedding_error"]
            )

    return _saved_response(
        snippet_id,
        None,
        "embedding_storage_failed",
        status_code=503,
    )


def _failure_response(
    snippet_id: int,
    snippet: SnippetCreateRequest,
    error_code: str,
) -> JSONResponse:
    try:
        recorded = mark_snippet_embedding_failed(
            snippet_id=snippet_id,
            project_name=snippet.project_name,
            expected_code=snippet.code,
            error_code=error_code,
        )
    except Exception:
        logger.exception("Failure state write failed: id=%s", snippet_id)
        recorded = False

    if recorded:
        return _saved_response(snippet_id, "failed", error_code)

    return _response_from_db(snippet_id, snippet)


@router.post("/snippets")
def create_snippet(snippet: SnippetCreateRequest) -> JSONResponse:
    try:
        snippet_id = insert_snippet(snippet)
    except Exception:
        logger.exception("Snippet storage confirmation failed")
        raise HTTPException(
            status_code=503,
            detail="Snippet storage unavailable",
        ) from None

    try:
        vector = embed_code(snippet.code)
    except EmbeddingInputError:
        logger.warning("Embedding input rejected: id=%s", snippet_id)
        return _failure_response(
            snippet_id, snippet, "embedding_input_invalid"
        )
    except Exception:
        logger.exception("Embedding generation failed: id=%s", snippet_id)
        return _failure_response(
            snippet_id, snippet, "embedding_generation_failed"
        )

    try:
        saved = save_snippet_embedding(
            snippet_id=snippet_id,
            project_name=snippet.project_name,
            expected_code=snippet.code,
            embedding=vector,
        )
    except Exception:
        logger.exception("Embedding storage failed: id=%s", snippet_id)
        return _failure_response(
            snippet_id, snippet, "embedding_storage_failed"
        )

    if saved:
        return _saved_response(snippet_id, "ready", None)

    return _response_from_db(snippet_id, snippet)
