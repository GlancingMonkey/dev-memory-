# Code Memory Extension

VS Code에서 선택한 코드·메타데이터를 저장하고, Backend의 실제 검색 결과를 표시하는 TypeScript Extension이다.

## 현재 기능

- 선택한 코드의 저장과 실제 DB 생성 id 확인
- 자연어 검색과 결과 코드·메타데이터·유사도 표시
- 열린 프로젝트의 원본 파일과 줄 범위로 이동
- 코드 복사와 현재 편집기 선택 위치에 삽입

저장·검색 요청과 응답은 [API_CONTRACT.md](../API_CONTRACT.md)를 따른다. 현재 새 저장 코드의 자동 Embedding과 LLM 답변은 후속 작업이다.

## 실행 전 준비

이 가이드는 **같은 PC에서 Backend는 Dev Container, Extension은 Windows 로컬**로 실행한 검증 방법이다.

- Backend의 /health와 /docs에 Windows 브라우저로 접속할 수 있어야 한다.
- 실제 검색에는 미리 Embedding이 저장된 스니펫이 필요하다. [개발 가이드](../docs/DEVELOPMENT.md)의 데이터 준비 절차를 따른다.
- Windows에도 Node.js·npm이 필요하다. Dev Container의 Node 설치와 Windows 설치는 별개다.
- package.json의 VS Code 요구 범위는 `^1.138.0`이다. [통합 검증](../docs/INTEGRATION_TEST_2026-10-28.md)에서는 VS Code 1.143.1, Node 24.20.0, npm 11.19.0을 사용했다.

## 빌드

아래 경로는 검증 때 사용한 예시다. 본인의 저장소 경로로 바꾼다. Windows PowerShell에서 실행한다.

```powershell
cd C:\dev\capstone-rag\extension
npm.cmd ci
npm.cmd run compile
```

compile은 TypeScript 검사 → ESLint → esbuild 번들링 순서다. 각 단계가 성공한 뒤 다음 작업을 진행한다.

## 개발 호스트 열기

테스트할 프로젝트 폴더를 먼저 준비한다. `C:\dev\mvp-save-test`는 별도 로컬 테스트 폴더 예시이며 저장소에 포함된 폴더가 아니다.

빌드가 끝난 뒤 Windows PowerShell에서 실행한다.

```powershell
code --new-window --extensionDevelopmentPath="C:\dev\capstone-rag\extension" "C:\dev\mvp-save-test"
```

새로 열린 **확장 개발 호스트**에서 테스트한다. 같은 Extension을 다시 빌드했다면 개발 호스트를 다시 로드하여 변경을 반영한다.

F5의 Run Extension을 사용하는 경우에는 이 extension 폴더 자체를 VS Code에서 열고 [.vscode/extensions.json](.vscode/extensions.json)의 권장 확장을 확인한다. watch 작업의 `$esbuild-watch`는 권장 esbuild problem matcher 확장을 사용한다. 위 명령어 실행 방식은 사전 빌드한 dist를 사용한다.

## 실제 API 설정

확장 개발 호스트에서 Ctrl+,를 누르고 codeMemory를 검색한다.

| 설정 | 기본값 | 실제 연동 테스트 값 |
|---|---|---|
| codeMemory.mock | true | false |
| codeMemory.apiUrl | http://localhost:8000 | http://127.0.0.1:8000 또는 실제 전달 주소 |

Mock이 true이면 서버를 호출하지 않는다. 검색은 질문과 관계없이 고정 샘플 3개를 표시하고 저장은 가짜 id를 반환한다. 실제 검증에서는 false로 설정한다.

## 저장

1. 개발 호스트에서 프로젝트 폴더를 연다.
2. 파일을 프로젝트 안에 저장하고 코드 범위를 선택한다.
3. 명령 팔레트의 **Code Memory: 선택한 코드 저장**, 우클릭 메뉴 또는 Ctrl+Alt+S를 실행한다.
4. 출력 → Code Memory에서 POST 주소·HTTP 상태·실제 반환 id를 확인한다.
5. DB에서 그 id를 조회해 코드 원문을 포함한 7개 저장 필드를 대조한다.

미저장 파일, 프로젝트 밖 파일, 빈 선택은 안내 후 저장을 중단한다. 원본 절대 경로는 Extension 내부에서 사용하고 요청에는 기존 7개 필드만 넣는다.

## 검색과 코드 사용

왼쪽 Code Memory 검색창에 자연어를 입력한다. 실제 요청은 GET /search?q=...&limit=10이고 결과는 Backend 순서대로 표시한다.

- score는 코사인 유사도(-1~1)를 소수점으로 표시한다. 클수록 유사하며 정답 확률이나 정확도 퍼센트가 아니다.
- **원본 열기**: 이름이 같은 프로젝트 폴더가 열려 있고 상대 경로의 실제 파일이 있어야 한다.
- **삽입**: 현재 편집기의 선택 영역을 결과 코드로 바꾼다. 검증할 때는 새 빈 편집기를 사용한다.
- **복사**: 결과 코드 원문을 클립보드에 복사한다.

DB에 코드와 경로가 저장되어도 PC에 원본 파일이 자동으로 생성되지는 않는다.

## 오류 확인

| 증상 | 확인할 내용 |
|---|---|
| tsc를 찾을 수 없음 | extension 폴더에서 npm.cmd ci 성공 여부 |
| npm.ps1 실행 정책 오류 | Windows에서는 npm.cmd 사용; 작업 자동화 프로필은 저장소 설정의 cmd.exe 확인 |
| npm ci가 esbuild.exe의 EPERM으로 실패 | 실행 중인 watch·디버그 작업을 먼저 종료한 뒤 재시도 |
| 잘못된 problemMatcher: $esbuild-watch | 권장 esbuild problem matcher 확장 확인 또는 사전 빌드 후 위 명령으로 개발 호스트 실행 |
| 서버 연결 실패·시간 초과 | Backend 실행, apiUrl, Dev Container 8000 포트 전달 확인 |
| 첫 검색이 오래 걸림 | Swagger에서 모델 준비와 첫 검색이 끝난 뒤 UI 검색 |
| 결과가 없음 | DB의 검색 가능한 embedding 행이 준비됐는지 확인 |
| 원본 파일을 찾을 수 없음 | 현재 열린 프로젝트 이름과 상대 경로의 실제 파일 존재 확인 |

전체 실행 순서와 수동 Embedding은 [개발 가이드](../docs/DEVELOPMENT.md), 실제 확인한 결과는 [통합 검증 기록](../docs/INTEGRATION_TEST_2026-10-28.md)에 있다.
