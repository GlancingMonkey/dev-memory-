# 2026-10-28 Semantic Search 통합 검증

## 기준과 범위

- 검증 기준 develop SHA: [0317de8d659017184210afe2e42cd785b3cdb100](https://github.com/GlancingMonkey/dev-memory-/commit/0317de8d659017184210afe2e42cd785b3cdb100)
- 당시 병합된 작업: DB [#19](https://github.com/GlancingMonkey/dev-memory-/pull/19)·[#20](https://github.com/GlancingMonkey/dev-memory-/pull/20), RAG [#21](https://github.com/GlancingMonkey/dev-memory-/pull/21), Backend [#22](https://github.com/GlancingMonkey/dev-memory-/pull/22), Extension [#23](https://github.com/GlancingMonkey/dev-memory-/pull/23).
- 관련 완료 기록: 공통 규칙 [#12](https://github.com/GlancingMonkey/dev-memory-/issues/12), Embedding [#13](https://github.com/GlancingMonkey/dev-memory-/issues/13), DB [#14](https://github.com/GlancingMonkey/dev-memory-/issues/14), 벡터 검색 [#15](https://github.com/GlancingMonkey/dev-memory-/issues/15), API [#16](https://github.com/GlancingMonkey/dev-memory-/issues/16), UI [#17](https://github.com/GlancingMonkey/dev-memory-/issues/17), 통합 [#18](https://github.com/GlancingMonkey/dev-memory-/issues/18).
- 사용자 단계별 실행 기록에 이어 동일 SHA의 실제 로컬 환경에서 직접 검증했다. 아래 값은 당시 해당 DB에서 관측한 값이다.
- 확인 범위는 미리 벡터가 준비된 코드의 검색과 기존 저장 기능이다. 새 저장 후 자동 Embedding·재처리·LLM 답변은 포함하지 않는다.

## 직접 조회한 환경

| 항목 | 값 |
|---|---|
| Extension 실행 위치 | Windows 로컬 VS Code 개발 호스트 |
| VS Code | 1.143.1 x64 / e646868227c3e3a9e3f24277c8c7220be42c0be7 |
| Windows Node / npm | v24.20.0 / 11.19.0 |
| Backend 실행 위치 | Dev Container /workspaces/capstone-rag |
| Python | 3.13.18 |
| torch | 2.8.0+cpu |
| sentence-transformers / transformers / numpy | 5.1.2 / 4.57.1 / 2.2.6 |
| FastAPI / psycopg / pgvector Python | 0.141.1 / 3.3.5 / 0.5.0 |
| DB / schema / pgvector 확장 | capstone / public / 0.8.6 |

이전 사용자 기록에는 Python 3.13.15가 있었으며, 위 표는 추가 직접 실행 때 조회한 현재 환경을 구분해 기록한 것이다.

모델은 intfloat/multilingual-e5-base, revision d128750597153bb5987e10b1c3493a34e5a4502a, CPU/FP32다. query: / passage: 접두사 뒤 공백과 정규화를 적용했다. 기존 세 벡터는 768차원·유한 값·norm 약 1이었다.

## 빌드와 코드 상태

Windows의 extension 폴더에서 다음을 실행했다.

```powershell
npm.cmd run compile
```

check-types(tsc), lint(eslint), esbuild 번들링이 exit code 0으로 통과했다. 개발 호스트를 다시 로드해 이 빌드로 검증했다. 최종 Git 상태는 develop...origin/develop, 미커밋 변경 없음이었다.

## 세 질문의 UI·API·DB 대조

정상 UI 요청은 임시 loopback 프록시를 통해 실제 Backend로 전달하여 JSON을 기록했다. 별도로 같은 질문의 실제 API 응답과 DB 코사인 거리 Top-K를 대조했다.

| 한국어 질문 | 실제 id / 함수 순서 | UI score |
|---|---|---|
| 두 숫자를 더하는 함수 찾아줘 | 1 / add → 2 / even_numbers → 3 / sort_users | 0.848 / 0.812 / 0.754 |
| 숫자 목록에서 짝수만 골라내는 코드 | 2 / even_numbers → 1 / add → 3 / sort_users | 0.804 / 0.788 / 0.760 |
| 사용자들을 나이순으로 정렬하는 코드 | 3 / sort_users → 1 / add → 2 / even_numbers | 0.878 / 0.781 / 0.780 |

UI score는 실제 숫자를 소수점 3자리로 표시한 값이다. 예를 들어 첫 질문의 첫 API score는 0.8482345938682556이었다. 정확도 퍼센트로 표시하지 않았다.

실제 API 결과의 id·순서·기존 7개 필드가 DB와 일치했고 score는 DB의 1-cosine_distance와 오차 0.000001 이내로 일치했다. UI에서는 함수명·전체 순서·코드·프로젝트·언어·경로·시작 줄·점수를 대조했다. id와 끝 줄은 전달된 실제 JSON 및 원본 선택 범위로 확인했다.

세 질문의 기대 함수가 각각 1위인 연결 검증이다. 세 코드·세 질문을 전체 검색 품질이나 새로운 모델 비교 결과로 일반화하지 않는다.

## 원본 열기와 저장 회귀

정렬 결과의 원본 열기로 로컬 테스트 파일 C:\dev\mvp-save-test\sort_users.py가 열렸다. 선택된 원문은 DB의 코드와 줄바꿈 정규화 후 일치했고, 상태 표시는 **줄 2, 열 55(78 선택됨)**으로 1~2줄 전체 선택을 확인했다.

같은 개발 호스트에서 선택한 코드를 저장했다. 실제 POST /snippets가 HTTP 200과 다음 응답을 반환했고 UI에도 저장 성공 id=5가 표시되었다.

```json
{
  "id": 5,
  "message": "snippet saved"
}
```

id=5의 DB 행을 조회하여 실제 요청의 7개 필드와 코드 원문이 CRLF·들여쓰기까지 일치하는 것을 확인했다.

```json
{
  "project_name": "mvp-save-test",
  "file_path": "sort_users.py",
  "language": "python",
  "function_name": "sort_users",
  "start_line": 1,
  "end_line": 2,
  "code": "def sort_users(users):\r\n    return sorted(users, key=lambda user: user[\"age\"])"
}
```

기존 4개 행의 원문·메타데이터·벡터·생성/수정 시각을 포함한 fingerprint가 모두 보존되었다. 행 수는 4 → 5이며 추가된 행은 id=5 하나다. 새 행은 embedding=NULL이고 세 질문의 실제 검색 결과에서 제외되었다. id는 이 테스트 DB의 실제 관측값이며 다른 환경의 고정 id가 아니다.

## UI의 빈 결과와 오류

기존 DB를 유지한 채, 임시 loopback HTTP 서버가 다음 두 응답만 인위적으로 반환하도록 하여 실제 UI 표시를 확인했다. Extension의 Mock 설정은 false였다.

| 주입한 HTTP 응답 | 실제 UI 표시 |
|---|---|
| 200 / results=[] | 결과가 없습니다. |
| 503 / detail=Search service unavailable | 검색 실패: HTTP 503: {"detail":"Search service unavailable"} |

정상 세 질문과 저장 요청은 실제 Backend·DB에서 처리했다. 위 두 경우는 UI 예외 상황 검증용 응답 주입이며, 실제 DB를 비우거나 모델·DB 장애를 일으킨 시험으로 기록하지 않는다.

API 주소를 원래 http://127.0.0.1:8000으로 복원하고 임시 프록시를 종료했다. 이후 UI에서 정렬 질문을 다시 검색하여 sort_users → add → even_numbers 순서의 정상 결과를 확인했다.

## 증빙과 후속 범위

직접 검증 때 만든 baseline.json, ui_http_events.jsonl, ui_observations.json, save_regression.json, verification_report.json은 저장소 밖 로컬 작업 폴더에 보존했다. 캡처된 UI·HTTP·DB 결과를 대조한 최종 결과는 evidence_checks: OK였다. 이 문서는 그 결과를 저장소에 남기는 요약이며, 당시 로컬 DB나 원본 테스트 파일 자체를 배포하지 않는다.

기존 Backend 테스트 4개 통과 기록과 입력 검증·저장 회귀 기록은 #16에 있다. 이 문서 정리 중 기존 세 모델 비교 실험이나 통합 테스트를 다시 실행하지 않았으며, 위에서 완료한 실제 실행 기록을 사용했다.

다음 팀 작업에서 별도로 결정할 항목은 신규 저장 후 자동 Embedding과 실패 재처리다. 프로젝트·언어 필터, RAG/Ask AI, Context Token Budget 최적화와 추가 품질 평가는 이후 개발 범위다.
