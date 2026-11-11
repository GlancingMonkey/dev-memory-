from typing import Literal

from pydantic import BaseModel, Field

from backend.schemas.search import SearchResult


class AskHistoryTurn(BaseModel):
    q: str = Field(min_length=1, max_length=4_000)
    answer: str = Field(min_length=1, max_length=1_500)


class AskRequest(BaseModel):
    q: str = Field(min_length=1)
    limit: int = Field(default=10, ge=1, le=20)
    stream: bool = False
    history: list[AskHistoryTurn] = Field(default_factory=list, max_length=2)


class AskUsage(BaseModel):
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    total_tokens: int = Field(ge=0)


class AskSource(SearchResult):
    citation_id: str


class AskResponse(BaseModel):
    status: Literal["answered", "insufficient_context"]
    answer: str
    sources: list[AskSource]
    model: str | None
    usage: AskUsage | None
    history_used: int = Field(ge=0)
