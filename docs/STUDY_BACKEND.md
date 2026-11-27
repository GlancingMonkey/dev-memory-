# 공부 기능 Backend 연결

기준: develop `ac30c7a`의 Extension `llm.ts`, `study.ts`, `follow.ts`, `web/jstrace.js`.
공식 요청·응답은 [API 계약 7~9절](../API_CONTRACT.md#7-post-studymode--공부-ai)을 따른다.
이번 작업은 Backend·계약·검증 코드다. Extension·DB migration·RAG 모듈은 변경하지 않는다.

## AI 기능

`POST /study/{mode}`는 코드 한 조각에서 공부용 JSON을 생성한다.
explain·why·review·task·bug·translate·plain·lines·distractors와 최신 Extension의 narrate를 지원한다.
`POST /study/concepts`는 알려진 개념 ID 목록을 참고해 개념 JSON을 반환한다.
DB 조회나 코드 실행 없이 기존 RequestLLM의 제공자 연결을 재사용한다.

X-LLM-API-Key·X-LLM-Provider가 있으면 그 요청의 개인 키를 사용하고 종료 시 정리한다.
없으면 기존 OPENAI_API_KEY와 Backend 모델 설정을 사용한다. 실제 .env는 수정·게시하지 않는다.
개인 키 실패 시 서버 키로 자동 재시도하지 않는다. 기존 /ask의 처리와 분리해 공부용 JSON 스키마를 사용한다.
외부 API에 보낼 스키마에서는 제공자 공통 지원 형식만 사용하고 길이·줄 번호·개수 제한은 Backend에서 최종 검증한다.
요청당 생성 1회·기한 30초다. 이 응답에는 RAG 출처·토큰 사용량 래퍼를 추가하지 않는다.

Backend 프롬프트 자산은 Extension 원본에서 추출했으며 교차 검사가 변경 차이를 발견한다.
Backend의 `study_prompts.json`은 실행 시 Extension 파일이나 VS Code가 없어도 사용할 수 있다.
모드 설명·응답 세부 필드와 입력 한도는 API 계약을 따른다.

## 격리 실행 준비

Dev Container의 저장소 루트에서 Backend용 이미지 하나를 준비한다.

```bash
docker build -t code-memory-study-runner:local backend/runner
```

이미지는 고정된 Node 24 이미지, Python 3.11, acorn 8.15.0과 Backend 실행 코드만 포함한다.
빌드 컨텍스트는 backend/runner뿐이며 .env·프로젝트 소스·DB·사용자 파일을 넣지 않는다.
Backend에 신뢰하는 Docker daemon과 Docker CLI 접근이 필요하다. 기존 Dev Container의 Docker 접근 설정을 재사용한다.

로컬 .env에서 아래 두 설정을 적용하고 Backend를 재시작한다.

```dotenv
STUDY_RUNNER_ENABLED=true
STUDY_RUNNER_IMAGE=code-memory-study-runner:local
```

```bash
uv run --locked uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

기본값은 비활성이다. AI 기능·기존 저장·검색은 실행기 없이도 사용할 수 있다.
trace·run은 요청마다 네트워크·호스트 마운트 없는 비 root 컨테이너에서 실행하고 종료 후 제거한다.
최대 5초, 단계 400개, 메모리 256MiB, CPU 1개, PID 32개, stdout 4MB·stderr 64KB 수신 제한을 둔다.
호스트 실행 대체 경로는 없다. 이미지 다운로드를 요청 안에서 자동 실행하지 않는다.
이는 기존 로컬 MVP 구성의 실행 기능이며 공개 다중 사용자 서버의 인증·운영 구성을 추가한 것은 아니다.

Python 출력 형식은 follow.ts TRACER에 대응한다. TS/JS 기록 장치는 web/jstrace.js를 Backend 쪽으로 복사해 사용했다.
TypeScript는 타입을 제거하고 실행하므로 타입 검사·모듈/JSX 전체 지원을 뜻하지 않는다.
run의 expected는 기존 표현 문자열 비교 방식을 유지한다. 일반적인 함수 동치 검증이 아니다.

## 개념 필터: DB 담당자 인수인계

DB 담당자가 실제 컬럼과 migration을 추가한다. Backend가 기대하는 계약은 다음과 같다.

| 항목 | Backend 기대값 |
|---|---|
| 테이블·컬럼 | public.snippets.concepts |
| 타입 | TEXT[] |
| 값 | 개념 ID의 문자열 배열. 미지정·기존 행은 빈 배열 또는 NULL |
| 기본값 | 빈 배열 권장. NOT NULL 여부와 기존 행 처리 방식은 DB 담당자가 확정 |
| 검색 | `%s = ANY(concepts)`로 정확한 ID를 찾고 다른 조건과 AND 결합 |

Backend는 실제 DB·init.sql·migration을 변경하지 않았다. 필요 인덱스도 DB 담당 영역이다.
개념 생략·null 저장과 개념 없는 검색은 컬럼을 참조하지 않으므로 기존 DB에서도 동작한다.
개념을 지정한 저장·검색은 컬럼 준비 전 503이므로 조건이 적용된 것처럼 표시하지 않는다.
기존 행에 개념을 자동 추정해 채우지 않는다. DB 타입이 TEXT[]와 다르게 정해지면 통합 전에 Backend 조건도 맞춘다.

Extension 담당자는 선택 concepts 저장과 GET /search의 concept 조건을 연결한다.
검색 응답 filters에 실제 적용 concept를 반환하며, 미지정 시 기존 project·language 모양을 유지한다.
GET /filters와 /ask의 범위·결과는 이번 개념 필터로 바꾸지 않는다.

## 검사 순서

```bash
uv run --locked python -m unittest discover -s tests -p 'test_*.py' -v
node tests/check_study_extension_contract.mjs
```

단위 검사는 모델·DB를 모의 처리하고 합성 시험 키만 사용한다.
Node 검사는 실제 Extension studyPrompt·parseStudyResult·parseAiConcepts를 읽어 프롬프트와 응답을 대조한다.
Extension node_modules나 소스 파일을 변경하지 않는다. Node 24와 uv를 사용한다.

이미지를 준비한 뒤 실제 격리 실행을 확인한다.

```bash
uv run --locked python - --apply < tests/manual_study_runner_check.py
```

Python·TS·JS 실행, 5초·400단계, 예외·구문 오류, 네트워크·호스트 파일·API 키 차단, 출력 한도를 검사한다.
현재 DB와 LLM을 사용하지 않으며 시험용 컨테이너만 생성·제거한다.

개념 DB 계약을 격리한 PostgreSQL DB에서 확인한다.

```bash
uv run --locked python - --apply < tests/manual_study_concept_check.py
```

새 UUID 이름의 DB에서만 TEXT[] 시험 컬럼을 만들고 저장·조건 검색을 검사한 뒤 제거한다.
현재 DB는 전후 읽기 전용 스냅샷으로 보존을 대조한다. 이 fixture는 DB 담당자의 migration을 대신하지 않는다.
실제 키로 공부 AI를 호출하는 것은 별도 연결 검증이다. 자동·격리 검사 통과를 실제 제공자 성공으로 기록하지 않는다.

## 2026-11-27 확인 기록

| 검사 | 결과 |
|---|---|
| Backend·RAG 전체 단위 검사 | 139개 통과. DB·모델·개인 키는 모의 처리 |
| 실제 Extension 함수 대조 | AI 11개 모드의 프롬프트·응답 파서 호환 확인 |
| 실제 Docker 실행 | Python·TS·JS trace/run과 제한·차단·오류 포함 17개 검사 통과 |
| 실행 응답의 실제 Extension 파서 대조 | 정상 HTTP 응답 14개 모두 허용 |
| 개념 PostgreSQL 연결 | 새 시험 DB에서 7개 필드 저장, 개념 저장, WHERE 선적용, 프로젝트·언어 결합, SQL 형태 입력 확인 |
| 사용자 DB | 전후 전체 스냅샷·행 수 동일. 개념 컬럼/migration 미적용 |
| 실행기·시험 DB 정리 | 생성한 컨테이너와 임시 DB 제거 확인. 준비한 runner 이미지는 로컬에 유지 |

실행기의 Python은 3.11, Node는 24 계열이다. API·프롬프트·실행 시험에서 실제 공부 LLM 호출과 과금은 발생하지 않았다.
실제 키의 공부 AI 결과·모델 접근 권한과 Windows 공부 화면 조작은 이번에 확인하지 않았다.
`E5 warmup: OK`가 단위/DB 검사에 출력된 것은 startup을 모의 처리한 결과이며 새 임베딩 측정값이 아니다.

## 공식 구현 근거

- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)
- [Claude 구조화 응답과 스키마 제약](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Docker run 자원·격리 옵션](https://docs.docker.com/reference/cli/docker/container/run/)
