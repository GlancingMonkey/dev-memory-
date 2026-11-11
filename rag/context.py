import json
from collections.abc import Callable

from backend.schemas.search import SearchResult

CONTEXT_TOKEN_BUDGET = 4_000
INSUFFICIENT_ANSWER = (
    "저장된 코드만으로는 질문에 답할 근거가 부족합니다. "
    "검색 조건이나 질문을 바꿔 주세요."
)


def render_context(sources: list[SearchResult]) -> str:
    """DB 검색 결과를 요청 범위 citation ID와 함께 Context로 직렬화한다."""
    return "\n\n".join(
        json.dumps(
            {
                "citation_id": f"S{index}",
                **source.model_dump(),
            },
            ensure_ascii=False,
        )
        for index, source in enumerate(sources, start=1)
    )


def select_context(
    results: list[dict],
    count_context_tokens: Callable[[str], int],
) -> tuple[list[SearchResult], str]:
    """검색 순서를 보존하며 완전한 검색 결과 단위로 4K Context를 선택한다."""
    sources = [SearchResult(**result) for result in results]
    context = render_context(sources)

    while sources and count_context_tokens(context) > CONTEXT_TOKEN_BUDGET:
        sources.pop()
        context = render_context(sources)

    return sources, context
