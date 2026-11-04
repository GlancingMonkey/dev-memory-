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

### 처리 순서

1. 요청의 7개 필드를 검증한다.
2. 코드 원문과 메타데이터를 저장하고 커밋한다.
3. 저장된 코드 원문으로 E5 임베딩을 생성한다.
4. 같은 ID의 행에 벡터와 처리 상태를 저장한 뒤 응답한다.

임베딩 생성은 원문 저장 트랜잭션 밖에서 수행한다.
정상 저장 요청은 벡터 저장까지 기다린다.
검색과 저장 과정에서 LLM은 호출하지 않는다.

### 저장 및 검색 준비 완료 — HTTP 200

```json
{
  "id": 5,
  "message": "snippet saved",
  "embedding_status": "ready",
  "embedding_error": null
}
```

ready는 해당 코드의 벡터 저장까지 완료됐다는 뜻이다.
예시 ID는 고정값이 아니라 DB에서 생성한 실제 ID로 반환한다.

### 원문 저장 완료, 임베딩 실패 — HTTP 200

```json
{
  "id": 5,
  "message": "snippet saved",
  "embedding_status": "failed",
  "embedding_error": "embedding_generation_failed"
}
```

이 경우 원문과 메타데이터는 이미 저장되어 있다.
같은 ID를 유지하고 벡터는 NULL, 상태는 failed로 기록한다.

HTTP 200과 message는 원문 저장 완료를 뜻한다.
Extension은 embedding_status를 확인해 검색 준비 결과를 별도로 안내한다.

### 응답 필드

| 필드 | 타입 | 설명 |
|---|---|---|
| id | integer | 원문 저장이 확인된 실제 DB ID |
| message | string | 원문 저장 완료 시 snippet saved |
| embedding_status | string 또는 null | 완료 상태 ready 또는 failed. 상태 확인 불가 시 null |
| embedding_error | string 또는 null | 안전한 실패 코드. ready이면 null |

DB의 pending은 임베딩 미처리 상태다.
pending만으로 백그라운드 작업이 실행 중이라고 판단하지 않는다.

### 임베딩 실패 코드

| 코드 | 의미 |
|---|---|
| embedding_input_invalid | 코드가 비었거나 E5 입력 한도를 초과함 |
| embedding_generation_failed | 모델 준비 또는 벡터 생성 실패 |
| embedding_storage_failed | 벡터 또는 처리 상태 저장 실패 |

E5 입력 한도는 passage: 접두사와 특수 토큰을 포함해 512토큰이다.
입력 한도 초과 시에도 원문을 보존하고 failed로 기록한다.
같은 입력을 그대로 반복 재시도하지 않는다.

서버 예외 문자열이나 DB 연결 비밀값을 응답에 포함하지 않는다.

### 원문 저장 완료, 최종 상태 확인 불가 — HTTP 503

원문 저장은 확인됐지만 DB 오류 등으로 벡터·실패 상태의
최종 저장 결과를 확인할 수 없는 경우다.

```json
{
  "id": 5,
  "message": "snippet saved",
  "embedding_status": null,
  "embedding_error": "embedding_storage_failed"
}
```

null은 API가 최종 상태를 확정하지 못했다는 뜻이며,
DB에 새 상태 값을 추가하는 것이 아니다.

Extension은 저장된 ID를 안내하고 검색 준비 완료로 표시하지 않는다.
같은 POST를 다시 보내지 않고 해당 ID의 DB 상태부터 확인한다.

벡터 갱신 결과가 0행이면 해당 ID와 원문의 상태를 다시 확인한다.
ready 또는 failed를 확인할 수 없다면 위 응답으로 처리한다.

### 원문 저장 확인 실패 — HTTP 503

```json
{
  "detail": "Snippet storage unavailable"
}
```

원문 저장 완료를 확인할 수 없는 경우다.
저장되지 않았다고 단정하거나 자동으로 POST를 재전송하지 않는다.
상세 원인은 서버 로그와 DB에서 확인한다.

### Request Validation Error — HTTP 422

필수 필드 누락 또는 Pydantic이 해당 타입으로 처리할 수 없는 값은
기존 FastAPI 기본 검증 오류 응답을 반환한다.

요청 검증을 통과한 뒤 발생한 임베딩 입력 오류는
원문을 보존하고 embedding_input_invalid로 처리한다.

### 시간 초과와 재처리

- 응답 시간 초과만으로 원문 저장 실패를 단정하지 않는다.
- 서버 로그와 DB를 확인하기 전에 같은 POST를 반복하지 않는다.
- 재처리는 기존 ID·프로젝트·원문을 확인하고 같은 행을 갱신한다.
- 이미 벡터가 있는 행은 덮어쓰지 않는다.
- 재처리 성공 시 ready로 변경하고 embedding_error를 NULL로 지운다.
- 원문·메타데이터·기존 ID를 유지한다.

### 현재 범위

이번 구현 범위는 스니펫 저장 후 자동 임베딩과 상태 반환이다.
실제 연결과 완료 여부는 API·DB·Extension 통합 테스트로 확인한다.
RAG 답변과 LLM 호출은 후속 단계에서 구현한다.
## 3. GET /search

자연어 질문을 Embedding한 뒤 PostgreSQL에서 관련 스니펫을 검색한다.
이 API는 LLM을 호출하지 않는다.

### Request — Query Parameters

| 이름 | 타입 | 필수 여부 | 기본값 | 설명 |
|---|---|---|---|---|
| q | string | 필수 | 없음 | 검색할 자연어 질문 |
| limit | integer | 선택 | 10 | 최대 결과 개수. 1~20 |

- 질문은 앞뒤 공백을 제거한 후 처리하며, 빈 질문은 허용하지 않는다.
- 질문 입력은 E5 접두사와 특수 토큰을 포함해 최대 512토큰이다.
- 검색 대상은 embedding이 존재하고 영벡터가 아닌 행이다.
- 전체 검색 대상에서 조회하며 테스트용 id로 제한하지 않는다.

### Success Response — HTTP 200

```json
{
  "results": [
    {
      "id": 1,
      "project_name": "mvp-save-test",
      "file_path": "sample.py",
      "language": "python",
      "function_name": "add",
      "start_line": 1,
      "end_line": 2,
      "code": "def add(a, b):\r\n    return a + b",
      "score": 0.848235
    }
  ]
}
```

위 응답은 구조 예시다. score 예시는 기존 DB 검증 거리에서 계산했으며,
새 검색 API를 실행해 측정한 응답은 아니다.

- results는 검색 결과 배열이며 최대 limit개를 반환한다.
- 각 결과는 실제 DB의 id, 기존 저장 7개 필드, score를 포함한다.
- 기존 저장 필드의 타입은 POST /snippets 계약과 같다.
- function_name은 문자열 또는 null이다.
- score는 `1 - cosine_distance`로 계산한 코사인 유사도다.
- score의 범위는 -1~1이며, 클수록 유사하다.
- 코사인 거리 오름차순으로 정렬하고 동점이면 id 오름차순으로 정렬한다.
- score는 정답 확률이나 검색 정확도 퍼센트가 아니다.

### 검색 대상이 없는 경우 — HTTP 200

```json
{
  "results": []
}
```

벡터가 준비된 검색 대상이 없으면 빈 배열을 반환한다.
관련 없는 질문이라는 이유만으로 빈 배열을 보장하지는 않는다.
관련성 기준점에 따른 결과 제거는 후속 품질 검증에서 결정한다.

### Request Validation Error — HTTP 422

다음 경우 요청 검증 오류를 반환한다.

- q 누락 또는 공백뿐인 질문
- 접두사와 특수 토큰을 포함한 질문이 512토큰을 초과
- limit이 정수가 아니거나 1~20 범위 밖인 경우

오류는 detail 필드로 전달한다.
파라미터 검증은 FastAPI 기본 오류 응답을 사용하고,
추가 입력 검사는 detail 문자열을 사용할 수 있다.

### 검색 서비스 준비 실패 — HTTP 503

모델 준비 또는 Database 연결·검색을 수행할 수 없는 경우:

```json
{
  "detail": "Search service unavailable"
}
```

상세 원인은 서버 로그에 기록하고 연결 비밀값을 응답에 포함하지 않는다.