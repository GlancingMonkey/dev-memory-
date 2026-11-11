# RAG Context 첫 연결

검색 결과의 코드와 메타데이터를 원문 그대로 참고 자료로 묶고,
요청 안에서 사용하는 출처 ID를 연결한다. 관련 이슈: [#43](https://github.com/GlancingMonkey/dev-memory-/issues/43).

현재 구현 범위는 **순수 Context 모듈과 검사**다.
실제 LLM 토큰 계수, `POST /ask`, LLM 호출, Extension 연결은 Backend·Extension 후속 작업이다.
[공식 API 계약](../API_CONTRACT.md)은 변경하지 않았다.
`has_sources=True`만으로 질문에 답할 근거가 충분하다고 판단하지 않는다.

## 파일과 담당 경계

| 경로 | 구분 | 역할 |
|---|---|---|
| `rag/context.py` | 신규 | 출처 표·기본 예산 선택·참고 자료·메시지 구성 |
| `tests/test_rag_context.py` | 신규 | 원문·출처·예산 경계와 오류 전파 검사 |
| `tests/manual_context_check.py` | 신규 | 실제 검색 결과 → Context → DB 원문 읽기 전용 대조 |
| `rag/experiments/rag_smoke/samples.json` | 신규 | 첫 연결용 질문·코드·기대 동작 예시 5개 |
| `rag/README.md` | 기존 수정 | 이 가이드 연결 |

기존 E5, 임베딩 재처리, 모델 비교 원본과 Backend·Database·Extension 코드는 유지한다.

## Backend가 사용할 함수

`backend.database.search_snippets()`의 실제 검색 행 목록을 전달한다.
입력 행은 id·기존 7개 저장 필드·score를 포함해야 한다.
모듈은 재조회·재정렬·코드 중복 제거를 하지 않는다.

```python
from rag.context import build_context, build_rag_messages

# rows: 기존 search_snippets() 결과
# llm_text_counter: 선택한 LLM에 대해 확인한 str -> int 계수 함수를
# Backend 담당자가 연결해야 한다. 이 이름의 구현은 아직 저장소에 없다.
context = build_context(
    rows,
    count_tokens=llm_text_counter,
    token_budget=4000,
)

if context.has_sources:
    messages = build_rag_messages(question, context)
    # Backend가 최종 payload 전체의 입력 토큰 수·제한을 확인한 뒤 호출한다.
else:
    # 생성 호출을 생략하고 합의한 insufficient_context 응답으로 처리한다.
    messages = []
```

위 코드는 연결 방법을 보여 주는 예시이며 독립 실행 명령이 아니다.
`rows`, `question`, 실제 계수 함수를 호출자가 제공해야 한다.
기본 4,000은 #42의 첫 검증용 제안이며 고정된 서비스 계약이나 실측값이 아니다.

반환값은 다음과 같다.

- `text`: sources 배열을 담은 JSON 문자열. 원문은 JSON으로 인코딩되며
  다시 읽으면 CRLF·들여쓰기·문자열이 원래 값과 일치한다.
- `sources`: 변경 불가능한 `ContextSource` 항목의 tuple.
- `token_count`: 전달한 계수 함수로 계산한 참고 자료 문자열의 크기.
  제공자가 보고한 실제 `usage`나 전체 요청 토큰 수가 아니다.
- `skipped_ids`: 예산 때문에 전체가 제외된 DB ID.
- `has_sources`: 자료 존재 여부. 답변 가능 여부·관련성 판정은 별도다.

`RAG_INSTRUCTIONS`는 한국어 답변·실제 출처 인용·근거 부족 안내와
코드·주석·메타데이터를 지시가 아닌 데이터로 취급하는 규칙을 담는다.
JSON 인코딩과 지시문만으로 프롬프트 주입이나 잘못된 답변을 완전히 막았다고
주장하지 않는다. 실제 질문·실패 사례로 별도 검증한다.

## 출처 ID와 답변 검증

검색 결과 순서로 `S1`, `S2` 등을 붙인 뒤 예산을 적용한다.
예를 들어 S2가 너무 크면 선택 결과는 S1·S3일 수 있다.
Backend는 연속된 번호라고 가정하거나 번호를 다시 붙이지 않는다.

`context.cited_sources(["S1", "S3"])`는 실제 선택된 자료의
citation_id·id·7개 저장 필드·score를 새 딕셔너리로 반환한다.
알 수 없거나 중복된 ID를 받으면 오류를 발생시킨다.
경로·줄 번호·원문을 모델이 생성한 값으로 대체하지 않는다.

Backend는 추가로 다음을 확인해야 한다.

1. 실제 응답이 완료됐고 합의한 구조화 형식인지 확인한다.
2. 답변 텍스트의 인용과 모델이 보고한 사용 출처 ID 목록을 대조한다.
3. answered에 비어 있는 답변이나 출처 없는 답변을 허용하지 않는다.
4. 형식·ID 검증과 코드에 대한 설명의 정확성 평가는 구분한다.

## 토큰 계수와 기본 예산 정책

계수 함수는 필수다. E5 토크나이저·문자 수·고정 추정값으로 대체하지 않는다.
실제 LLM 계수 연결 전에는 운영용 토큰 제한이 검증됐다고 표시하지 않는다.

- 출처 ID·메타데이터·원문·JSON 구조를 포함한 **전체 참고 자료 문자열**을 계수한다.
- 전부 예산 안에 들어가면 한 번만 계수한다.
- 넘으면 검색 순서로 완전한 스니펫을 추가해 보고, 초과한 스니펫 전체를
  제외한 뒤 다음 후보를 확인한다. 코드 중간을 잘라 넣지 않는다.
- 같은 문자열의 계수 결과는 한 번의 함수 실행 동안 재사용한다.
- 자료가 비면 계수 함수도 호출하지 않는다.
- 계수 함수 오류와 잘못된 검색 행은 오류로 전달한다.
  모델·계수 장애를 정상적인 근거 부족으로 숨기지 않는다.

원격 계수 API를 매번 연결하면 후보 수에 따라 지연이 늘 수 있다.
지원 여부를 확인한 로컬 텍스트 계수 함수와 최종 요청 전체의 제공자 계수를
Backend가 구분하고, 계수 횟수·시간도 실제 측정에 포함한다.
질문·지시문·메시지 역할·구조화 스키마·출력 한도는 Backend에서 별도 검증한다.

[OpenAI 공식 토큰 계수 문서](https://developers.openai.com/api/docs/guides/token-counting)는
최종 전송할 payload로 계수해야 메시지 구조 등의 오버헤드까지 반영할 수 있다고
설명한다. E5의 512토큰 한도와는 다른 값이다.

## 실행 명령과 정상 결과

Dev Container Bash의 저장소 루트에서 실행한다.

```bash
uv run --locked python -m unittest discover -s tests -p "test_rag_context.py" -v
```

Context 자동 검사를 실행한다. 정상 결과는 `Ran 15 tests`와 `OK`다.
테스트의 계수 함수는 **테스트 전용 가상 단위**이며 실제 LLM 토큰 측정이 아니다.
이 검사는 DB·E5·LLM을 호출하지 않는다.

실제 DB에 검색 가능한 벡터가 준비됐을 때 다음 읽기 전용 검사를 실행한다.

```bash
uv run --locked python - --query "두 숫자를 더하는 함수 찾아줘" --limit 3 < tests/manual_context_check.py
```

질문을 E5로 변환하고 기존 검색 함수를 호출한 뒤, Context의 원문·필드와
실제 DB 행을 대조한다. DB INSERT·UPDATE·migration·LLM 호출은 수행하지 않는다.
예산을 건너뛰고 운영용 Context를 만드는 명령이 아니라 **출처 직렬화 대조 검사**다.
실제 토큰 계수는 실행하지 않았다고 출력한다.

정상 출력에 `DB/source/JSON fields match: True`,
`Read-only Context check: OK`가 포함된다.
자료가 없으면 `No searchable snippets`로 종료하며 성공 대조로 기록하지 않는다.

전체 기존 Python 회귀 검사는 다음과 같다.

```bash
uv run --locked python -m unittest discover -s tests -p "test_*.py" -v
```

## 오류 확인과 다음 단계

- DB 연결 실패: 기존 DATABASE_URL 설정과 실제 DB 실행 상태를 확인한다.
  비밀값은 출력하거나 공유하지 않는다.
- 검색 결과 없음: 같은 DB에 embedding이 준비된 행이 있는지 확인한다.
- 원본 위치 열기 실패: DB의 상대 경로와 현재 PC의 실제 프로젝트 폴더를 확인한다.
- 계수 함수 미연결: Backend와 선택 모델의 계수 방법부터 맞춘다.
- 인용 불일치: 선택된 context.sources의 citation_id와 모델의 사용 출처를 대조한다.

다음은 Backend가 실제 계수·LLM·합의한 API를 연결하고,
Extension에서 답변 인용 → 참고 코드 → 원본 열기를 대조하는 단계다.
#43 전체 완료는 그 실제 통합 결과까지 확인한 뒤 판단한다.

## 2026-11-11 로컬 검증 기록

기준 develop/HEAD는 dff6217이며, 이 기록은 feature/rag의 커밋 전 변경에서
실행한 결과다. 다른 PC의 DB ID나 실제 파일 위치를 가정하지 않는다.

- 신규 Context 15개 + 기존 Python 25개, 전체 40개 자동 검사 통과.
- DB 사전 조회: capstone/public, embedding vector(768), 검색 가능한 행 6개.
- 읽기 전용 질문: 두 숫자를 더하는 함수 찾아줘 / limit=3.
- 반환 출처: S1 → 해당 DB id=1/add, S2 → id=2/even_numbers,
  S3 → id=6/safe_divide.
- DB/source/JSON fields match: True.
- Read-only Context check: OK.
- GPT 호출 0회. 실제 LLM 토큰 수·답변 품질·최종 요청 예산은 아직 미측정.
- 기존 모델 비교를 재실행하지 않았으며 DB 데이터와 벡터를 수정하지 않았다.

위 결과는 실제 검색 행의 출처·원문 전달 검증이다.
질문 5개의 전체 정확도나 RAG 통합 완료 결과가 아니다.
