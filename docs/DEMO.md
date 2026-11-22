# 저장에서 검색까지 시연하기

환경 준비가 끝난 팀원을 위한 짧은 실행 순서입니다. 처음 실행한다면 [개발 가이드](DEVELOPMENT.md)에서 DB·스키마·의존성을 준비하세요. 아래 경로는 예시이며 기존 파일은 먼저 확인합니다.

## 1. Backend 시작 — Dev Container의 Bash

저장소 루트에서 실행하고 이 터미널을 열어 둡니다.

```bash
uv run --locked uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

E5 warmup: OK와 Application startup complete.를 확인합니다. Windows에서 [health](http://127.0.0.1:8000/health)에 접속해 status: ok를 확인합니다. 접속이 안 되면 Dev Container의 **포트** 탭에서 8000 전달 주소를 확인합니다.

## 2. Extension 준비 — Windows PowerShell

처음 준비하거나 의존성이 바뀌었다면 extension 폴더에서 npm.cmd ci를 먼저 실행합니다. watch나 개발 호스트가 파일을 사용 중이면 종료한 후 설치합니다.

```powershell
Set-Location -LiteralPath "C:\dev\capstone-rag\extension"
npm.cmd run compile
```

검사·린트·빌드가 성공하면 다음 단계로 진행합니다. 별도 프로젝트 폴더 C:\dev\mvp-auto-test-1104를 준비하고, 그 안에 safe_divide.py를 저장합니다. 이 폴더와 파일은 저장소에 포함된 파일이 아닙니다.

```python
def safe_divide(a, b):
    if b == 0:
        return None
    return a / b
```

Windows PowerShell에서 개발 호스트를 엽니다.

```powershell
code.cmd --new-window --extensionDevelopmentPath="C:\dev\capstone-rag\extension" "C:\dev\mvp-auto-test-1104"
```

## 3. 실제 서버 설정 — 확장 개발 호스트

1. 새로 열린 **확장 개발 호스트**에서 Ctrl+,로 설정을 엽니다.
2. **Workspace / 작업 영역**에서 codeMemory를 검색합니다.
3. codeMemory.mock은 false, codeMemory.apiUrl은 http://127.0.0.1:8000 또는 실제 전달 주소로 설정합니다.
4. 검색 결과 개수 codeMemory.searchLimit은 10으로 맞춥니다.
5. VS Code 하단에 실제 서버 주소가 표시되는지 확인합니다. 임시 시험 서버 주소가 남아 있지 않아야 합니다.

## 4. 한 번 저장하고 확인

safe_divide.py의 4줄을 선택하고 **Code Memory: 코드 저장** 또는 Ctrl+Alt+S를 실행합니다.

- **출력 → Code Memory**에서 실제 POST 응답과 생성된 ID를 기록합니다.
- 정상 기준은 HTTP 200, embedding_status: ready, embedding_error: null입니다.
- 저장 기록에는 **검색 준비됨**이 표시됩니다.
- DB 대조가 필요하면 반환된 ID로 원문·메타데이터 7개, 768차원·norm 약 1, ready 상태를 확인합니다. [테스트 안내](TESTING.md)를 따릅니다.

failed는 원문 저장 완료와 검색 준비 실패를 뜻합니다. 시간 초과·503은 응답 내용에 따라 저장 여부가 다르므로, 같은 POST를 반복하기 전에 로그와 DB를 확인합니다. 상세 구분은 [API 계약](../API_CONTRACT.md)에 있습니다.

## 5. 검색하고 다시 사용

**Code Memory: 검색창 열기** 또는 Ctrl+Alt+F로 검색창을 엽니다. 설정 검색창과 구분합니다.

```text
0으로 나누는 경우를 처리하는 나눗셈 함수
```

1. 위 질문을 입력하고 검색합니다. 이전 결과 필터는 해제합니다.
2. 방금 저장한 **실제 ID**의 코드·파일·1~4줄을 확인합니다. 같은 코드가 이미 저장되어 있으면 다른 ID도 함께 나올 수 있습니다.
3. **원본 열기**로 로컬 safe_divide.py를 엽니다.
4. **복사** 후 새 빈 편집기에 붙여넣어 4줄과 들여쓰기를 확인합니다.
5. 다른 새 빈 편집기에서 **삽입**을 확인합니다.

검색 순위와 점수는 DB 내용에 따라 달라집니다. 점수는 코사인 유사도이며 정확도 퍼센트가 아닙니다.

## 6. 마무리

반환 ID·질문·실제 순위와 확인한 결과를 기록합니다. 개발 호스트를 닫고 Backend 실행 터미널에서 Ctrl+C로 종료합니다. DB volume은 유지합니다.

빈 결과·오류 화면 시험을 위해 서버 주소를 바꿨다면, 실제 주소로 복원하고 실제 검색이 되는지 확인한 뒤 임시 서버를 종료합니다. DB를 비워서 시험하지 않습니다.

[문서 목차](README.md) · [오류 확인과 실행 상세](DEVELOPMENT.md) · [확인된 시연 결과](INTEGRATION_TEST_2026-11-05.md)
