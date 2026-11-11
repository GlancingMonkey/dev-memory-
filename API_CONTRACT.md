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

## 4. POST /ask

기존 E5 질문 임베딩과 DB 검색 결과를 사용해 저장된 코드에 근거한 단일 답변을 만든다. 이 API만 답변 생성용 LLM을 호출한다. POST /snippets와 GET /search는 계속 LLM을 호출하지 않는다.

### Request

Content-Type: application/json

```json
{
  "q": "두 숫자를 더하는 함수가 어떻게 동작하는지 설명해줘.",
  "limit": 10,
  "history": [
    {"q": "앞서 본 add 함수는 어디에 쓰여?", "answer": "두 값을 더합니다. [S1]"}
  ],
  "stream": true
}
```

| 필드 | 타입 | 필수 여부 | 기본값 | 설명 |
|---|---|---|---|---|
| q | string | 필수 | 없음 | 앞뒤 공백 제거 후 질문. 기존 E5 질문 입력 한도(접두사와 특수 토큰 포함 512토큰)를 적용한다. |
| limit | integer | 선택 | 10 | DB 검색 후보 최대 개수. 1~20. LLM Context에 포함할 코드 개수와는 다르다. |
| history | array | 선택 | `[]` | 이어서 묻기 위한 이전 질문·답변. 최대 2턴. 각 답변은 최대 1,500자이며 입력 토큰 상한에 포함한다. 이전 답변은 질문의 문맥으로만 사용하고 코드 사실의 근거로 삼지 않는다. |
| stream | boolean | 선택 | `false` | `true`이면 SSE로 답변 조각을 전송한다. 생략·`false`이면 일반 JSON으로 한 번 응답한다. |

첫 연결은 전체 DB에서 후보를 검색한다. 프로젝트·언어 필터는 별도 합의 전까지 적용하지 않는다. Extension은 요청에 코드 원문, 파일 절대 경로, 벡터, 모델 선택 또는 API 키를 포함하지 않는다. Backend는 API 키를 Backend의 `.env` 또는 환경변수에서만 읽는다. 키 환경변수명은 LLM 클라이언트 도입 시 확정한다. 사용자 키 입력 UI와 키 전달 API는 이 범위에 포함하지 않는다.

### 답변 완료 — HTTP 200

아래 ID·점수·사용량은 응답 형식 예시이며 실제 DB/API 측정값이 아니다.

```json
{
  "status": "answered",
  "answer": "add는 입력받은 두 값 a와 b의 합을 반환합니다. [S1]",
  "sources": [
    {
      "citation_id": "S1",
      "id": 1,
      "project_name": "mvp-save-test",
      "file_path": "sample.py",
      "language": "python",
      "function_name": "add",
      "start_line": 1,
      "end_line": 2,
      "code": "def add(a, b):\\n    return a + b",
      "score": 0.8
    }
  ],
  "model": "gpt-6.1-sol",
  "usage": {
    "input_tokens": 1500,
    "output_tokens": 200,
    "total_tokens": 1700
  },
  "history_used": 1
}
```

`status`는 `answered` 또는 `insufficient_context`다. `answer`는 단일 문자열이며 코드에 관한 주장은 `[S1]` 형식으로 출처를 표시한다. `sources`는 실제 Context에 포함되고 답변이 인용한 출처만 담는다. 각 항목은 요청 안에서만 쓰는 `citation_id`와 DB 검색 결과의 실제 ID, 기존 저장 필드 7개, `score`를 포함한다. 출처 메타데이터와 원문은 DB 검색 결과에서 조립하며 모델이 만든 경로·줄 번호·코드로 대체하지 않는다. `model`은 호출이 완료됐을 때 제공자가 반환한 실제 모델명이고, `usage`는 제공자가 반환한 실제 `input_tokens`, `output_tokens`, `total_tokens`다. `history_used`는 실제 요청에 반영한 이전 대화 턴 수이며 0 이상이다. 호출하지 않았을 때 model과 usage는 `null`이다.

### SSE 스트리밍

`stream: true`이면 `Content-Type: text/event-stream`으로 다음 순서의 이벤트를 보낸다. 각 `data`는 JSON이다.

```text
event: sources
data: {"sources":[...선택한 DB 출처...]}

event: delta
data: {"text":"답변 조각"}

event: done
data: {...HTTP 200의 최종 응답과 같은 객체...}
```

`delta`는 여러 번 올 수 있다. `sources`는 화면 미리 보기용으로 선택한 전체 참고 자료를 담고, `done`의 sources는 최종 답변이 인용한 자료만 담는다. `done` 없이 스트림이 끝나면 완료된 답변이 아니다. 스트리밍 중 오류는 `event: error`와 `{"status":503,"detail":"안전한 안내문"}` 형식으로 보낸다. 검색·입력 검증처럼 스트림을 열기 전에 생긴 오류는 일반 HTTP 오류 응답으로 반환한다. 클라이언트 취소는 서버 생성이 중단됐거나 과금되지 않았다는 보장이 아니다.

Backend는 모델 응답의 구조, 답변의 비어 있지 않음, 인용 ID와 답변의 인용 표기, 실제로 Context에 전달된 ID인지 검증한다. 알 수 없는 ID, 인용 목록 불일치, 잘못된 형식 또는 미완료 응답은 정상 답변으로 반환하지 않는다. 구조·ID 검증은 답변 주장이 코드와 사실상 일치하는지를 보장하지 않는다.

### 참고 자료 부족 — HTTP 200

검색 후보가 없거나 제한 예산 안에 완전한 스니펫을 하나도 넣을 수 없으면 생성 호출 없이 다음 응답을 반환한다.

```json
{
  "status": "insufficient_context",
  "answer": "저장된 코드만으로는 질문에 답할 근거가 부족합니다. 검색 조건이나 질문을 바꿔 주세요.",
  "sources": [],
  "model": null,
  "usage": null,
  "history_used": 0
}
```

모델 호출 후 근거 부족으로 판단된 경우에도 `status`는 `insufficient_context`지만, `model`과 `usage`에는 실제 호출 결과를 담는다. 관련성 점수 기준으로 결과를 제거하지 않으며, 모델·DB 장애를 근거 부족으로 숨기지 않는다.

### 오류

| HTTP | 상황 | 응답 코드 |
|---|---|---|
| 422 | 질문 누락·공백·E5 입력 한도 초과 또는 잘못된 `limit` | FastAPI 기본 검증 오류 또는 detail 문자열 |
| 503 | E5·DB·LLM 설정 또는 연결을 사용할 수 없음 | `ask_service_unavailable` |
| 504 | 서버 처리 시간 제한 초과 | `ask_timeout` |
| 502 | 잘못된 응답·인용 ID, 생성 불가 또는 출력 한도로 미완료 | `llm_response_invalid` |

오류 detail 객체는 `{"code":"ask_service_unavailable","message":"AI 질문을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요."}` 형식이다. 코드는 위 표의 상황에 맞게 설정한다. 제공자 예외 문자열, API 키 및 연결 비밀값을 응답이나 로그에 포함하지 않는다. 시간 초과 후 자동 재시도·재전송하지 않는다. 시간 초과는 제공자 측 생성이나 과금 여부를 확정하지 않는다.

### 최초 검증용 제한 및 호출 정책

| 항목 | 초기값 |
|---|---|
| 답변 모델 | `gpt-6.1-sol`, reasoning effort `low` |
| Context 예산 | 4,000토큰 |
| 전체 입력 상한 | 8,000토큰(질문·지시문·Context·메시지 구조·스키마 포함) |
| 최대 출력 | 4,096토큰(비가시 토큰 포함) |
| 서버 처리 제한 | 30초 |
| 생성 요청 횟수 | 요청당 1회, 자동 재시도 없음 |

이 값은 최초 검증용 제한이며 실측값이 아니다. Context는 검색 순서대로 완전한 스니펫 단위로 구성하고 코드 중간을 잘라 넣지 않는다. Context 예산과 전체 입력 상한은 실제 LLM 입력 계수 방법으로 검증하며 E5의 512토큰 제한이나 문자 수를 LLM 사용량으로 간주하지 않는다.
