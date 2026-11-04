# RAG 임베딩 재처리

기존 E5 모듈로 선택한 스니펫의 임베딩을 재처리한다.
Backend의 같은 ID 갱신 함수를 재사용하며, 명령에는 프로젝트와 ID를 함께 지정한다.

## 준비

- Dev Container의 저장소 루트에서 실행한다.
- `uv run --locked`로 저장소의 잠금된 의존성을 사용한다.
- DB 연결 설정은 기존 `backend.database.connect_db()`를 사용한다.
- 실제 DB에 `embedding vector(768)`, `embedding_status`, `embedding_error`가 필요하다.
- 기존 DB는 컬럼을 확인한 뒤 필요한 migration만 적용한다.
  `database/migrations/002_add_embedding_status.sql`은 이미 적용한 DB에 재실행하지 않는다.
- 코드는 원문 그대로 `embed_code()`에 전달한다. `passage: ` 접두사는 기존 모듈이 붙인다.

API 동작과 처리 상태의 공통 규칙은 [API_CONTRACT.md](../API_CONTRACT.md)를 따른다.

## 먼저 조회

Dev Container의 Bash에서 본인 DB의 프로젝트와 확인할 ID를 입력한다.
출력된 프로젝트·파일·함수·상태를 확인한 뒤 적용 여부를 정한다.

```bash
read -r -p "프로젝트 이름: " retry_project
read -r -p "확인할 스니펫 ID: " retry_id
uv run --locked python -m rag.retry_embeddings --project "$retry_project" --id "$retry_id"
```

기본 실행은 조회 전용이다. 벡터 생성과 갱신은 `--apply`를 지정했을 때 수행한다.

## 명시적으로 재처리

조회 결과가 원하는 대상인지 확인한 뒤, 같은 Bash 터미널에서 위에 입력한 프로젝트와 ID로 실행한다.

```bash
uv run --locked python -m rag.retry_embeddings --project "$retry_project" --id "$retry_id" --apply
```

- 벡터가 NULL이고 상태가 `pending` 또는 `failed`인 행을 대상으로 한다.
- 기존 벡터가 있으면 벡터 생성·저장을 건너뛴다.
- `failed/embedding_input_invalid`는 입력 문제 해결이 필요하므로 그대로 재시도하지 않는다.
- 읽기 트랜잭션을 닫은 뒤 임베딩을 생성한다.
- 저장 시 ID·프로젝트·읽은 원문·NULL 벡터 조건을 다시 확인한다.
- 성공 시 같은 행의 벡터와 `ready` 상태를 저장하고 실패 사유를 NULL로 지운다.
- 갱신 0행이나 실패 상태 기록 오류는 현재 DB 상태를 다시 확인한다.
- 새 INSERT를 만들지 않고 기존 원문·메타데이터·ID를 유지한다.

아래 2026-11-04 기록의 id=5는 검증 후 이미 `ready`가 됐다. 해당 DB에서 같은 행을 재실행하면 `skip`이 정상이다. 다른 환경의 id=5를 같은 행으로 가정하지 않는다.
출력 앞부분의 상태는 처리 전 조회 값이고, 마지막 `Result`가 이번 실행 결과다.
`updated_at`은 실제 상태·벡터 갱신 시 변경된다.

## 실패 처리와 종료 코드

안전한 실패 코드만 DB에 기록한다.

| 코드 | 의미 |
|---|---|
| embedding_input_invalid | 빈 코드 또는 접두사·특수 토큰 포함 512토큰 초과 |
| embedding_generation_failed | 모델 준비 또는 벡터 생성 실패 |
| embedding_storage_failed | 벡터 저장 실패 |

입력이 한도를 넘으면 원문을 보존하고, 입력 분할 등의 해결 방식을 별도로 검토한다.
오류 메시지에는 실패 코드와 예외 종류를 표시하며 예외 문자열을 그대로 출력하지 않는다.
상태 확인이 불가능하면 `unconfirmed`로 안내한다.

| 종료 코드 | 의미 |
|---|---|
| 0 | 조회 완료, 재처리 성공, 또는 기존 벡터 건너뜀 |
| 1 | 대상 없음, 처리 실패·확인 불가, 또는 적용 요청의 입력 문제 |
| 2 | 잘못된 명령 인자 |

종료 코드 0만으로 임베딩 준비 완료를 판단하지 않고 모드와 `Result`를 함께 확인한다.

## 자동 테스트

저장소 루트에서 실행한다.

```bash
uv run --locked python -m unittest discover -s tests -p "test_*.py" -v
```

`tests/test_retry_embeddings.py`는 DB·모델 호출을 모의 처리한다.
조회 전용 기본값, 기존 벡터 보호, 프로젝트 제한, 실패 분류,
갱신 0행 및 상태 확인 오류를 검사한다.

## 실제 실패·복구·재실행 검사

수동 검증 파일은 `tests/manual_retry_embedding_check.py`다.
선택한 개발용 DB 행에서 오류를 한 번 흉내 낸 뒤 실제 E5 재처리를 수행한다.
벡터가 이미 있는 대상이나 입력 오류가 해결되지 않은 대상에서는 시작을 거부한다.
각 단계 검증이 통과해야 다음 단계로 진행한다.

```bash
read -r -p "시험용 프로젝트 이름: " check_project
read -r -p "벡터가 없는 시험용 스니펫 ID: " check_id
read -r -p "그 코드를 찾을 자연어 질문: " check_query
uv run --locked python - --project "$check_project" --id "$check_id" --query "$check_query" < tests/manual_retry_embedding_check.py
```

위 명령은 Dev Container Bash용이다. 이 검사는 선택한 기존 행의 상태·벡터를 실제로 변경한다. 이미 성공한 행의 벡터를 시험 목적으로 지우지 않는다.
원문·메타데이터·행 수·다른 벡터 보존, 실패 후 복구,
재실행 시 모델·저장 호출 없이 건너뜀, 의미 검색 반환을 확인한다.

## 2026-11-04 실제 검증 기록

사용자가 RAG 작업 Dev Container에서 실행해 공유한 결과다.
검증 대상은 해당 로컬 DB의 id=5, `mvp-save-test/sort_users.py`다.

- 초기 `pending` → 생성 오류 모의 후 `failed/embedding_generation_failed` 확인.
- 실제 E5 재처리 후 같은 id=5가 `ready`, 실패 사유 NULL로 복구됨.
- 재실행 시 벡터 생성과 저장을 호출하지 않고 건너뜀.
- DB 행 수: 5 → 5.
- 저장 차원: 768. norm 출력: `1.000000`.
- 원문·7개 필드·created_at 및 다른 행의 기존 벡터 보존 확인.
- 기존 의미 검색 함수의 Top-20에서 같은 id=5의 코드·메타데이터 반환 확인.
- 질문: `사용자들을 나이순으로 정렬하는 코드`.
- 이 질문과 해당 DB에서 측정한 실제 순위: 2위.
- 마지막 결과: `RAG retry integration checks: OK`.

위 순위는 해당 질문·데이터에서의 연결 검증 결과다.
기존 모델 비교 실험 산출물은 유지하며, 추가 품질 평가는 별도로 진행한다.

[전체 테스트 안내](../docs/TESTING.md) · [시스템 구조](../docs/ARCHITECTURE.md) · [문서 목차](../docs/README.md)
