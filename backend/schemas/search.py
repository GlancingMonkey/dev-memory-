from pydantic import BaseModel, Field, field_validator, model_serializer


class SearchFilters(BaseModel):
    project: str | None = Field(default=None, max_length=200)
    language: str | None = Field(default=None, max_length=200)
    concept: str | None = Field(default=None, max_length=100)

    @field_validator("project", "language", "concept", mode="before")
    @classmethod
    def normalize(cls, value, info):
        if isinstance(value, str):
            value = value.strip()
            if info.field_name == "language":
                value = value.lower()
            return value or None
        return value

    @model_serializer(mode="wrap")
    def serialize(self, handler):
        result = handler(self)
        if self.concept is None:
            result.pop("concept", None)
        return result


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
    filters: SearchFilters = Field(default_factory=SearchFilters)
