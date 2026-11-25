# 스니펫 삭제 API와 Extension 연결

Extension [PR #68](https://github.com/GlancingMonkey/dev-memory-/pull/68)의 요청에 대응하는 Backend 기능이다.
정확한 요청·응답은 [공식 계약](../API_CONTRACT.md#6-delete-snippetsid)을 따른다.

## Backend에서 제공하는 동작

`DELETE /snippets/{id}`는 선택한 실제 DB ID 한 행만 삭제한다.
같은 행의 원문·메타데이터·벡터·상태가 함께 제거되며 원본 파일은 유지한다.
다른 ID의 동일 코드, 다른 프로젝트, 기존 실험 결과를 정리하지 않는다.
ready뿐 아니라 pending/failed 상태의 행도 삭제할 수 있다.
DB 스키마나 migration, Embedding·LLM 연결 규칙은 변경하지 않는다.

| 응답 | 의미 |
|---|---|
| 200 `{"id":123,"message":"snippet deleted"}` | 지정한 ID의 삭제 커밋 확인 |
| 404 `{"detail":"Snippet not found"}` | 존재하지 않거나 이미 삭제된 ID |
| 422 FastAPI 기본 검증 오류 | 양의 BIGINT 범위 밖이거나 정수로 처리할 수 없는 ID |
| 503 `{"detail":"Snippet deletion unavailable"}` | 삭제 결과 확인 실패. 성공·미삭제로 단정하지 않음 |

ID 123은 구조 예시다. 검색 순위 1이나 S1을 DB ID로 사용하지 않는다.
DB 오류의 예외 원문·연결 비밀값은 응답과 삭제 오류 로그에 기록하지 않는다.

## Extension 담당자 인수인계

대상: **@applecider2**. PR #68의 ✕는 지금처럼 이 PC의 기록 삭제로 유지한다.
이번 Backend 변경에 실제 화면의 DB 삭제 버튼은 포함되지 않는다.

1. 검색 카드에 DB 스니펫 삭제 동작을 따로 제공하고 ID·프로젝트·파일을 확인한다.
2. 사용자가 삭제를 확인하면 실제 DB id로 본문 없는 DELETE를 보낸다.
3. 200이면 해당 ID를 현재 결과·로컬 저장 기록에서 제거하고 검색·GET /filters를 다시 조회한다.
4. 이전 답변 캐시·출처 카드에도 삭제 전 코드가 남을 수 있다. AI 캐시를 무효화하고 화면을 갱신한다.
5. 404는 이미 없는 행으로 안내하고 결과를 갱신한다. 두 번째 삭제 성공으로 표시하지 않는다.
6. 503·통신 실패는 확인 필요로 안내한다. 자동 재시도하거나 성공으로 확정하지 않는다.
7. 중복 그룹의 대표 카드 삭제가 그룹 전체 삭제를 뜻하지 않도록 한다. 다른 ID는 유지된다.

이미 진행 중인 요청이 삭제 전 읽은 자료를 응답할 수 있다. 삭제 직후 새 요청과 화면 갱신 결과를 확인한다.
로컬 파일·프로젝트 위치 연결·전체 기록 지우기는 이 API가 처리하지 않는다.

## 검사 방법

저장소 루트의 Dev Container Bash에서 실행한다.

```bash
uv run --locked python -m unittest discover -s tests -p "test_snippet_delete_api.py" -v
uv run --locked python -m unittest discover -s tests -p "test_*.py" -v
```

단위 검사는 DB·모델을 모의 처리한다. 실제 원본 DB의 스니펫을 삭제하지 않는다.

PostgreSQL과 검색·필터까지 연결하려면 아래 명령을 별도로 실행한다.
현재 DATABASE_URL 계정에 시험 DB 생성·삭제 및 vector 확장 생성 권한이 필요하다.

```bash
uv run --locked python - --apply < tests/manual_snippet_delete_check.py
```

이 검사는 UUID 이름의 시험용 DB를 새로 만든다. 그 DB에서만 시험 행을 저장·삭제하고
끝나면 이번 실행이 만든 DB만 제거한다. 기존 DB는 읽기 전용 스냅샷으로 전후 보존을 대조한다.
실제 PostgreSQL·FastAPI를 사용하지만 Embedding은 고정 벡터로 모의 처리하며 LLM은 호출하지 않는다.
모델 성능·Windows 화면 검증이나 기존 중복 데이터 정리로 기록하지 않는다.

기존 임베딩 모델 비교·RAG 평가 원본과 제출한 포스터는 그대로 유지한다.

## 2026-11-25 Backend 확인 기록

기준은 develop `dd9708f`와 Extension PR #68의 `c7451b7`이다.

| 확인 | 결과 |
|---|---|
| 삭제 API·DB 함수 단위 검사 | 11개 통과. DB·모델 호출과 커밋 실패는 모의 처리 |
| 기존 Backend·RAG 포함 전체 단위 검사 | 114개 통과 |
| 새 PostgreSQL DB의 API 연결 | ready·pending·failed 행 삭제, 재삭제 404, ID 검증 422 확인 |
| 삭제 범위 | 동일 코드의 다른 ID와 다른 프로젝트 행이 원문·벡터·시간 값까지 그대로 유지됨 |
| 삭제 이후 조회 | 새 검색 결과에서 삭제 ID 제외, GET /filters 개수 갱신 확인 |
| 503 | 삭제 함수의 실패를 모의 처리. 실제 DB 장애나 커밋 장애를 발생시키지 않음 |
| 사용 중인 DB | 모든 행·컬럼의 JSON 스냅샷 해시와 행 수가 전후 동일 |
| 시험 DB | 이번 실행에서 만든 UUID 이름의 DB만 제거 완료 |
| 모델·비용 | E5 warmup·벡터 생성은 고정 값으로 모의 처리, LLM 호출 0회 |

`E5 warmup: OK` 출력은 이 검사에서 패치한 startup의 출력이며 실제 모델 추론 결과가 아니다.
Windows에서 삭제 버튼을 누르는 시험은 아직 수행하지 않았다. UI 연결은 Extension의 후속 작업이다.
