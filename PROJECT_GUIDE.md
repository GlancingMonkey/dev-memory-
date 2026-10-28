# Project Guide

## 1. 프로젝트 목표

VS Code에서 코드 스니펫을 저장하고 자연어로 검색하는 개인 개발 지식 검색 시스템이다. 후속 단계에서는 필요한 경우에만 RAG로 LLM 답변을 생성하고 Context Token Budget을 최적화한다.

현재 완료 범위는 [README](README.md), 실제 연결 계약은 [API_CONTRACT.md](API_CONTRACT.md), 실행 순서는 [개발 가이드](docs/DEVELOPMENT.md)를 따른다.

## 2. 역할 분담

| 영역 | 담당 |
|---|---|
| Extension | VS Code UI, 코드·메타데이터 수집, 저장·검색 요청, 결과 표시, 원본 열기 |
| Backend | FastAPI 요청 검증·응답, Extension ↔ DB·RAG 모듈 연결 |
| Database | PostgreSQL·pgvector, snippets 스키마, 저장·조회, DB 적용 SQL |
| RAG | 질문·코드 Embedding, 검색 품질·Top-K, 후속 RAG·Context 최적화 |

공통 규칙을 함께 정하고 담당 영역에서 구현한 뒤 develop에서 통합한다. 다른 담당자의 코드를 수정할 때는 실제 파일과 변경 범위를 먼저 확인한다.

## 3. 폴더 역할

- `extension/`: TypeScript VS Code Extension
- `backend/`: FastAPI와 DB 연결
- `rag/`: Embedding 모듈과 기존 모델 비교 산출물
- `database/`: 새 DB 초기화와 기존 DB migration
- `tests/`: 공통 테스트
- `docs/`: 실행 가이드와 통합 검증 기록

## 4. Git 브랜치 규칙

- `main`: 발표·안정 버전
- `develop`: 통합 브랜치
- `feature/extension`, `feature/backend`, `feature/database`, `feature/rag`: 담당 영역 개발
- `codex/*`: 별도로 분리한 보조 작업

```text
담당 브랜치 → commit → push → PR(base: develop) → develop 통합 확인
```

main 반영은 안정화 후 별도로 진행한다. 기존 담당 브랜치는 다음 개발에 계속 사용한다.

## 5. 작업 시작 순서

저장소 루트에서 먼저 확인한다.

```bash
git status
git branch --show-current
git fetch origin
```

미커밋 변경과 진행 중인 merge가 있는지 확인한 뒤 브랜치를 이동한다. 미커밋 작업은 보존하고 내용부터 확인한다.

예를 들어 RAG 담당자가 기존 feature/rag에서 작업한다면:

```bash
git switch feature/rag
git pull --ff-only origin feature/rag
git merge --no-edit origin/develop
git status
```

자기 담당 브랜치 이름으로 바꿔 실행한다. 명령이 실패하거나 CONFLICT가 표시되면 다음 명령을 진행하기 전에 원인과 해당 파일을 확인한다.

작업 후에는 변경한 파일을 확인해 필요한 파일만 add하고 commit·push한다. PR 생성 화면에서 base가 develop인지 확인한다.

## 6. 공통 구현 원칙

- API 이름·필드·nullable 규칙은 API_CONTRACT.md를 우선한다.
- 기존 파일과 함수의 내용을 확인한 뒤 수정한다.
- 작은 기능을 구현하고 실제 실행 결과를 확인한 뒤 다음 단계로 이동한다.
- 저장과 검색의 동작을 구분한다. 현재 신규 저장 후 자동 Embedding은 후속 작업이다.
- .env, 실제 API key·token·비밀번호는 Git에 올리지 않는다. .env.example에는 자리표시자만 둔다.
- 기존 데이터와 모델 비교 산출물을 보존한다.
- 확인하지 않은 실행 결과·성능·파일 존재 여부를 완료 기록으로 쓰지 않는다.

## 7. 문서 기준

- 공통 규칙: 이 파일과 API_CONTRACT.md
- 실행·오류 확인: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- Extension 사용: [extension/README.md](extension/README.md)
- 확인한 SHA·환경·테스트 결과: 날짜가 있는 통합 검증 문서

모델·스키마·API를 변경하면 관련 문서도 함께 갱신한다. 실험 당시의 원본 결과는 현재 구현 설명과 구분해 보존한다.
