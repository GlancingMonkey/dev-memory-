# API Contract

## 1. GET /health

Backend 서버가 실행 중인지 확인한다.

### Success Response — HTTP 200

```json
{
  "status": "ok"
}
```

이 응답은 서버의 실행 상태를 확인한다. Database 연결 상태는 저장 요청과 DB 조회로 따로 확인한다.

## 2. POST /snippets

선택한 코드와 메타데이터를 PostgreSQL의 snippets 테이블에 저장한다.

### Request

Content-Type: application/json

```json
{
  "project_name": "mvp-save-test",
  "file_path": "sample.py",
  "language": "python",
  "function_name": "add",
  "start_line": 1,
  "end_line": 2,
  "code": "def add(a, b):\r\n    return a + b"
}
```

| 필드 | 타입 | 필수 여부 | 설명 |
|---|---|---|---|
| project_name | string | 필수 | 코드가 속한 프로젝트 이름 |
| file_path | string | 필수 | 프로젝트 폴더 기준 상대 경로, 경로 구분자는 `/` |
| language | string | 필수 | 코드의 언어 |
| function_name | string 또는 null | 선택 | 함수 이름, 알 수 없거나 생략하면 null |
| start_line | integer | 필수 | 선택한 코드의 시작 줄, 1부터 계산 |
| end_line | integer | 필수 | 선택한 코드의 마지막 줄, 1부터 계산 |
| code | string | 필수 | 선택한 코드 원문, 줄바꿈과 들여쓰기 포함 |

Extension은 위 7개 필드를 전송한다. 원본 파일의 절대 경로는 Extension 내부에서 사용하며 요청에 포함하지 않는다.

id, created_at, updated_at은 Database가 생성하므로 요청에 포함하지 않는다.

### Success Response — HTTP 200

```json
{
  "id": 2,
  "message": "snippet saved"
}
```

id는 실제로 저장된 DB 행의 숫자 id이다. 예시의 2는 고정값이 아니다.

### Request Validation Error — HTTP 422

필수 필드 누락 또는 Pydantic이 해당 타입으로 처리할 수 없는 값은 요청 검증 오류를 반환한다. 현재 FastAPI의 기본 검증 오류 응답을 사용한다.

### 현재 범위

이번 API는 스니펫 저장만 수행한다. Embedding 생성, Semantic Search, RAG, LLM 호출은 후속 단계에서 별도로 설계한다.
