# 2026-11-18 사용자 AI 키 계약 검증

## 기준과 범위

- Backend 기준: develop ccbf3cd74e6a4c6dbb257a9445de3acbf0fec287에 이번 feature/backend 변경을 적용했다.
- Extension 기준: PR #53, ac4d630bcebd4349d74373c6060d54f652d7ea88.
- 별도 임시 작업 공간에서 두 변경을 합쳤고 충돌이 없었다. Extension 담당 브랜치의 파일은 수정하지 않았다.
- 아래는 자동·계약 검증이다. 제공자 응답은 모의 처리했고 실제 사용자 키로 생성하거나 과금하지 않았다.
- 기존 E5·GPT 평가 결과와 DB·스키마·migration을 변경하지 않았다.

## 실제 실행 결과

| 검사 | 결과 |
|---|---|
| Python 전체 자동 검사 | 103개 통과 |
| PR #53과 합친 코드의 Python 검사 | 103개 통과 |
| PR #53 Extension 단위 검사 | 68개 통과 |
| TypeScript·ESLint·번들 빌드 | 통과 |
| uv lock --check --offline | 통과, 기존 패키지 버전 변경 없음 |
| git diff --check | 통과 |
| 변경 파일 비밀값 검사 | 로컬 키의 일치 값·실제 OpenAI 키 형태 발견 없음. 키 자체는 출력하지 않음 |
| 새 Backend 응답과 PR #53 실제 파서 대조 | 9건 통과 |

9건은 OpenAI·Claude·Gemini 각 JSON/SSE 성공 응답 6건, HTTP 401/403 2건, SSE 인증 실패 1건이다.
Backend TestClient와 모의 제공자로 응답을 만든 뒤 PR #53의 컴파일된 logic.ts 함수를 사용했다.
두 헤더 상수·세 제공자 ID, 최종 출처 ID·usage, delta 결합과 done 답변의 일치,
HTTP/SSE 인증 실패의 key 오류 분류와 실패 뒤 done 없음이 일치했다.
시험용 usage 숫자는 합성 응답이며 실제 제공자 측정 결과가 아니다.

## 자동 검사에서 확인한 것

- 사용자 키의 요청 간 격리, 서버 기본 키/클라이언트 보존, 동시 요청의 키 분리.
- 참고 자료 계수·최종 입력 계수·생성에서 같은 사용자 클라이언트 사용.
- 제공자별 공식 payload·개발자 지시문 변환·스키마·사용량·실제 응답 모델 필드 처리.
- Claude 입력 cache 생성/읽기와 Gemini 추론 토큰의 usage 포함.
- 잘못된 헤더·중복 헤더·미지원 제공자의 안전한 오류와 키 값 비노출.
- OpenAI/Claude/Gemini 인증 오류, Gemini API_KEY_INVALID, 시간 초과·할당량 장애 구분과 재전송 없음.
- 미완료·잘못된 사용량·잘못된 구조의 실패 처리, 기존 인용 검증·JSON/SSE·저장/검색 회귀.
- JSON 완료/실패·SSE 완료/실패·클라이언트 연결 종료 때 개인 클라이언트 정리.
- 요청 전용 OpenAI 클라이언트의 고정 공식 주소·리디렉션 차단·재시도 0 설정.

## 실제 계정·화면 확인으로 남은 것

- 각 제공자의 본인 키로 계수·생성하고 해당 계정의 초기 모델 접근을 확인한다.
- Extension PR #53의 내 키/서버 기본 키 선택, 키 오류 안내와 수동 전환을 실제 개발 호스트에서 확인한다.
- 실제 답변·usage·DB 출처·본문 인용·원본 이동·후속 질문·취소/복구를 대조한다.
- Claude·Gemini는 현재 생성 완료 후 한 delta와 done을 보낸다. 토큰 단위 제공자 스트리밍으로 표시하지 않는다.
- 이 결과는 GitHub CI 실행·독립 리뷰·모델 품질 비교 또는 Windows UI 완료가 아니다.

[실행·인수인계](PERSONAL_LLM_KEYS.md) · [API 계약](../API_CONTRACT.md) · [키 클라이언트 검사](../tests/test_request_llm.py) · [API 검사](../tests/test_personal_key_api.py)
