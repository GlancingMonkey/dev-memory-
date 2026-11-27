"""Study request/response contracts matching Extension study.ts and llm.ts."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


Text = Annotated[str, Field(max_length=8000)]
Short = Annotated[str, Field(max_length=500)]
Line = Annotated[int, Field(ge=1, le=5000)]
ConceptId = Annotated[str, Field(min_length=1, max_length=100)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class StudyRequest(StrictModel):
    code: Annotated[str, Field(min_length=1, max_length=8000)]
    language: Annotated[str, Field(min_length=1, max_length=40)]
    function_name: Annotated[str, Field(max_length=200)] | None = None

    @field_validator("code")
    @classmethod
    def nonempty_code(cls, value):
        if not value.strip() or value.count("\n") >= 5000:
            raise ValueError("code must not be blank and must have at most 5000 lines")
        return value


class ExplainRequest(StudyRequest):
    answer: Annotated[str, Field(min_length=1, max_length=8000)]


class TranslateRequest(StudyRequest):
    target: Annotated[str, Field(min_length=1, max_length=40)]


class DistractorsRequest(StudyRequest):
    call: Annotated[str, Field(min_length=1, max_length=300)]
    answer: Annotated[str, Field(min_length=1, max_length=500)]


class NarrateRequest(StudyRequest):
    call: Annotated[str, Field(max_length=300)] = ""
    steps: Annotated[list[Annotated[str, Field(max_length=2000)]], Field(min_length=1, max_length=400)]


class ConceptsRequest(StudyRequest):
    known_ids: Annotated[list[ConceptId], Field(max_length=200)] = Field(default_factory=list)
    concept_ids: Annotated[list[ConceptId], Field(max_length=200)] = Field(default_factory=list)


class PlainResult(StrictModel):
    one_line: Annotated[str, Field(min_length=1, max_length=300)]
    analogy: Short
    use: Short


class LineExplanation(StrictModel):
    line: Line
    plain: Annotated[str, Field(min_length=1, max_length=400)]


class LinesResult(StrictModel):
    lines: Annotated[list[LineExplanation], Field(min_length=1, max_length=300)]


class NarrateResult(StrictModel):
    summary: Annotated[str, Field(max_length=600)]
    steps: Annotated[list[Annotated[str, Field(max_length=400)]], Field(min_length=1, max_length=400)]


class ExplainPoint(StrictModel):
    verdict: Literal["ok", "partial", "wrong"]
    text: Annotated[str, Field(min_length=1, max_length=300)]
    lines: Annotated[list[Line], Field(max_length=20)]


class ExplainResult(StrictModel):
    points: Annotated[list[ExplainPoint], Field(min_length=1, max_length=8)]


class Alternative(StrictModel):
    label: Annotated[str, Field(min_length=1, max_length=80)]
    code: Annotated[str, Field(max_length=1500)]
    speed: Annotated[str, Field(max_length=30)]
    memory: Annotated[str, Field(max_length=30)]
    readability: Annotated[str, Field(max_length=30)]
    note: Annotated[str, Field(max_length=300)]


class Complexity(StrictModel):
    time: Annotated[str, Field(max_length=40)]
    space: Annotated[str, Field(max_length=40)]
    note: Annotated[str, Field(max_length=300)]


class Deeper(StrictModel):
    title: Annotated[str, Field(min_length=1, max_length=80)]
    text: Annotated[str, Field(max_length=800)]
    doc: Annotated[str, Field(max_length=300)]

    @field_validator("doc")
    @classmethod
    def https_or_empty(cls, value):
        return value if value.startswith("https://") else ""


class WhyResult(StrictModel):
    alternatives: Annotated[list[Alternative], Field(min_length=1, max_length=5)]
    complexity: Complexity
    deeper: Annotated[list[Deeper], Field(max_length=5)]


class TranslationNote(StrictModel):
    from_: Annotated[str, Field(alias="from", max_length=120)]
    to: Annotated[str, Field(max_length=120)]
    why: Annotated[str, Field(max_length=300)]


class TranslateResult(StrictModel):
    language: Annotated[str, Field(min_length=1, max_length=40)]
    code: Annotated[str, Field(min_length=1, max_length=8000)]
    notes: Annotated[list[TranslationNote], Field(max_length=8)]


class ReviewItem(StrictModel):
    kind: Literal["good", "fix", "warn"]
    title: Annotated[str, Field(min_length=1, max_length=60)]
    text: Annotated[str, Field(max_length=400)]
    lines: Annotated[list[Line], Field(max_length=20)]


class ReviewResult(StrictModel):
    items: Annotated[list[ReviewItem], Field(min_length=1, max_length=10)]
    improved_code: Text


class RunTest(StrictModel):
    call: Annotated[str, Field(min_length=1, max_length=300)]
    expected: Annotated[str, Field(max_length=300)]


class TaskResult(StrictModel):
    task: Annotated[str, Field(min_length=1, max_length=400)]
    starter: Text
    tests: Annotated[list[RunTest], Field(min_length=1, max_length=8)]


class BugResult(StrictModel):
    code: Annotated[str, Field(min_length=1, max_length=8000)]
    line: Line
    explain: Short
    fixed_line: Annotated[str, Field(max_length=300)]


class DistractorsResult(StrictModel):
    choices: Annotated[list[Annotated[str, Field(min_length=1, max_length=200)]], Field(min_length=2, max_length=5)]


class AiConcept(StrictModel):
    id: str | None
    name: Annotated[str, Field(min_length=1, max_length=60)]
    level: Literal[1, 2, 3]
    summary: Annotated[str, Field(max_length=400)]
    in_this_code: Annotated[str, Field(max_length=300)]
    lines: Annotated[list[Line], Field(max_length=20)]
    prereq: Annotated[list[Annotated[str, Field(max_length=60)]], Field(max_length=5)]
    misconception: Annotated[str, Field(max_length=300)]
    contrast: Annotated[str, Field(max_length=300)]


class ConceptsResult(StrictModel):
    concepts: Annotated[list[AiConcept], Field(max_length=12)]


class TraceRequest(StudyRequest):
    call: Annotated[str, Field(min_length=1, max_length=300)]


class RunRequest(StudyRequest):
    calls: Annotated[list[Annotated[str, Field(min_length=1, max_length=300)]], Field(max_length=20)] = Field(default_factory=list)
    tests: Annotated[list[RunTest], Field(max_length=20)] = Field(default_factory=list)


class TraceFrame(StrictModel):
    name: str
    vars: dict[str, str]


class TraceObject(StrictModel):
    label: str
    items: list[str]
    look: int
    marks: list[str]


class TraceStep(StrictModel):
    line: Line
    say: str
    frames: list[TraceFrame]
    objects: list[TraceObject]
    ret: str
    col: int | None = None


class TraceResult(StrictModel):
    call: str
    steps: Annotated[list[TraceStep], Field(min_length=1, max_length=400)]
    truncated: bool
    value: str
    stdout: str


class RunCase(StrictModel):
    call: str
    output: str
    error: str
    expected: str
    ok: bool | None


class RunResult(StrictModel):
    cases: Annotated[list[RunCase], Field(min_length=1, max_length=20)]


RESULTS = {
    "plain": PlainResult, "lines": LinesResult, "narrate": NarrateResult,
    "explain": ExplainResult, "why": WhyResult, "translate": TranslateResult,
    "review": ReviewResult, "task": TaskResult, "bug": BugResult,
    "distractors": DistractorsResult, "concepts": ConceptsResult,
}
REQUESTS = {
    "explain": ExplainRequest, "translate": TranslateRequest,
    "distractors": DistractorsRequest, "narrate": NarrateRequest,
    "concepts": ConceptsRequest,
}
