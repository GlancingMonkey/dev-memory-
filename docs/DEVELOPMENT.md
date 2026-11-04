# 개발환경과 실행 가이드

이 가이드는 같은 PC에서 **Backend·DB·Embedding은 Dev Container**, **Extension은 Windows 로컬 VS Code**로 실행한 순서를 기준으로 한다. 각 절의 정상 결과를 확인한 뒤 다음 절로 이동한다.

API 필드·응답은 [API_CONTRACT.md](../API_CONTRACT.md)를 우선한다. 이 문서는 실행과 재현 절차이며 API 계약을 변경하지 않는다.

## 1. 환경 구분과 준비

| 실행 위치 | 할 일 |
|---|---|
| Windows 로컬 | Docker Desktop, VS Code, Dev Containers 확장, Extension용 Node·npm |
| Dev Container 저장소 루트 | uv 환경, Backend·자동 Embedding, DB 조회, 기존 ID 재처리 |
| 확장 개발 호스트 | 테스트 프로젝트 열기, 실제 API 설정, 저장·검색 UI |

현재 자동 저장 연결 결과는 [2026-11-05 검증 기록](INTEGRATION_TEST_2026-11-05.md), 이전 환경·검색 검증은 [2026-10-28 기록](INTEGRATION_TEST_2026-10-28.md)에 있다. 경로 예시 `C:\dev\capstone-rag`는 본인의 저장소 경로로 바꾼다.

1. Docker Desktop을 실행한다.
2. Windows VS Code에서 저장소 루트 폴더를 연다.
3. 명령 팔레트에서 **Dev Containers: Reopen in Container**를 실행한다.
4. Dev Container 준비가 끝난 뒤 새 터미널을 연다.

[현재 설정](../.devcontainer/devcontainer.json)은 Python 3.13, Node 24, Docker CLI 기능을 준비하고 postCreateCommand에서 uv 설치와 의존성 동기화를 실행한다. db 서비스가 정상 상태가 된 뒤 dev 서비스가 시작된다. 첫 환경 준비에는 다운로드 시간이 필요하다.

Dev Container 터미널에서 확인한다.

```bash
pwd
git branch --show-current
git status
python --version
uv --version
uv sync --locked
```

workspaceFolder는 현재 `/workspaces/capstone-rag`이다. `uv sync --locked`는 저장소의 pyproject.toml과 uv.lock에 맞춰 공통 환경을 준비한다. 기존 비교 실험의 별도 requirements 환경과 구분한다.

uv가 설치됐지만 현재 터미널에서 검색되지 않으면 새 터미널을 열거나, 현재 설정의 설치 경로를 PATH에 추가한다.

```bash
export PATH="/home/vscode/.local/bin:$PATH"
uv --version
```

참고: [uv 공식 설치 안내](https://docs.astral.sh/uv/getting-started/installation/), [VS Code Dev Containers 안내](https://code.visualstudio.com/docs/devcontainers/containers).

## 2. 로컬 DB 연결 설정

저장소 루트의 [.env.example](../.env.example)을 사용한다. 이미 정상 접속하는 .env가 있으면 그 파일을 유지한다.

다음은 **Dev Container의 Bash** 명령이다.

```bash
test -f .env || cp .env.example .env
```

생성한 .env를 VS Code에서 열고 `CHANGE_ME`를 자신의 개발 DB 비밀번호로 바꾼다. 현재 [docker-compose.yml](../docker-compose.yml)의 POSTGRES_DB·POSTGRES_USER·POSTGRES_PASSWORD와 실제 사용 중인 DB 설정을 확인한다. 실제 .env는 .gitignore에 포함되어 있다.

| 대상 | 주소 기준 |
|---|---|
| Dev Container Backend → Compose DB | db:5432 |
| Windows Backend → 공개된 로컬 DB 포트 | 127.0.0.1:5432 |
| Windows Extension → 전달된 Backend 포트 | http://127.0.0.1:8000 |

이 가이드의 Backend는 Dev Container에서 실행한다. Extension 설정의 API 주소와 DATABASE_URL은 용도가 다른 값이다.

연결 여부를 확인한다. 비밀번호나 DATABASE_URL 전체를 출력하지 않는다.

```bash
uv run --locked python - <<'PY'
from backend.database import connect_db

with connect_db() as connection:
    print(connection.execute(
        "SELECT current_database(), current_schema()"
    ).fetchone())
PY
```

현재 Compose 기본 DB라면 `('capstone', 'public')`이 나온다.

## 3. 새 DB와 기존 volume의 스키마 확인

새 PostgreSQL 데이터 volume은 초기 시작 때 [database/init.sql](../database/init.sql)을 실행한다. 이미 만들어진 volume은 컨테이너를 다시 시작해도 init.sql이 자동으로 다시 실행되지 않을 수 있다.

현재 DB 컨테이너 이름은 Compose의 `container_name: capstone-db`이다. 아래 명령은 **Dev Container의 Bash, 저장소 루트** 기준이다.

```bash
docker exec capstone-db psql -U capstone -d capstone -c "SELECT to_regclass('public.snippets');"
```

먼저 현재 컬럼을 확인한다.

```bash
docker exec capstone-db psql -U capstone -d capstone -c "\d public.snippets"
```

- snippets가 없으면 init.sql을 적용한다.
- 기존 테이블에 embedding이 없으면 001 migration을 적용한다.
- embedding은 있고 embedding_status·embedding_error가 모두 없으면 002 migration을 적용한다.
- 필요한 컬럼이 이미 있으면 해당 migration을 건너뛴다. 상태 컬럼이 일부만 있거나 타입이 다르면 DB 담당자와 현재 구조부터 확인한다.

현재 DB에 필요한 명령만 선택해 적용한다.

snippets 테이블이 없는 경우:

```bash
docker exec -i capstone-db psql -U capstone -d capstone -v ON_ERROR_STOP=1 < database/init.sql
```

기존 테이블에 embedding 컬럼이 없는 경우:

```bash
docker exec -i capstone-db psql -U capstone -d capstone -v ON_ERROR_STOP=1 < database/migrations/001_add_embedding.sql
```

embedding이 있고 두 상태 컬럼이 모두 없는 경우:

```bash
docker exec -i capstone-db psql -U capstone -d capstone -v ON_ERROR_STOP=1 < database/migrations/002_add_embedding_status.sql
```

위의 `< 파일` 입력은 Bash 문법이다. Windows PowerShell에 그대로 붙여넣지 않는다. init/001은 IF NOT EXISTS를 사용하지만 002는 재실행용이 아니므로 이미 적용한 DB에 반복 실행하지 않는다. 기존 volume을 유지하고 실제 컬럼 타입을 확인한다.

```bash
docker exec capstone-db psql -U capstone -d capstone -c "\d public.snippets"
```

정상 기준은 nullable `embedding vector(768)`, NOT NULL/default pending인 `embedding_status`, nullable `embedding_error`다. 상태는 pending/ready/failed다. 기존 ID·원문·메타데이터·벡터가 유지되는지 적용 전후 대조한다.

## 4. Backend 실행과 상태 확인

Dev Container의 저장소 루트에서 실행하고 터미널을 유지한다.

```bash
uv run --locked uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

최신 코드를 불러온 서버인지 확인하고 실행 터미널을 유지한다. 정상 준비 로그는 다음과 같다.

```text
E5 warmup: OK
...
Application startup complete.
```

warmup 실패가 있어도 서버 자체는 실행될 수 있으므로 두 로그를 함께 확인한다. Windows 브라우저에서는 다음을 확인한다.

- [GET /health](http://127.0.0.1:8000/health): `{"status":"ok"}`
- [Swagger](http://127.0.0.1:8000/docs): POST /snippets와 GET /search

접속이 안 되면 Dev Container 창의 **포트** 탭에서 8000 포트의 실제 전달 주소를 확인한다. /health는 서버 실행 상태를 나타내며 DB 연결과 저장 성공은 별도로 확인한다. 루트 /의 404는 현재 등록된 라우트 기준 정상이다.

## 5. 새 환경의 테스트 코드와 저장 데이터 준비

기존 DB에 세 샘플과 벡터가 준비되어 있으면 상태를 확인하고 해당 준비 단계를 건너뛴다. 아래 저장 요청을 다시 실행하면 새 행이 추가된다.

원본 열기까지 확인하려면 Windows에 별도 테스트 폴더 `C:\dev\mvp-save-test`를 만들고 다음 파일을 저장한다. 이미 파일이 있으면 내용부터 확인하고 보존한다. 이 파일들은 저장소에 들어 있는 파일이 아닌 테스트용 예시다.

sample.py:

```python
def add(a, b):
    return a + b
```

even_numbers.py:

```python
def even_numbers(values):
    return [n for n in values if n % 2 == 0]
```

sort_users.py:

```python
def sort_users(users):
    return sorted(users, key=lambda user: user["age"])
```

Backend가 실행 중인 상태에서 Dev Container의 **다른 터미널**로 아래 저장 요청을 보낼 수 있다. 또는 Swagger에서 같은 7개 필드로 저장한다. 아래 코드는 실제 테스트 행 3개를 추가한다.

```bash
uv run --locked python - <<'PY'
import json
from urllib.request import Request, urlopen

samples = [
    ("sample.py", "add", "def add(a, b):\n    return a + b"),
    ("even_numbers.py", "even_numbers",
     "def even_numbers(values):\n    return [n for n in values if n % 2 == 0]"),
    ("sort_users.py", "sort_users",
     'def sort_users(users):\n    return sorted(users, key=lambda user: user["age"])'),
]
for file_path, function_name, code in samples:
    payload = {
        "project_name": "mvp-save-test",
        "file_path": file_path,
        "language": "python",
        "function_name": function_name,
        "start_line": 1,
        "end_line": 2,
        "code": code,
    }
    request = Request(
        "http://127.0.0.1:8000/snippets",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        result = json.load(response)
        print(file_path, response.status, result)
        if result.get("embedding_status") != "ready":
            raise SystemExit("Stop: check the saved ID and DB status before more requests")
PY
```

정상 응답은 HTTP 200, 실제 id, message=snippet saved, embedding_status=ready, embedding_error=null이다. failed이면 원문은 저장된 상태이므로 해당 ID와 실패 사유부터 확인한다. 응답 시간 초과나 503만으로 원문 저장 실패를 단정하거나 같은 POST를 반복하지 않는다. **id는 본인 환경의 실제 응답값**을 기록한다. 폴더 이름을 다르게 정했다면 project_name도 그 이름으로 맞춘다.

## 6. 자동 Embedding과 기존 ID 재처리

POST /snippets는 원문·메타데이터를 먼저 커밋하고, 저장 트랜잭션 밖에서 E5 벡터를 생성한 뒤 같은 행의 벡터·상태를 저장한다. 정상 요청은 이 처리까지 기다려 ready로 응답한다.

| 항목 | 현재 규칙 |
|---|---|
| 모델 | intfloat/multilingual-e5-base |
| revision | d128750597153bb5987e10b1c3493a34e5a4502a |
| 실행·출력 | CPU / FP32, 정규화된 768차원 벡터 |
| 질문 입력 | embed_query가 `query: ` 접두사를 붙임 |
| 코드 입력 | embed_code가 `passage: ` 접두사를 붙임 |
| 길이 | 접두사·특수 토큰 포함 최대 512토큰; 초과 시 원문 보존 후 failed |
| DB·검색 | nullable vector(768), 코사인 거리 <=> |

[rag/embedding.py](../rag/embedding.py)가 접두사를 붙이므로 호출자는 원문을 전달한다. 서버 시작 시 warmup을 수행하며 모델의 첫 다운로드·로드에는 추가 시간이 걸릴 수 있다.

### 응답에 따른 확인

- 200/ready: 원문과 벡터가 저장됐고 검색할 수 있다.
- 200/failed: 원문과 ID는 보존돼 있다. 입력·생성·저장 실패 코드를 확인한다.
- 503/저장된 ID와 status=null: 원문은 저장됐다. 해당 ID의 DB 최종 상태부터 확인한다.
- 503/detail만 있음 또는 시간 초과: 원문 저장 여부가 확인되지 않았다. 서버 로그·DB 확인 전 같은 POST를 반복하지 않는다.

pending은 미처리 상태이며 자동 백그라운드 실행을 뜻하지 않는다. 상태를 무시하고 벡터만 직접 채우는 대신 기존 ID 재처리 CLI를 사용한다.

### 선택한 ID 먼저 조회

Dev Container Bash에서 실제 프로젝트와 ID를 입력한다. 아래 명령은 읽기 전용이다.

```bash
read -r -p "프로젝트 이름: " retry_project
read -r -p "확인할 스니펫 ID: " retry_id
uv run --locked python -m rag.retry_embeddings --project "$retry_project" --id "$retry_id"
```

대상 프로젝트·ID·원문이 원하는 행이고 재처리 가능한 상태인지 확인한다. 벡터가 있으면 건너뛰며, 입력 한도 초과의 failed/embedding_input_invalid도 같은 입력으로 다시 처리하지 않는다.

### 확인한 ID에 적용

앞서 확인한 같은 터미널의 프로젝트·ID로 적용한다.

```bash
uv run --locked python -m rag.retry_embeddings --project "$retry_project" --id "$retry_id" --apply
```

재처리는 새 INSERT를 만들지 않는다. 기존 ID·프로젝트·읽은 원문·NULL 벡터 조건을 확인하고, 성공하면 ready와 벡터를 저장하며 실패 사유를 지운다. 원문·메타데이터·기존 벡터를 보호한다. 자세한 종료 코드와 실패 처리 규칙은 [rag/README.md](../rag/README.md)를 따른다.

같은 코드를 여러 번 저장한 행은 서로 다른 DB 행이며 검색 결과 중복 제거는 별도 후속 작업이다.

## 7. 실제 검색과 Extension 연결

Backend의 E5 warmup 성공과 검색할 행의 ready·벡터 저장을 확인한 뒤 Windows Swagger의 GET /search에서 q와 limit을 입력한다. 같은 질문을 Extension에서도 검색해 연결을 대조한다.

| 질문 | 기대 함수 |
|---|---|
| 두 숫자를 더하는 함수 찾아줘 | add |
| 숫자 목록에서 짝수만 골라내는 코드 | even_numbers |
| 사용자들을 나이순으로 정렬하는 코드 | sort_users |

limit 기본값은 10이고 1~20을 허용한다. 실제 DB 내용에 따라 id·순위·개수는 달라질 수 있다. 결과에는 id, 기존 7개 필드, score가 들어간다.

- score = 1 - cosine_distance, 범위 -1~1, 클수록 유사하다.
- 정렬은 코사인 거리 오름차순, 동점이면 id 오름차순이다.
- 검색 가능한 벡터 행이 없으면 results=[]를 반환한다. 관련 없는 질문 자체가 빈 결과를 보장하지는 않는다.
- 잘못된 질문·limit은 422, 모델·DB 처리 실패는 503이다.
- 검색은 LLM을 호출하지 않는다.

API 직접 검색이 정상이라면 [Extension README](../extension/README.md)의 Windows 빌드·개발 호스트 실행·Mock=false 설정을 따른다. 같은 질문의 순서·코드·경로·줄 번호·점수를 API와 UI에서 비교한다.

원본 열기로 실제 파일의 줄 범위를 확인하고, 저장한 id의 DB 행과 전송 원문·메타데이터를 대조한다. 정상 새 저장은 ready·768차원·norm 약 1이며, 임베딩 실패 행은 failed·원문 보존·벡터 NULL인지 확인한다.

## 8. 종료와 오류 확인

Backend를 더 사용하지 않으면 실행 터미널에서 Ctrl+C로 종료한다. DB 데이터는 Docker의 postgres_data volume에 유지된다.

| 증상 | 확인할 내용 |
|---|---|
| DATABASE_URL is not configured | 저장소 루트 .env와 Backend 실행 환경 확인 |
| DB 연결 실패 | DB 실행·health 상태, db/127.0.0.1 구분, 실제 로컬 접속 설정 확인 |
| relation snippets does not exist | 3절의 테이블 존재 확인과 init.sql 적용 |
| embedding 또는 상태 컬럼이 없음 | 3절에서 실제 컬럼 확인 후 필요한 migration만 적용 |
| 검색 결과가 없음 | 해당 DB의 ready 상태·벡터와 실패 사유 확인 |
| 저장은 됐지만 검색 준비 실패 | 같은 POST를 반복하지 말고 기존 ID의 원문·상태와 재처리 조건 확인 |
| 입력 한도 초과 | 원문과 ID 보존 확인 후 입력 분할 등 후속 방안 검토. 같은 입력 반복 재처리 중단 |
| 첫 검색 시간 초과 | 모델 다운로드·로드가 끝났는지 Backend 로그와 Swagger로 확인 |
| torch_dtype deprecated 경고 | 현재 고정 라이브러리에서 보인 경고다. 실제 예외·HTTP 실패 여부와 구분해 확인 |
| Extension 원본 열기 실패 | 실제 로컬 파일, 열린 프로젝트 이름, 상대 경로 확인 |

모델 비교 원본은 [기존 실험 폴더](../rag/experiments/embedding_compare/README.md)에 보존되어 있다. 추가 실행을 했다면 날짜·환경·SHA·실제 응답을 새 기록에 남긴다.
