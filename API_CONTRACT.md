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
| concepts | string[] 또는 null | 선택 | 개념 ID 목록. 최대 64개, 각 ID는 공백 제거 후 1~100자. 중복 제거 |

기존 7개 필드 요청을 유지하며 concepts는 선택적으로 추가한다. 원본 파일의 절대 경로는 Extension 내부에서 사용하며 요청에 포함하지 않는다.

concepts 생략·null이면 기존 7개 필드 INSERT를 유지한다. [] 또는 ID 배열을 전송하면 DB의 concepts 컬럼에 저장한다.
Backend가 기대하는 DB 계약은 snippets.concepts TEXT[]다. 실제 컬럼·마이그레이션은 DB 담당자가 별도로 제공한다.
Backend는 컬럼을 자동 생성하거나 기존 코드를 개념별로 갱신하지 않는다. 컬럼 준비 전 concepts를 전송한 저장은 기존 503 규칙으로 처리한다.

id, created_at, updated_at은 Database가 생성하므로 요청에 포함하지 않는다.

### 처리 순서

1. 기존 7개 필드와 선택 concepts를 검증한다.
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
| project | string | 선택 | 없음 | 앞뒤 공백 제거, 최대 200자. 대소문자 구분 |
| language | string | 선택 | 없음 | 앞뒤 공백 제거·소문자 변환, 최대 200자 |
| concept | string | 선택 | 없음 | 앞뒤 공백 제거, 최대 100자. concepts 배열 안의 개념 ID와 대소문자 구분해 일치 |

- 질문은 앞뒤 공백을 제거한 후 처리하며, 빈 질문은 허용하지 않는다.
- 질문 입력은 E5 접두사와 특수 토큰을 포함해 최대 512토큰이다.
- 검색 대상은 embedding이 존재하고 영벡터가 아닌 행이다.
- 조건을 생략하거나 공백만 보내면 해당 조건 없이 조회한다. 지정한 조건은 AND로 결합한다.
- 프로젝트는 앞뒤 공백을 제거한 DB 이름과 대소문자를 구분해 일치시킨다. 언어는 DB 값도 앞뒤 공백 제거·소문자로 변환해 비교한다.
- 존재하지 않는 조건은 HTTP 200과 빈 results를 반환한다.
- 조건은 전체 검색 후보의 WHERE에 적용한 뒤 거리 정렬·Top-K를 수행한다. 기존 Top-K 안에서만 거르지 않는다.
- 전체 검색 대상에서 조회하며 테스트용 id로 제한하지 않는다.
- 응답 filters에는 실제 적용한 정규화 조건을 반환한다. 미지정 project·language는 null이다. concept는 지정했을 때만 추가해 기존 무조건 검색 응답 모양을 유지한다.
- concept는 WHERE의 `%s = ANY(concepts)`로 제한한 뒤 거리 정렬·LIMIT을 수행한다. 검색 결과의 기본 7개 필드·score는 유지한다.
- DB concepts 컬럼이 없는데 concept를 지정하면 503이다. 조건을 무시한 검색이나 빈 결과 성공으로 바꾸지 않는다.
- /ask는 이번 검색 조건을 받지 않으며 기존처럼 전체 DB에서 참고 자료를 찾는다.

### Success Response — HTTP 200

```json
{
  "filters": {"project": null, "language": null},
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
  "results": [],
  "filters": {"project": null, "language": null}
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
- 정규화한 project 또는 language가 200자를 초과하는 경우
- 정규화한 concept가 100자를 초과하는 경우

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

기존 E5 질문 임베딩과 DB 검색 결과를 사용해 저장된 코드에 근거한 단일 답변을 만든다. 이 API와 아래 공부 AI API가 답변 생성용 LLM을 호출한다. POST /snippets와 GET /search는 계속 LLM을 호출하지 않는다.

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

AI 질문은 전체 DB에서 후보를 검색한다. 일반 검색의 프로젝트·언어 필터는 적용하지 않는다.
요청 JSON은 기존 q·limit·history·stream을 유지하며 키·모델·벡터·절대 경로를 넣지 않는다.

### 선택 사용자 키 헤더 (Extension PR #53 대응)

| 헤더 | 값 | 동작 |
|---|---|---|
| X-LLM-API-Key | 사용자가 선택한 제공자의 키 | POST /ask 한 요청에서만 사용 |
| X-LLM-Provider | openai 또는 anthropic 또는 google | 해당 제공자의 계수·생성 API를 사용 |

- 두 헤더가 모두 없으면 기존 서버 OPENAI_API_KEY와 GPT-6.1 Sol을 사용한다.
- 사용자 키를 보낼 때는 두 헤더를 함께 보낸다. 한쪽만 있거나 중복 헤더·빈 키·키 내부 공백/제어문자·4096자 초과 키는 401/llm_key_invalid다.
- 알 수 없는 제공자는 422/llm_provider_unsupported다. 키의 접두사만으로 유효성이나 제공자를 단정하지 않는다.
- 사용자가 준 키는 전역 캐시·환경변수·파일·DB에 저장하지 않고 해당 요청의 클라이언트에만 전달한다. 다른 요청이나 서버 기본 클라이언트와 공유하지 않는다.
- 같은 사용자 키·제공자·모델을 참고 자료 계수·최종 입력 계수·생성에 일관되게 사용한다.
- 사용자 키 실패 후 서버 키나 다른 제공자로 자동 전환·재전송하지 않는다. 서버 키로 다시 묻기는 사용자의 새 명시적 요청이다.
- 제공자 키·모델은 기존 응답에 추가하지 않는다. model은 실제 제공자 응답의 모델명이다.
- 사용자 OpenAI 키는 api.openai.com, Claude 키는 api.anthropic.com, Gemini 키는 generativelanguage.googleapis.com으로만 전달한다. Gemini 키도 URL 쿼리가 아닌 헤더로 보낸다. 리디렉션을 따라 키를 재전송하지 않는다.
- Extension은 키를 SecretStorage에 보관하고 사용자 확인한 HTTPS 서버 또는 같은 PC의 localhost에만 보낸다. Backend 주소 변경 시 제공 대상도 확인한다.
- 검색 후보가 없으면 키 유효성을 외부 API에 확인하지 않고 기존 근거 부족 응답을 반환한다. 이 응답은 키 인증 성공을 뜻하지 않는다.

| 제공자 | 초기 모델 | 서버 모델 설정 |
|---|---|---|
| openai | gpt-6.1-sol, reasoning low | 기존 고정 모델 유지 |
| anthropic | claude-haiku-5-5 | ANTHROPIC_MODEL |
| google | gemini-3.1-flash-lite | GEMINI_MODEL |

추가 제공자의 모델은 공식 API에서 확인한 초기 연결값이며 품질·속도·비용 우위 평가 결과가 아니다.
각 키의 계정에서 해당 모델을 사용할 수 있어야 한다. 서버 설정으로 모델을 바꾸면 계수·생성에 같은 모델을 적용하고 별도로 검증한다.


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

`delta`는 여러 번 올 수 있다. OpenAI는 제공자 스트림의 답변 조각을 전달한다. Claude·Gemini는 현재 제공자 JSON 생성을 한 번 완료한 뒤 답변 문자열을 한 delta로 전달하고 done으로 마친다. 두 제공자의 토큰 단위 실시간 스트리밍을 구현했다는 뜻은 아니다. `sources`는 화면 미리 보기용으로 선택한 전체 참고 자료를 담고, `done`의 sources는 최종 답변이 인용한 자료만 담는다. `done` 없이 스트림이 끝나면 완료된 답변이 아니다. 스트리밍 중 오류는 `event: error`와 `{"status":503,"detail":"안전한 안내문"}` 형식으로 보낸다. 검색·입력 검증처럼 스트림을 열기 전에 생긴 오류는 일반 HTTP 오류 응답으로 반환한다. 클라이언트 취소는 서버 생성이 중단됐거나 과금되지 않았다는 보장이 아니다.

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
| 422 | 지원하지 않는 제공자 | `llm_provider_unsupported` |
| 401 | 잘못된 사용자 키 헤더 또는 제공자 인증 거절 | `llm_key_invalid` |
| 403 | 제공자 키의 모델·계정 권한 거절 | `llm_key_forbidden` |
| 503 | E5·DB·LLM 설정 또는 연결을 사용할 수 없음 | `ask_service_unavailable` |
| 504 | 서버 처리 시간 제한 초과 | `ask_timeout` |
| 502 | 잘못된 응답·인용 ID, 생성 불가 또는 출력 한도로 미완료 | `llm_response_invalid` |

스트림을 연 뒤 인증이 실패하면 HTTP 상태는 이미 200이며 error 이벤트에 status=401 또는 403, 안전한 detail 문자열과 code를 보낸다. done은 보내지 않는다. 스트림을 열기 전 계수 단계의 인증 실패는 일반 HTTP 401/403이다. 할당량·잔액·속도 제한·일반 제공자 장애를 키 인증 오류로 단정하지 않고 503으로 전달한다.

오류 detail 객체는 `{"code":"ask_service_unavailable","message":"AI 질문을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요."}` 형식이다. 코드는 위 표의 상황에 맞게 설정한다. 제공자 예외 문자열, API 키 및 연결 비밀값을 응답이나 로그에 포함하지 않는다. 시간 초과 후 자동 재시도·재전송하지 않는다. 시간 초과는 제공자 측 생성이나 과금 여부를 확정하지 않는다.

### 최초 검증용 제한 및 호출 정책

| 항목 | 초기값 |
|---|---|
| 기본 답변 모델 | `gpt-6.1-sol`, reasoning effort `low`; 사용자 키 선택 시 위 제공자 표 적용 |
| Context 예산 | 4,000토큰 |
| 전체 입력 상한 | 8,000토큰(질문·지시문·Context·메시지 구조·스키마 포함) |
| 최대 출력 | 4,096토큰(비가시 토큰 포함) |
| 서버 처리 제한 | 30초 |
| 생성 요청 횟수 | 요청당 1회, 자동 재시도 없음 |

이 값은 최초 검증용 제한이며 실측값이 아니다. Context는 검색 순서대로 완전한 스니펫 단위로 구성하고 코드 중간을 잘라 넣지 않는다. Context 예산과 전체 입력 상한은 실제 LLM 입력 계수 방법으로 검증하며 E5의 512토큰 제한이나 문자 수를 LLM 사용량으로 간주하지 않는다.

제공자별 토큰 계수 API를 사용하며 문자 수로 대체하지 않는다. Claude의 입력 계수는 제공자가 안내하는 추정치이므로 실제 usage와 항상 같다고 가정하지 않는다.
Claude usage.input_tokens에는 응답의 input_tokens + cache_creation_input_tokens + cache_read_input_tokens를 합산하며 output_tokens는 실제 출력 값, total_tokens는 이 입력·출력 합계다.
Gemini input_tokens는 promptTokenCount, output_tokens는 candidatesTokenCount + thoughtsTokenCount, total_tokens는 실제 totalTokenCount다. 추론 토큰도 출력에 포함하며 합계가 맞지 않거나 필수 사용량이 없으면 검증 오류로 처리한다.
다른 제공자·모델의 수치를 기존 GPT 평가의 전후 절감률과 직접 섞지 않는다.

Context는 같은 프로젝트·언어 안에서 코드가 같은 후보를 묶는다.
코드 줄바꿈은 비교할 때만 맞추며 원문·메타데이터·DB 행은 바꾸지 않는다.
검색 순서상 예산에 들어오는 대표 전체 스니펫을 선택하고 다른 프로젝트의 출처는 유지한다.
선택 후 citation_id를 다시 붙이지 않으며 제외 사유·대표 ID는 내부 검증 자료로 기록한다.
한 요청의 동일 참고 자료·동일 최종 메시지 계수는 재사용한다.

## 5. GET /filters

검색 가능한 스니펫의 프로젝트·언어 목록과 각 이름에 속한 코드 수를 반환한다.
검색 질문이나 선택 조건 없이 전체 DB를 집계한다. Embedding 생성과 LLM 호출은 수행하지 않는다.

### Request

쿼리 파라미터와 요청 본문은 없다.

### Success Response — HTTP 200

```json
{
  "projects": [
    {"name": "mvp-save-test", "count": 3}
  ],
  "languages": [
    {"name": "python", "count": 3}
  ]
}
```

위 이름과 개수는 응답 구조를 설명하는 예시이며 실제 DB 측정값이 아니다.

- projects와 languages는 항상 배열이다.
- 프로젝트 name은 DB 이름의 앞뒤 공백을 제거한다. 언어 name은 앞뒤 공백 제거·소문자 변환 후 집계한다.
- 정규화한 이름이 같으면 count를 합산한다. 이름이 빈 항목은 목록에서 제외하며 무필터 검색에는 남을 수 있다.
- 코드·DB의 원본 메타데이터는 변경하지 않는다.
- count는 해당 이름에 속한 검색 가능한 스니펫 행 수이며 양의 정수다.
- 검색 대상과 동일하게 embedding이 NULL이 아니고 vector_norm(embedding)이 0보다 큰 행만 센다.
- embedding_status 값만으로 검색 가능 여부를 판단하지 않는다.
- 벡터가 없는 pending/failed 행과 영벡터는 집계에서 제외한다.
- 같은 코드가 서로 다른 DB 행에 저장돼 있으면 각 행을 센다. 고유 코드 수가 아니다.
- 각 배열은 DB의 이름 오름차순으로 정렬한다.
- 프로젝트와 언어는 각각 독립적으로 전체 검색 가능한 행을 집계한다.
- 검색 결과의 Top-K나 현재 화면에 표시된 결과 수로 목록을 만들지 않는다.
- GET /search의 project·language 조건과 같은 이름 처리 규칙을 사용한다. 선택 조건은 GET /search에 명시적으로 전달한다.

### 검색 대상이 없는 경우 — HTTP 200

```json
{
  "projects": [],
  "languages": []
}
```

검색 가능한 행이 없는 이름은 개수 0으로 나열하지 않고 목록에서 제외한다.

### DB 조회 실패 — HTTP 503

```json
{
  "detail": "Filter service unavailable"
}
```

DB 조회 실패를 빈 목록 성공으로 표시하지 않는다.
서버 오류 문자열이나 연결 비밀값을 응답에 포함하지 않는다.

## 6. DELETE /snippets/{id}

사용자가 선택한 스니펫 ID의 DB 행 하나를 삭제한다.
Extension PR #68의 로컬 기록 삭제·중복 결과 접기와 별개의 기능이다.
Embedding 생성과 LLM 호출은 수행하지 않는다.

### Request

| 이름 | 위치 | 타입 | 설명 |
|---|---|---|---|
| id | path | integer | 삭제할 실제 DB ID. 1~9223372036854775807 |

요청 본문은 없다. 검색 결과의 순위나 출처 번호 S1 대신 실제 DB id를 전달한다.
요청 하나는 ID 하나에만 적용한다. 프로젝트 전체 삭제나 중복 일괄 정리는 제공하지 않는다.

### 삭제 완료 — HTTP 200

```json
{
  "id": 123,
  "message": "snippet deleted"
}
```

123은 응답 구조 예시이며 삭제 대상이나 측정된 ID가 아니다.
삭제 트랜잭션의 커밋이 확인된 뒤 성공을 반환한다.

- 같은 행의 코드 원문·메타데이터·embedding·처리 상태를 함께 삭제한다.
- 동일한 코드를 가진 다른 ID의 행은 유지한다.
- PC의 원본 파일, 다른 PC의 기록, Git의 실험 산출물은 변경하지 않는다.
- 삭제한 ID는 이후 새 검색·필터 집계에서 제외된다. 다른 중복 행이 있으면 그 행은 계속 검색된다.
- 이미 표시된 검색 결과·AI 답변·로컬 기록은 자동 갱신되지 않는다.
- 이미 처리 중인 검색·AI 질문은 삭제 전 읽은 자료를 포함할 수 있다.

### 없는 ID — HTTP 404

```json
{
  "detail": "Snippet not found"
}
```

이미 삭제된 ID를 다시 요청해도 404다. 두 번째 삭제 성공으로 표시하지 않는다.

### 잘못된 ID — HTTP 422

0·음수·정수로 처리할 수 없는 값·BIGINT 상한 초과는 DB 접근 전에 거부한다.
FastAPI 기본 검증 오류 응답을 사용한다.

### 삭제 확인 실패 — HTTP 503

```json
{
  "detail": "Snippet deletion unavailable"
}
```

DB 연결·삭제 실행·커밋 확인 실패를 성공이나 404로 바꾸지 않는다.
503이나 통신 시간 초과만으로 삭제되지 않았다고 단정하지 않는다.
클라이언트는 성공 표시나 로컬 기록 제거를 확정하지 않고 상태를 다시 확인한다.
서버 응답과 삭제 오류 로그에 DB 연결 문자열·예외 원문을 포함하지 않는다.

### Extension 연결

이 절은 Backend 계약이며 PR #68 자체에 DB 삭제 버튼이 추가됐다는 뜻은 아니다.
삭제 확인창에서 실제 ID·프로젝트·파일을 안내한 뒤 명시적으로 요청한다.
성공 후 검색 결과·GET /filters·관련 로컬 기록·AI 답변 캐시를 갱신한다.
기존의 로컬 기록 ✕와 DB 삭제를 별개의 동작으로 유지한다.
상세 인수인계와 검증 범위는 [스니펫 삭제 안내](docs/SNIPPET_DELETION.md)를 따른다.

## 7. POST /study/{mode} — 공부 AI

사용자가 전달한 코드 한 조각에 대해 공부용 JSON을 생성한다. DB·Embedding·RAG 검색을 수행하지 않는다.
모드는 explain, why, review, task, bug, translate, plain, lines, distractors, narrate다.
narrate는 develop의 Extension llm.ts에 실제로 존재하는 실행 기록 해설 모드다. quiz는 이번 계약에 포함하지 않는다.

### 공통 요청과 키

```json
{"code":"def add(a,b):\n    return a+b","language":"python","function_name":"add"}
```

- code: 공백뿐이 아닌 원문, 1~8,000자·최대 5,000줄. language: 1~40자. function_name: string 또는 null, 생략 가능·최대 200자.
- 추가 입력과 응답 모양은 아래 표를 따른다. JSON 객체로 응답하며 별도 answer 래퍼나 SSE를 추가하지 않는다.
- /ask와 동일하게 X-LLM-API-Key·X-LLM-Provider를 한 쌍으로 받는다. 제공자는 openai·anthropic·google이다.
- 두 헤더가 없으면 기존 Backend의 서버 기본 OpenAI 키·모델을 사용한다. 개인 키 실패 후 서버 키로 자동 전환하지 않는다.
- 모델 설정은 기존 Backend 설정을 따른다. Extension의 chatModel 설정이 이 요청으로 전달되는 것은 아니다.
- 요청마다 최대 1회 생성, 처리 기한 30초, 출력 상한 4,096토큰. 요청·응답을 DB에 저장하지 않는다.
- 프롬프트는 Extension llm.ts의 STUDY_SYSTEM·SHAPES·studyPrompt에 대응한다. 실제 파서와 대조하는 검사를 제공한다.

| mode | 공통 요청 외 추가 필드 | HTTP 200 JSON의 최상위 필드 |
|---|---|---|
| explain | answer: 사용자가 쓴 설명, 1~8,000자 | points: [{verdict: ok/partial/wrong, text, lines}] |
| why | 없음 | alternatives: [{label, code, speed, memory, readability, note}], complexity: {time, space, note}, deeper: [{title, text, doc}] |
| review | 없음 | items: [{kind: good/fix/warn, title, text, lines}], improved_code |
| task | 없음 | task, starter, tests: [{call, expected}] |
| bug | 없음 | code, line, explain, fixed_line |
| translate | target: 바꿀 언어, 1~40자 | language, code, notes: [{from, to, why}] |
| plain | 없음 | one_line, analogy, use |
| lines | 없음 | lines: [{line, plain}] |
| distractors | call: 1~300자, answer: 정답 문자열 1~500자 | choices: 문자열 배열 |
| narrate | call: 최대 300자, steps: 실행 기록 문자열 배열 1~400개·각 2,000자 이하 | summary, steps: 단계별 설명 문자열 배열 |

최종 메시지 JSON은 80,000자 이하로 제한한다. 글자 수 제한을 토큰 측정값으로 표시하지 않는다.
lines는 입력 코드 안의 1부터 시작하는 줄 번호다. bug.line은 생성된 bug.code 안의 줄 번호다.
narrate의 응답 steps 개수는 요청과 같아야 한다. distractors는 정답을 포함하지 않고 서로 다른 보기여야 한다.
응답은 타입·필수 필드·길이·줄 번호를 검사한 뒤 전달한다. 이 검사는 AI 설명이나 과제의 의미적 정답을 보장하지 않는다.

### 오류

| HTTP | detail.code | 의미 |
|---|---|---|
| 401 / 403 | llm_key_invalid / llm_key_forbidden | /ask와 같은 키·권한 오류 |
| 422 | llm_provider_unsupported 또는 study_input_invalid | 제공자·요청 크기 오류. 필드·모드 검증은 FastAPI/Pydantic 기본 detail 배열도 사용 |
| 502 | study_response_invalid | 미완료 응답, 잘못된 JSON·필드·줄 번호·보기 등 |
| 503 | study_service_unavailable | 서버 기본 키·모델·제공자 연결 준비 실패 |
| 504 | study_timeout | 공부 AI 응답 시간 초과 |

오류 detail 객체는 {code, message}다. 키·제공자 예외 원문을 응답에 포함하지 않는다. 개인 키는 요청 종료 시 정리한다.

## 8. POST /study/concepts — 개념 찾기

공통 코드 요청에 known_ids: string[], concept_ids: string[]를 추가한다. 생략 시 []다.
각 목록은 최대 200개, 각 ID는 1~100자다. known_ids는 Extension에서 규칙으로 감지한 개념 ID이고,
concept_ids는 Extension이 알고 있는 전체 ID 목록이다. 모델에 제시하는 목록은 concept_ids와 Backend에 복사한 개념 이름을 사용한다.
concept_ids가 비면 현재 Backend의 개념 목록을 사용한다. 키 헤더·기한·오류는 7절과 같다.

```json
{
  "concepts": [{
    "id":"condition", "name":"조건문", "level":1, "summary":"조건에 따라 실행해요.",
    "in_this_code":"조건을 확인하는 부분에서 쓰여요.", "lines":[1], "prereq":[],
    "misconception":"", "contrast":""
  }]
}
```

위 내용은 구조 예시다. level은 1·2·3, id는 알려진 ID 또는 null이다.
응답 최대 12개, 같은 이름은 한 번만 남기며 알려지지 않은 id는 Extension의 parseAiConcepts처럼 null로 바꾼다.
검출한 개념을 스니펫에 자동 저장하지 않는다. 저장은 선택 concepts 필드로 별도 요청한다.

## 9. POST /study/trace · POST /study/run — 격리 실행

LLM·DB를 호출하지 않는다. 기존 서버 환경에서 실행기를 명시적으로 활성화한 경우에만 실행한다.
이미지가 없거나 Docker에 접근할 수 없으면 503이며 호스트 Python/Node 실행으로 대체하지 않는다.

### 요청

- trace: 공통 코드 요청 + call 문자열(1~300자).
- run: 공통 코드 요청 + calls: 식 문자열 배열, tests: [{call, expected}]. 각각 최대 20개이며 둘 중 하나는 비어 있지 않아야 한다.
- calls가 있으면 calls를 우선하고, 없으면 tests를 사용한다. expected는 Python repr 또는 JavaScript JSON.stringify 결과 문자열이다.
- 지원 언어는 python·typescript·javascript다. TypeScript는 타입 제거 후 동기 함수 위주로 실행하며 타입 검사를 수행하지 않는다.
- import가 필요한 TS 모듈, JSX, strip-only 변환이 지원하지 않는 TS 구문은 실행 실패로 처리한다.

### 실행 환경

요청마다 별도 컨테이너, 최대 5초·관측 단계 400개, 메모리 256MiB·CPU 1개·PID 32개 제한을 적용한다.
네트워크 없음, 읽기 전용 파일 시스템, 비 root 사용자, 모든 capability 제거, 권한 상승 금지,
호스트 폴더·DB·API 키·Docker socket 미전달을 적용한다. 임시 쓰기 영역은 16MiB다.
실행 시간 초과 후 컨테이너 정리는 추가 시간이 필요할 수 있다. 요청당 stdout 4MB·stderr 64KB 수신 한도를 둔다.
실행 슬롯은 Backend 프로세스당 2개다. 실행기의 이미지 준비와 활성화 방법은 [공부 Backend 안내](docs/STUDY_BACKEND.md)를 따른다.

### HTTP 200 응답

trace는 Extension follow.ts TRACER·study.ts의 TraceResult 형식이다.

```json
{"call":"add(1,2)","steps":[{"line":2,"say":"a = 1, b = 2","frames":[{"name":"add","vars":{"a":"1","b":"2"}}],"objects":[],"ret":""}],"truncated":false,"value":"3","stdout":""}
```

steps는 최대 400개다. 각 단계에 line, say, frames[{name,vars}], objects[{label,items,look,marks}], ret가 있으며
TS/JS 단계는 col을 추가할 수 있다. 기록은 해당 줄 실행 직전의 값이다. 반환 이벤트는 반환 시점을 기록한다.
실행 중 예외는 trace의 마지막 단계나 run의 case.error로 표시한다. 단계 한도에 도달한 trace는 truncated=true다.
run은 다음과 같다.

```json
{"cases":[{"call":"add(1,2)","output":"3","error":"","expected":"3","ok":true}]}
```

expected가 없는 경우 ok는 null이다. 비교 방식은 기존 TRACER와 같이 공백을 제거한 표현 문자열 비교다.
이 채점을 일반적인 프로그램 동치 검사로 취급하지 않는다. 위 JSON은 응답 구조 예시이며 새 측정값이 아니다.

### 오류

- 422 study_execution_input_invalid: 지원하지 않는 언어 또는 빈 호출 목록.
- 422 study_execution_failed: 코드 로드·구문·결과 형식·출력 한도 등 실행 입력 문제.
- 503 study_runner_unavailable: 비활성 실행기·이미지/Docker 미준비·실행 슬롯 부족·검증 불가능한 실행 결과.
- 504 study_execution_timeout: 5초 제한으로 실행 중단.

필드 타입·길이 오류는 기본 422 검증 응답을 사용한다. Docker stderr·서버 연결 정보·키를 응답에 포함하지 않는다.
