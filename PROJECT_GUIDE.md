# Project Guide

## 1. 프로젝트 목표

VS Code에서 필요한 코드 스니펫을 저장하고,
여러 프로젝트에 걸쳐 자연어로 검색할 수 있는
개인 개발 코드 검색 시스템을 구현한다.

주요 기술:
- VS Code Extension
- FastAPI
- PostgreSQL
- pgvector
- Embedding
- Semantic Search
- RAG

---

## 2. 역할 분담

### Extension
- VS Code UI
- 코드 선택
- Save Snippet
- 검색창
- 검색 결과 표시
- 원본 파일 이동

### Backend
- FastAPI
- API 요청/응답
- Extension과 DB/RAG 연결

### RAG
- Embedding
- Semantic Search
- Top-K
- RAG
- Token Budget Context Optimization

### Database
- PostgreSQL
- pgvector
- snippets schema
- 데이터 저장/조회

---

## 3. 폴더 역할

- `extension/` : VS Code Extension
- `backend/` : FastAPI Backend
- `rag/` : Embedding / Semantic Search / RAG
- `database/` : PostgreSQL / pgvector
- `tests/` : 테스트
- `docs/` : 문서

---

## 4. Git 브랜치 규칙

- `main` : 발표/안정 버전
- `develop` : 통합 브랜치
- `feature/extension`
- `feature/backend`
- `feature/rag`
- `feature/database`

개발 흐름:

feature 브랜치
→ commit
→ push
→ Pull Request
→ develop
→ 통합 테스트

---

## 5. 작업 시작 순서

```bash
git status
git switch develop
git pull origin develop
git switch feature/자기역할
git merge develop