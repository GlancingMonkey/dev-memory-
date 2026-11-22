# Extension 사용자 AI 키 연결

Extension PR #53의 키 설정과 Backend POST /ask를 연결한다.
요청·응답 기준은 [API 계약](../API_CONTRACT.md)이다.
사용자의 키 자체를 팀원에게 공유할 필요는 없다.

## 연결 범위

- 서버 기본 키: 헤더 없이 요청하면 기존 OPENAI_API_KEY와 GPT-6.1 Sol을 사용한다.
- 내 키: X-LLM-API-Key와 X-LLM-Provider를 함께 보내면 openai·anthropic·google 중 해당 제공자로 처리한다.
- 같은 키·모델로 참고 자료 계수, 전체 입력 계수, 생성을 수행한다.
- 제공자 키를 DB·환경변수·파일·전역 캐시에 넣지 않는다. 서버 기본 키를 덮어쓰지 않는다.
- 응답 완료·오류·스트림 연결 종료 시 요청 전용 클라이언트를 닫는다.
- 키 오류 후 서버 키로 자동 재전송하지 않는다. 제공자 SDK와 HTTP 호출의 자동 재시도도 사용하지 않는다.
- 저장·검색·필터 목록의 기존 API·DB 구조는 유지한다.

## Backend 실행

Dev Container Bash의 저장소 루트에서 실행한다.

```bash
uv sync --locked
uv run --locked python -m unittest discover -s tests -p 'test_*.py' -v
uv run --locked uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

uv sync는 잠금 파일의 의존성을 준비하고, unittest는 유료 호출 없는 자동 검사를 실행한다.
서버가 준비되면 같은 PC에서 /health·/filters·기존 일반 검색부터 확인한다.
DB 연결은 기존 DATABASE_URL을 사용한다. 이번 변경에서 schema·migration을 추가하지 않았다.

서버 기본 키는 무시된 .env의 OPENAI_API_KEY를 사용한다.
개인 Claude/Gemini 키는 확장 SecretStorage에서 읽어 요청 헤더로만 보낸다.
서버 .env에서 모델 이름을 설정할 수 있다. 실제 키를 이 예시에 넣지 않는다.

```dotenv
ANTHROPIC_MODEL=claude-haiku-5-5
GEMINI_MODEL=gemini-3.1-flash-lite
```

미지정 시에도 위 초기 모델을 사용한다. 모델 사용 권한은 각 사용자의 계정에서 확인한다.
두 추가 모델은 연결을 위한 초기 선택이며 기존 GPT/E5 평가를 대체한 품질 비교 결과가 아니다.

## Extension 담당자와 확인할 순서

1. PR #53 코드와 대응 Backend 코드를 같은 환경에서 준비한다.
2. 실제 서버 모드·같은 PC localhost 또는 확인한 HTTPS 주소를 설정한다. 키는 채팅·Git·출력 로그에 붙여넣지 않는다.
3. AI 키 화면에서 제공자와 자신의 키를 등록하고 내 키 모드를 선택한다.
4. 현재 원본 파일에서 새로 저장해 ready가 된 코드에 대해 질문한다.
5. 정상 답변·모델명·실제 usage와 출처 ID·원문을 대조한다. 본문 인용·원본 열기도 확인한다.
6. 별도로 자신이 관리하는 폐기된/시험용 잘못된 키를 선택하면 키 오류 안내가 나오는지 확인한다. 같은 요청이 자동 재전송되지 않아야 한다.
7. 서버 기본 키 모드로 명시적으로 바꾸고 기존 GPT 흐름을 확인한다.
8. 제공자 변경·후속 질문·취소·서버 오류를 확인한다. 다른 제공자의 수치를 이전 GPT 비교 결과에 섞지 않는다.

키를 직접 표시하는 curl 명령이나 키 값이 들어간 화면·로그를 검증 자료로 공유하지 않는다.
모델·사용량·상태·HTTP/SSE 오류 코드와 키를 제거한 결과만 기록한다.

## 응답과 오류

JSON 성공과 SSE done의 status·answer·sources·model·usage·history_used는 기존 형식을 유지한다.
OpenAI는 기존 제공자 스트리밍을 유지한다.
Claude·Gemini는 현재 JSON 생성을 한 번 완료한 뒤 SSE의 한 delta와 done으로 전달한다.
SSE 인터페이스 지원과 두 제공자의 토큰 단위 스트리밍은 구분한다.

| 결과 | 의미와 확인 |
|---|---|
| 401 / llm_key_invalid | 헤더 짝·키 입력 또는 제공자 인증 확인 |
| 403 / llm_key_forbidden | 제공자의 해당 모델·계정 권한 확인 |
| 422 / llm_provider_unsupported | openai·anthropic·google 중 선택 |
| 503 / ask_service_unavailable | E5·DB·설정·제공자 연결·할당량/잔액 등 서버 로그 확인 |
| 504 / ask_timeout | 처리 시간 초과. 자동 재전송 없음 |
| 502 / llm_response_invalid | 출력 미완료·잘못된 구조·사용량·출처 검증 실패 |

스트림이 이미 시작된 뒤 인증 오류가 나면 HTTP 200 안의 error 이벤트에서 status=401/403과 code를 전달한다.
Extension은 done 없이 종료된 응답을 성공으로 표시하지 않는다.
검색 대상이 없으면 제공자를 호출하지 않는다. 이때 근거 부족 응답은 키 유효성 검증 결과가 아니다.

## 계수·usage와 검증 범위

OpenAI는 기존 입력 계수 API·실제 usage 경로를 유지한다.
Claude는 messages/count_tokens, Gemini는 전체 generateContentRequest를 countTokens에 전달한다.
최종 입력 계수에는 시스템 지시문·메시지·참고 자료·스키마를 포함하며 문자 수로 대체하지 않는다.
Claude 계수는 제공자가 설명하는 추정치이며 실제 usage와 항상 같다고 가정하지 않는다.
Claude의 cache 생성·읽기는 입력 합계에, Gemini의 thoughtsTokenCount는 출력 합계에 포함한다.
필수 usage·완료 상태·실제 응답 모델명이 없으면 성공 수치를 만들지 않는다.

자동 검사는 합성 시험 키와 모의 HTTP/SDK 응답으로 키 격리·요청별 정리·인증 오류·payload·usage·기존 회귀를 확인한다.
자동 검사 통과가 실제 Claude/Gemini 계정의 키·모델 접근이나 Windows 화면까지 검증했다는 뜻은 아니다.
실제 제공자별 확인 결과는 실행한 항목만 별도로 기록한다. 기존 11/16 비교 산출물은 수정하지 않는다.

## 담당자 인수인계

- Backend @wanghaiwen05-ui: request_llm.py의 헤더 선택·요청 클라이언트·제공자 변환과 llm.py의 안전한 인증 오류를 확인한다. RAG 담당자가 구현을 지원한다.
- Extension @applecider2: 두 헤더 이름·세 제공자 ID·401/403 및 SSE error 처리, 서버 기본 키로 수동 전환을 확인한다.
- Database @JeongSeungwan: 기존 DB·출처 원문 대조를 지원한다. API 키를 스니펫이나 별도 테이블에 저장하지 않는다.

English: Keep the Backend ownership unchanged. Personal keys apply only to one /ask request, including token counting. Never fall back to the server key after an auth failure. Claude/Gemini currently return a buffered answer through the existing SSE format. Verify real provider access separately from mocked tests.

## 공식 구현 근거

- [OpenAI 입력 계수](https://developers.openai.com/api/docs/guides/token-counting)
- [Claude Messages](https://platform.claude.com/docs/en/api/messages/create) · [계수](https://platform.claude.com/docs/en/api/messages/count_tokens) · [구조화 출력](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Claude 모델 ID](https://platform.claude.com/docs/en/models/overview)
- [Gemini 공식 REST 스키마](https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta) · [생성·usage](https://aistudio.google.com/api-reference/generate-content) · [모델 ID](https://aistudio.google.com/docs/models)
