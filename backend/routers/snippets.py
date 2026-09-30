from fastapi import APIRouter

from backend.schemas.snippet import SnippetCreateRequest

router = APIRouter()


@router.post("/snippets")
def create_snippet(snippet: SnippetCreateRequest):
    return {
        "id": 1,
        "message": "snippet saved",
    }