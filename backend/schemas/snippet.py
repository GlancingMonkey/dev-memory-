from typing import Annotated, Literal, Optional

from pydantic import BaseModel, Field, field_validator


class SnippetCreateRequest(BaseModel):
    project_name: str
    file_path: str
    language: str
    function_name: Optional[str] = None
    start_line: int
    end_line: int
    code: str
    concepts: Annotated[list[Annotated[str, Field(min_length=1, max_length=100)]], Field(max_length=64)] | None = None

    @field_validator("concepts", mode="before")
    @classmethod
    def normalize_concepts(cls, value):
        if isinstance(value, list):
            return list(dict.fromkeys(item.strip() for item in value)) if all(isinstance(item, str) for item in value) else value
        return value


class SnippetDeleteResponse(BaseModel):
    id: int
    message: Literal["snippet deleted"] = "snippet deleted"
