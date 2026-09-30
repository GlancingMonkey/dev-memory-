from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Capstone RAG API")


class SnippetCreateRequest(BaseModel):
    project_name: str
    file_path: str
    language: str
    function_name: Optional[str] = None
    start_line: int
    end_line: int
    code: str


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.post("/snippets")
def create_snippet(snippet: SnippetCreateRequest):
    return {
        "id": 1,
        "message": "snippet saved"
    }