# 테스트와 검증 기록

**코드의 분기 검사**와 **실제 DB·모델·UI 연결 검사**를 구분합니다. 아래는 실행 방법이며, 이 문서를 정리하면서 테스트나 모델 비교를 재실행한 기록은 아닙니다.

## 자동 검사

### Backend·RAG — Dev Container 저장소 루트

```bash
uv run --locked python -m unittest discover -s tests -p "test_*.py" -v
```

tests/test_search_api.py, tests/test_snippet_embedding_api.py, tests/test_retry_embeddings.py가 대상입니다. DB·임베딩 호출을 모의 처리해 요청 검증, 저장 실패 분류, 원문 보존 흐름, 같은 ID 재처리 보호 조건을 검사합니다. 실제 DB와 모델의 동작 검증을 대신하지 않습니다.

### Extension — Windows PowerShell

의존성 설치가 끝난 extension 폴더에서 실행합니다.

```powershell
Set-Location -LiteralPath "C:\dev\capstone-rag\extension"
npm.cmd run test:unit
npm.cmd run compile
```

단위 테스트는 함수 이름 추정·줄 번호·들여쓰기·응답 해석을 검사하고, compile은 TypeScript·ESLint·번들 생성을 수행합니다. 실제 개발 호스트 화면은 별도로 확인합니다.

기존 기록의 Python 25개·Extension 26개 통과는 [통합 검증 문서](INTEGRATION_TEST_2026-11-05.md)의 실행 시점과 근거를 확인하세요. 테스트가 추가되면 개수도 달라집니다.

## 실제 저장·검색 연결

준비와 실행은 [시연 가이드](DEMO.md)를 따릅니다. 매번 받은 **실제 ID**로 대조하며, 예전 기록의 ID를 다른 DB에 그대로 사용하지 않습니다.

| 확인 대상 | 정상 기준 |
|---|---|
| 저장 요청 | 실제 POST·HTTP 응답·ID·ready/error=null 기록 |
| DB 원문 | 코드의 줄바꿈·들여쓰기를 포함해 전송한 7개 필드와 일치 |
| DB 벡터 | 같은 행에 768차원·유한 값·norm 약 1, ready 상태 |
| 검색 API | 같은 질문·limit으로 반환된 ID·코드·메타데이터를 DB와 대조 |
| 검색 UI | 필터를 해제하고 API 순서·ID·코드·점수 표시와 대조 |
| 코드 활용 | 원본 파일과 줄 범위, 새 빈 편집기의 복사·삽입 확인 |

입력 한도 실패는 원문·ID 보존, failed/embedding_input_invalid, 벡터 NULL, UI의 검색 준비 실패 표시를 확인합니다. 같은 긴 입력을 그대로 재처리하지 않습니다.

## 실제 DB를 변경하는 수동 검사

| 파일 | 영향과 선행 조건 |
|---|---|
| [manual_embedding_input_search_check.py](../tests/manual_embedding_input_search_check.py) | 긴 입력 저장 요청으로 시험 행을 추가하고 기존 검색 대상·원문 보존을 확인 |
| [manual_retry_embedding_check.py](../tests/manual_retry_embedding_check.py) | 선택한 기존 행에 생성 실패를 모의한 뒤 실제 E5로 같은 ID를 복구 |

두 파일은 일반 단위 테스트에 자동으로 포함되지 않습니다. 실행 전 파일의 인자·조건과 대상 개발 DB를 확인합니다. 재처리 검사의 실행 방법은 [RAG 안내](../rag/README.md)를 따릅니다. 이미 벡터가 있는 행을 시험하기 위해 지우지 않습니다.

입력 한도 검사 파일은 내부 `NORMAL_PAYLOAD`와 **줄바꿈까지 일치하는** 기존 ready 행을 찾습니다. 현재 값은 LF 줄바꿈의 safe_divide 예시이므로 Windows에서 저장한 CRLF 행은 동일 대상으로 간주되지 않을 수 있습니다. 조건이 맞지 않으면 기존 파일·행을 바꾸기 전에 시험 준비 방법부터 확인합니다.

## 오류 화면과 실제 장애를 구분

검색 UI의 빈 결과·503 표시는 시험 응답을 사용해 확인할 수 있습니다. 이 결과를 실제 DB·모델 장애나 **POST 저장 503**을 재현한 것으로 기록하지 않습니다. 시험 후 실제 API 주소·mock 설정을 복원하고 실제 검색을 확인합니다.

## 결과를 남길 때

- 기준 커밋, 브랜치, 실행 환경, 직접 실행한 명령을 적습니다.
- 실제 ID·질문·limit·순위·응답·실패 보존 결과를 기록합니다.
- 1회 관측 시간과 반복 측정 평균·p95를 구분합니다. 측정하지 않은 값은 쓰지 않습니다.
- 모의 처리와 실제 DB·모델 실행, 이번 실행과 기존 기록 재검토를 구분합니다.
- 변경한 시험 설정을 복원했는지 적고 비밀값은 제외합니다.

[최종 통합 기록](INTEGRATION_TEST_2026-11-05.md) · [문서 목차](README.md)
