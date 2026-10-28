from pydantic import BaseModel, Field


class SearchResult(BaseModel):
    id: int
    project_name: str
    file_path: str
    language: str
    function_name: str | None
    start_line: int
    end_line: int
    code: str
    score: float = Field(ge=-1.0, le=1.0)


class SearchResponse(BaseModel):
    results: list[SearchResult]