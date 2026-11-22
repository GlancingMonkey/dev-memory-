# 릴리스 노트

## 2026-11-22 · main 통합 버전

저장 → 검색 → AI 질문 → 출처 확인 흐름을 검증한 develop을 main에 통합했습니다. [통합 PR #63](https://github.com/GlancingMonkey/dev-memory-/pull/63)

### 사용할 수 있는 기능

- VS Code에서 선택한 코드·메타데이터 저장, E5 자동 임베딩과 검색 준비 상태 안내
- 자연어 의미 검색, 프로젝트·언어 조건, 검색 가능한 코드의 필터 목록
- 검색한 코드를 근거로 하는 AI 답변, 출처 이동, 이어서 묻기
- OpenAI·Claude·Gemini 개인 키 선택과 VS Code SecretStorage 보관
- 원본 프로젝트 위치 기억·첫 위치 연결, 원본 변경·줄 이동 확인
- 코드 복사·삽입·비교, 오류·시간 초과·취소 안내와 검색 복구
- Context 중복 제거·토큰 예산, 기존 ID의 실패 임베딩 재처리

### 확인 자료

통합 전 Python 103개·Extension 87개 검사와 TypeScript·ESLint가 통과했습니다. 실제 API·DB·Windows 화면 확인과 모의 UI 시험은 [검증 기록](docs/README.md#확인한-결과를-찾을-때)에서 구분합니다. 제공자별 확인 범위와 내부 평가의 한계도 해당 기록을 따릅니다.

### 사용 형태

소스에서 빌드하는 로컬 개발 구성입니다. 이 기록은 Marketplace 게시나 버전 태그 발행을 뜻하지 않습니다. [시작하기](docs/DEVELOPMENT.md) · [Extension 안내](extension/README.md)

## 변경을 반영하는 흐름

담당 feature 브랜치 → develop에서 통합·검증 → main으로 반영합니다. 상세 변경은 [Pull requests](https://github.com/GlancingMonkey/dev-memory-/pulls?q=is%3Apr+is%3Amerged), 다음 범위는 [개발 계획](docs/ROADMAP.md)을 확인하세요.
