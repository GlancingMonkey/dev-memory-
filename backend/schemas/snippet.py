from typing import Optional

from pydantic import BaseModel


class SnippetCreateRequest(BaseModel):
    project_name: str
    file_path: str
    language: str
    function_name: Optional[str] = None
    start_line: int
    end_line: int
    code: str