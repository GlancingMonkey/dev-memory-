from pydantic import BaseModel, Field


class FilterOption(BaseModel):
    name: str
    count: int = Field(ge=1)


class FilterOptionsResponse(BaseModel):
    projects: list[FilterOption]
    languages: list[FilterOption]
