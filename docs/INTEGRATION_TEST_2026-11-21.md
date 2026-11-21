# 2026-11-21 잔여 검증과 원본 이동 개선

## 검증 기준

- 기준 develop: `36e563fcfba27e4fbefbf0eb3e3fa6e666b0bf19`.
- 실제 DB: `capstone_eval_1118 / public.snippets`, 기존 21행.
- 일반 검색·필터·파일 위치를 확인했다. 이번 검증에서 유료 LLM 호출이나 기존 품질 실험 재실행은 하지 않았다.
- 검증 중 발견한 프로젝트 재열기 불편은 `codex/remember-local-projects`에서 Extension만 수정했다. 아래 실제 화면 결과와 구현 중인 변경을 구분한다.
- 기존 사용자 작업 `eval/questions-example.json`은 수정하지 않았다.

## 실제 API·DB 확인

읽기 전용 DB 조회와 실제 HTTP GET으로 확인했다.

- 21행 모두 ready, 768차원·유한 값·정규화 벡터.
- `/filters`의 프로젝트·언어별 개수와 유효 벡터 행 집계 일치.
- 검색 조건 11개: 무필터, 프로젝트 단독, Python/TypeScript 단독, AND 조합, 다른 프로젝트, 없는 프로젝트/조합, 공백·대소문자 정규화, 전체 해제.
- 필터가 가리키는 전체 후보 집합, 반환 ID·7개 저장 필드, score 범위·정렬을 대조했다. 입력 오류 4개는 422였다.
- 원본 위치 확인 뒤에도 DB 전체 행의 원문·메타데이터·벡터·처리 상태·시각을 포함한 SHA256이 동일했다: `195f92538558335c370e1560bd5b97be3bd4ed55d7d6f7f16913fd07c3e123bc`.

로컬 원본: `out/reports/2026-11-21-verification/api-db-readonly.json`.

## Windows의 실제 필터·복사·삽입

사용자가 확장 개발 호스트에서 실행하고 결과를 전달했다.

| 조건 | 확인한 결과 |
|---|---|
| db-check-alpha + typescript | filterEven / ID 4 한 개 |
| 프로젝트 전체 + typescript | 8개, 모두 typescript |
| mvp-save-test + typescript | 결과 없음, 서버 오류와 구분 |
| 모두 해제 | 프로젝트·언어 전체, 기존 질문·결과 복원 |
| db-check-alpha + 언어 전체 | add_numbers / ID 3, filterEven / ID 4 두 개 |
| multiply / ID 12 복사·삽입 | 새 빈 편집기의 복사·붙여넣기와 삽입 모두 두 줄 원문과 일치 |

초기 필터 시험은 기존에 제출한 질문인 “숫자가 0보다 큰 양수인지 확인하는 함수”에 적용됐다. 이는 범위·개수·ID 확인이며 짝수 질문의 순위 평가로 집계하지 않는다. API 11개 조건 시험에는 별도의 짝수 질문을 사용했다.

## 예시 5개의 실제 파일·줄 위치

Windows에서 파일을 읽어 비교했다. 줄바꿈 LF/CRLF는 비교용으로 정규화했고 DB 원문은 바꾸지 않았다.

| 현재 DB ID | 프로젝트·파일 | 줄 범위 | 확인 범위 |
|---|---|---|---|
| 8 | mvp-save-test / sample.py · add | 1–2 | 기존 파일 일치 |
| 9 | mvp-save-test / even_numbers.py | 1–2 | 없던 시험 파일을 DB 원문으로 복원, 실제 열기 확인 |
| 10 | mvp-save-test / sort_users.py | 1–2 | 기존 파일 일치 |
| 11 | mvp-auto-test-1104 / safe_divide.py | 1–4 | 기존 파일 일치 |
| 12 | backend-api-regression / sample.py · multiply | 1–2 | 없던 시험 파일을 DB 원문으로 복원, 실제 열기 확인 |

처음에는 3/5가 일치했고 ID 9·12의 파일이 없었다. 두 파일만 복원한 뒤 5/5가 일치했다. 기존 파일 3개의 SHA256은 복원 전후 동일했다. 복원한 파일을 원래부터 존재했던 과거 원본으로 표현하지 않는다. 이 ID는 현재 평가 DB 기준이며 11/16 결과의 숫자 ID와 혼용하지 않는다.

초기 ‘원본 없음’ 화면의 툴팁은 프로젝트 폴더가 열려 있지 않다는 뜻이었다. 사용자 탐색기에는 mvp-auto-test-1104 하나만 열려 있었다. 검증용 세 프로젝트 워크스페이스를 같은 창에서 열자 even_numbers는 ‘원본 같음’과 1–2줄 이동, multiply도 1–2줄의 `return a * b`를 확인했다.

로컬 원본: `windows-source-check.json`, `windows-source-restoration.json`, `windows-source-check-after-restore.json`, `ui-progress.json`.

## 프로젝트를 다시 열어야 하는 불편 개선

사용자가 다른 프로젝트의 코드 원본을 열 때마다 폴더를 다시 여는 불편을 지적했다.

- 연 프로젝트 위치를 VS Code 로컬 globalState에 기억한다. 로컬·원격 확장 환경은 구분한다.
- 기억한 프로젝트는 현재 작업 영역에 없어도 파일만 연다.
- 예전 코드·이동한 프로젝트는 결과의 ‘원본 위치 연결’에서 폴더를 한 번 선택한다. 작업 영역에 추가하지 않는다.
- 이름이 같은 여러 프로젝트를 임의로 선택하지 않는다. 사용자가 연결한 위치를 우선한다.
- 위치 연결 뒤 검색·AI 참고 코드 카드의 파일 상태를 다시 읽으며 LLM을 재호출하지 않는다.
- 저장 API의 7개 필드·Backend·DB 구조는 바꾸지 않는다. 실제 원본 경로는 서버·DB·Git·설정 파일로 보내지 않는다.

### 자동 검사와 빌드

- TypeScript를 포함한 Extension 단위 검사 84개 통과(기존 72 + 신규 12).
- 닫힌 프로젝트 조회, 새 세션 복원, 동명 프로젝트 충돌·수동 선택·재연결·환경 분리·쓰기 순서·잘못된 경로를 확인했다.
- 실제 확장 메시지 핸들러로 열린 프로젝트 없이 파일 이동, 첫 연결에서 이동한 줄로 열기를 확인했다. 실제 생성 웹뷰 JavaScript도 구문 분석했다. 이 검사는 VS Code API를 모의한 자동 검사다.
- Dev Container의 ESLint 통과. 공유 node_modules가 Windows용 esbuild를 포함해 Linux 번들 실행은 실패했다. 기존 Windows 의존성을 바꾸지 않았다.
- Windows에서 사용자가 `npm.cmd run compile` 후 `build finished`를 확인했다.
- 사용자가 새 번들을 로드한 뒤, 현재 작업 영역을 mvp-auto-test-1104 하나로 전환했다. mvp-save-test 조건 검색의 ID 9 원본을 폴더 추가 없이 바로 여는 것을 확인했다.
- db-check-alpha / ID 4는 DB 원문으로 만든 별도 even.ts 시험 파일에 처음 위치를 연결했다. 사용자가 ‘원본 같음’으로 바뀌고 원본 열기가 작동함을 확인했다. 이 시험 파일을 역사적 원본으로 표현하지 않는다.

## 남은 범위

- 원본 위치 기억 변경의 PR 검토·develop 반영.
- 늦은 검색 응답·취소·오류/시간 초과·최근 검색 복원 등의 나머지 UI 확인.
- 키 삭제/서버 키 수동 전환·Claude 상세 근거·AI 평가 화면과 팀원 답변 교차 검토.
- 포스터 최종 검토·제출과 현장 준비.

기존 25문항·20문항 평가 산출물은 보존했다. 팀원 내용 검토용으로 과거 답변 50개와 별도 실패·한계 3개를 모은 로컬 `rag-human-review.html`도 준비했지만, 준비만으로 사람의 검토 완료를 표시하지 않는다.
