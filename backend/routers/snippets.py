from fastapi import APIRouter

from backend.database import insert_snippet
from backend.schemas.snippet import SnippetCreateRequest

router = APIRouter()


@router.post("/snippets")
def create_snippet(snippet: SnippetCreateRequest):
    snippet_id = insert_snippet(snippet)
    return {
        "id": snippet_id,
        "message": "snippet saved",
    }
