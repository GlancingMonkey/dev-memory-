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

POST /snippets는 스니펫 저장만 수행한다.
저장 직후 자동 Embedding 생성과 실패 재처리는 후속 단계다.
검색은 아래 API 계약에 따라 사전에 벡터가 준비된 스니펫을 조회한다.

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