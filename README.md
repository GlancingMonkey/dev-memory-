# dev-memory-

VS Code에서 선택한 코드와 메타데이터를 PostgreSQL에 저장하고, 자연어로 관련 코드를 찾는 개인 개발 지식 검색 시스템이다. 4인 컴퓨터공학 캡스톤 프로젝트로 개발하고 있다.

## 현재 구현 범위

| 기능 | 현재 상태 |
|---|---|
| 코드·메타데이터 7개 필드 저장 | Extension → FastAPI → 실제 DB 저장과 생성 id 반환 확인 |
| 코드·질문 Embedding | E5 기반 CPU 모듈, 정규화된 768차원 벡터 |
| Semantic Search | 벡터가 준비된 행을 pgvector 코사인 거리로 검색 |
| VS Code 검색 UI | 실제 API 결과, 점수, 원본 열기, 복사·삽입 확인 |
| 새 저장 코드의 자동 Embedding·실패 재처리 | 후속 작업 |
| 프로젝트·언어 검색 필터 | 후속 작업 |
| RAG / Ask AI / Token Budget 최적화 | 후속 작업 |

**현재 검색은 LLM을 호출하지 않는다.** 저장 직후 자동으로 벡터가 생기지는 않으며, 검색하려는 코드에 먼저 수동으로 Embedding을 준비해야 한다.

## 현재 처리 흐름

```text
저장: VS Code 코드 선택 → POST /snippets → PostgreSQL → 실제 id 반환
벡터 준비: 저장된 code → 수동 E5 Embedding → 같은 행의 embedding에 저장
검색: 자연어 질문 → GET /search → E5 질문 벡터 → DB Top-K → VS Code 결과 목록
```

스니펫의 원문·메타데이터·벡터는 각 개발 환경의 DB에 저장된다. 저장소를 내려받는 것만으로 다른 PC의 테스트 데이터나 원본 파일이 생성되지는 않는다.

## 실행과 개발 문서

- [개발환경·DB·Backend·수동 Embedding 실행 가이드](docs/DEVELOPMENT.md)
- [Extension 빌드와 사용 방법](extension/README.md)
- [공식 API 계약](API_CONTRACT.md)
- [역할 분담과 Git 작업 규칙](PROJECT_GUIDE.md)
- [2026-10-28 통합 검증 기록](docs/INTEGRATION_TEST_2026-10-28.md)

DB와 로컬 환경 변수 준비가 끝난 뒤, **Dev Container의 저장소 루트**에서 Backend를 실행한다.

```bash
uv run --locked uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

Windows 브라우저에서 [health](http://127.0.0.1:8000/health)와 [Swagger](http://127.0.0.1:8000/docs)를 확인한다. 포트 전달 주소가 다르면 VS Code 포트 탭에 표시된 주소를 사용한다.

## 구조와 역할

| 영역 | 위치 | 담당 내용 |
|---|---|---|
| Extension | `extension/` | 선택 코드 수집, 저장 요청, 검색 UI, 원본 이동 |
| Backend | `backend/` | 요청 검증, DB·Embedding 모듈 연결, JSON 응답 |
| Database | `database/` | snippets, pgvector 컬럼, 기존 DB 적용 SQL |
| RAG | `rag/` | Embedding, 검색 품질, 후속 RAG·Context 최적화 |

## Embedding 선택과 실험 기록

현재 연결 모델은 `intfloat/multilingual-e5-base`이며, 입력 규칙과 revision은 [실행 가이드](docs/DEVELOPMENT.md)에 정리했다.

- [기존 세 모델 비교 실험](rag/experiments/embedding_compare/README.md)
- [기존 비교 결과와 선정 근거](rag/experiments/embedding_compare/comparison_results.md)

기존 CPU·10개 질문에서는 E5와 Qwen이 10/10 Hit@1, BGE가 9/10이었다. E5는 해당 조건의 정확도·속도·차원 균형을 근거로 채택했다. 이 결과와 통합 검증의 세 질문은 작은 샘플의 기록이며 전체 검색 품질로 일반화하지 않는다. 기존 실험 산출물은 보존한다.

## 협업

개발 통합 브랜치는 `develop`, 발표·안정 버전은 `main`이다. 담당 브랜치에서 작업하고 **PR base를 develop**으로 설정한다. 실제 API 필드와 응답은 [API_CONTRACT.md](API_CONTRACT.md)를 기준으로 한다.
