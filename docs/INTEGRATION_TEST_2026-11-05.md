# 2026-11-05 자동 Embedding·Extension 통합 검증

## 기준과 범위

- 검증 브랜치: feature/extension. develop의 [c63f2ab](https://github.com/GlancingMonkey/dev-memory-/commit/c63f2abb399ec36790e5718cf5b2bc61c7d1e96f)를 병합한 뒤 저장 응답 처리를 수정한 작업 트리에서 실행했다. 검증 시점에는 해당 수정본이 커밋 전이었다.
- 연결 작업: Backend 자동 임베딩 [#33](https://github.com/GlancingMonkey/dev-memory-/pull/33), RAG 재처리 [#35](https://github.com/GlancingMonkey/dev-memory-/pull/35), Extension [#34](https://github.com/GlancingMonkey/dev-memory-/pull/34).
- 사용자가 자신의 Windows·Dev Container에서 직접 실행해 공유한 명령 결과, HTTP·DB 출력, 검색·원본 열기·저장 기록 확인을 근거로 정리했다.
- 이전 [2026-10-28 검증](INTEGRATION_TEST_2026-10-28.md)은 수동 벡터 준비 단계의 당시 기록으로 그대로 보존한다.
- 이번 범위는 자동 저장·임베딩·검색·원본 열기와 입력 한도 실패 보존이다. LLM/RAG 답변은 포함하지 않는다.

## 실행 환경과 준비

| 항목 | 확인한 값 |
|---|---|
| Windows 저장소 | C:\dev\capstone-rag |
| Dev Container 저장소 | /workspaces/capstone-rag |
| VS Code | 1.145.0 x64 / a717861c07586a53d83b80d742cd3f59b20a6273 |
| Windows Node / npm | v24.20.0 / 11.19.0 |
| Extension | Windows 로컬 확장 개발 호스트 |
| Backend | Dev Container, 0.0.0.0:8000 |
| Extension API 주소 | http://127.0.0.1:8000 |
| Extension mock | false |
| 모델 준비 | E5 warmup: OK |
| Windows의 GET /health | status: ok |

모델 설정은 기존 intfloat/multilingual-e5-base, revision d128750597153bb5987e10b1c3493a34e5a4502a, CPU/FP32, 정규화된 768차원 출력이다. 질문·코드는 기존 query: / passage: 접두사 규칙을 사용했다.

## 자동 검사

Windows의 extension 폴더에서 실행한 결과다.

```powershell
npm.cmd run test:unit
npm.cmd run compile
```

- 단위 테스트: 26 passing.
- TypeScript 검사·ESLint·esbuild: build finished, 오류 없이 완료.
- 응답 검사는 ready·failed, 저장된 ID가 있는 503과 없는 503, 계약과 다른 상태·필드를 포함한다.

## 정상 저장과 DB 대조

Windows 테스트 폴더는 C:\dev\mvp-auto-test-1104다. 이 폴더와 원본 파일은 저장소에 포함된 배포 파일이 아니다.

실제 전송한 7개 필드:

```json
{
  "project_name": "mvp-auto-test-1104",
  "file_path": "safe_divide.py",
  "language": "python",
  "function_name": "safe_divide",
  "start_line": 1,
  "end_line": 4,
  "code": "def safe_divide(a, b):\r\n    if b == 0:\r\n        return None\r\n    return a / b"
}
```

실제 POST /snippets 응답은 HTTP 200, Extension에 표시된 요청 시간은 0.70초였다.

```json
{
  "id": 6,
  "message": "snippet saved",
  "embedding_status": "ready",
  "embedding_error": null
}
```

같은 DB의 id=6을 읽기 전용으로 조회해 확인했다.

| 항목 | 실제 확인 결과 |
|---|---|
| 원문·메타데이터 7개 필드 | 요청과 모두 일치, CRLF·들여쓰기 보존 |
| embedding_status / error | ready / NULL |
| 차원 | 768 |
| norm | 1.000000036425305 (약 1) |
| 조회 검사 | DB verification: OK |
| Extension 출력 | 원문 저장 완료 id=6, 검색 준비 ready |
| 실제 저장 기록 표시 | id=6 · 검색 준비됨 |

## 검색과 원본 열기

확장 개발 호스트에서 실제 API 설정으로 다음 자연어 질문을 검색했다.

```text
0으로 나누는 경우를 처리하는 나눗셈 함수
```

사용자가 safe_divide가 첫 번째 결과에 표시됨을 확인했다. 결과의 원본 열기로 C:\dev\mvp-auto-test-1104\safe_divide.py가 정상적으로 열림을 확인했다. 검색 점수와 검색 요청 시간은 이번 기록에서 측정하지 않았다.

이 한 질문의 연결 결과를 전체 검색 정확도나 새 모델 비교 결과로 일반화하지 않는다.

## 실제 입력 한도 실패와 원문 보존

별도 테스트 파일 embedding_limit_probe.py에 `value = 1`을 CRLF로 600줄 작성하고 전체 선택 후 한 번 저장했다. 함수 이름은 null, 시작·끝 줄은 1·600이다.

실제 POST /snippets 응답은 HTTP 200, 표시된 요청 시간은 0.30초였다.

```json
{
  "id": 7,
  "message": "snippet saved",
  "embedding_status": "failed",
  "embedding_error": "embedding_input_invalid"
}
```

읽기 전용 조회에서 id=7의 원문·메타데이터를 전송 내용과 대조했다.

```text
ID: 7
Original code and metadata preserved: True
Code lines: 600
Status: failed
Error: embedding_input_invalid
Embedding is NULL: True
Failure preservation check: OK
```

사용자가 실제 저장 기록에서 id=7 · 검색 준비 실패 표시를 확인했다. 입력 한도 오류에도 원문과 ID가 남는 상태이며, 같은 입력을 반복 재처리하는 대상이 아니다.

위 id=6·7은 해당 로컬 DB에서 관측한 값이며 다른 환경에서는 실제 반환 ID를 사용한다. 이번 DB 대조 범위는 새로 저장한 두 행의 원문·메타데이터·벡터·상태다.

## 확인 범위와 후속 사항

- HTTP 200 ready·failed는 실제 Backend·DB·Extension에서 확인했다.
- HTTP 503의 ID 보존·상태 확인 불가 구분은 단위 테스트로 검사했다. 이번 수동 검증에서 실제 DB 장애나 503 응답 주입을 발생시킨 것으로 기록하지 않는다.
- 0.70초와 0.30초는 warmup 완료 후 서로 다른 요청을 한 번씩 실행한 값이다. 평균·p95·모델 최초 로드 시간이나 일반적인 성능 보장으로 사용하지 않는다. 실패 요청의 0.30초는 벡터 생성 완료 시간이 아니다.
- package.json의 저장 제한 시간 기본값 10초는 변경하지 않았다. 적절한 제한 시간은 추가 환경·입력 측정 후 별도로 판단한다.
- 이 문서를 정리하며 기존 세 모델 비교 실험이나 실제 DB 시험을 재실행하지 않았다. 기존 실험·2026-10-28 기록과 테스트 원문은 보존한다.
- develop 반영 후에는 [개발 가이드](DEVELOPMENT.md)의 스키마·서버 준비와 실제 연결을 확인한다. RAG/Ask AI, Context Token Budget, 입력 분할·장기 성능 평가는 후속 범위다.
