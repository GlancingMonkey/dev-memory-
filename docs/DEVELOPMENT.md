# 개발환경과 실행 가이드

이 가이드는 같은 PC에서 **Backend·DB·Embedding은 Dev Container**, **Extension은 Windows 로컬 VS Code**로 실행한 순서를 기준으로 한다. 각 절의 정상 결과를 확인한 뒤 다음 절로 이동한다.

API 필드·응답은 [API_CONTRACT.md](../API_CONTRACT.md)를 우선한다. 이 문서는 실행과 재현 절차이며 API 계약을 변경하지 않는다.

## 1. 환경 구분과 준비

| 실행 위치 | 할 일 |
|---|---|
| Windows 로컬 | Docker Desktop, VS Code, Dev Containers 확장, Extension용 Node·npm |
| Dev Container 저장소 루트 | uv 환경, Backend, DB 조회, 수동 Embedding |
| 확장 개발 호스트 | 테스트 프로젝트 열기, 실제 API 설정, 저장·검색 UI |

실제 확인한 버전은 [2026-10-28 검증 기록](INTEGRATION_TEST_2026-10-28.md)에 있다. 경로 예시 `C:\dev\capstone-rag`는 본인의 저장소 경로로 바꾼다.

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

- snippets가 없으면 init.sql을 적용한다.
- 기존 snippets가 있으면 데이터를 유지한 채 migration으로 embedding 컬럼을 추가한다.

```bash
# snippets 테이블이 없는 경우에 적용
docker exec -i capstone-db psql -U capstone -d capstone -v ON_ERROR_STOP=1 < database/init.sql

# 기존 테이블에 embedding 컬럼이 없는 경우에 적용
docker exec -i capstone-db psql -U capstone -d capstone -v ON_ERROR_STOP=1 < database/migrations/001_add_embedding.sql
```

위의 `< 파일` 입력은 Bash 문법이다. Windows PowerShell에 그대로 붙여넣지 않는다. SQL은 CREATE/ADD IF NOT EXISTS를 사용하며 기존 volume을 유지한다. 잘못된 기존 컬럼 타입을 자동으로 바꾸는 migration은 아니므로 실제 타입을 확인한다.

```bash
docker exec capstone-db psql -U capstone -d capstone -c "\d public.snippets"
```

정상 기준은 nullable `embedding vector(768)`과 기존 저장 필드·행이 유지되는 것이다. 실제 적용 전후 행 수와 원문·메타데이터도 대조한다.

## 4. Backend 실행과 상태 확인

Dev Container의 저장소 루트에서 실행하고 터미널을 유지한다.

```bash
uv run --locked uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

이미 같은 서버가 실행 중이면 그 서버를 사용한다. Windows 브라우저에서는 다음을 확인한다.

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
PY
```

정상 응답은 HTTP 200과 실제 id·message다. **id를 고정값으로 가정하지 않고** 본인 환경의 응답을 기록한다. 폴더 이름을 다르게 정했다면 project_name도 그 이름으로 맞춘다.

## 6. 현재 방식의 수동 Embedding

현재 POST /snippets는 원문·메타데이터만 저장한다. 아래 단계로 벡터를 채워야 검색할 수 있다.

| 항목 | 현재 규칙 |
|---|---|
| 모델 | intfloat/multilingual-e5-base |
| revision | d128750597153bb5987e10b1c3493a34e5a4502a |
| 실행·출력 | CPU / FP32, 정규화된 768차원 벡터 |
| 질문 입력 | embed_query가 query: 접두사와 끝 공백을 붙임 |
| 코드 입력 | embed_code가 passage: 접두사와 끝 공백을 붙임 |
| 길이 | 접두사와 특수 토큰을 포함해 최대 512토큰; 초과 입력 거절 |
| DB·검색 | nullable vector(768), 코사인 거리 <=> |

[rag/embedding.py](../rag/embedding.py)가 접두사를 붙이므로 호출자는 원문을 전달한다. 첫 호출에서 모델 준비 시간이 발생할 수 있다.

다음 코드는 **선택한 테스트 프로젝트의 embedding이 NULL인 행만** 처리한다. 실행 전에 project_name과 대상 행을 확인한다.

```bash
uv run --locked python - <<'PY'
from pgvector import Vector
from pgvector.psycopg import register_vector

from backend.database import connect_db
from rag.embedding import EmbeddingInputError, embed_code

project_name = "mvp-save-test"
with connect_db() as connection:
    rows = connection.execute("""
        SELECT id, code FROM public.snippets
        WHERE project_name = %s AND embedding IS NULL
        ORDER BY id
    """, (project_name,)).fetchall()

print("대상 id:", [row[0] for row in rows])
for snippet_id, code in rows:
    try:
        values = embed_code(code)
    except EmbeddingInputError as error:
        print(f"id={snippet_id}: 건너뜀 ({error})")
        continue

    with connect_db() as connection:
        register_vector(connection)
        updated = connection.execute("""
            UPDATE public.snippets SET embedding = %s
            WHERE id = %s AND code = %s AND embedding IS NULL
        """, (Vector(values), snippet_id, code)).rowcount
    print(f"id={snippet_id}: dimension={len(values)}, updated={updated}")
PY
```

정상적으로 connection 문맥을 빠져나오면 커밋된다. 이미 벡터가 있는 행은 건너뛰고, 읽은 뒤 code가 달라진 행도 덮어쓰지 않는다. 재실행은 같은 모델·입력 규칙에서 빠진 벡터를 채우는 용도다. 모델이나 전처리를 바꾸는 경우의 재생성은 별도 합의한다.

다시 조회한다.

```bash
docker exec capstone-db psql -U capstone -d capstone -c "SELECT id, function_name, vector_dims(embedding) AS dimension, vector_norm(embedding) AS norm FROM public.snippets WHERE project_name = 'mvp-save-test' ORDER BY id;"
```

처리한 행은 dimension=768, norm 약 1이어야 한다. 원문·7개 필드가 그대로인지도 대조한다. 길이 초과 코드 등 처리에 실패한 행은 NULL로 남아 검색에서 제외된다. 같은 코드를 여러 번 저장한 행은 서로 다른 DB 행이며 현재 검색은 별도 중복 제거를 하지 않는다.

## 7. 실제 검색과 Extension 연결

Windows Swagger의 GET /search에서 먼저 q와 limit을 입력한다. 모델의 첫 준비가 끝나면 Extension의 10초 요청 제한 때문에 첫 검색이 시간 초과되는 상황을 줄일 수 있다.

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

원본 열기로 실제 파일의 줄 범위를 확인하고, Save Snippet으로 저장한 id의 DB 행과 전송 원문을 대조하면 저장 회귀 확인까지 할 수 있다. 이 새 행도 벡터가 NULL인 상태로 저장되는 것이 현재 동작이다.

## 8. 종료와 오류 확인

Backend를 더 사용하지 않으면 실행 터미널에서 Ctrl+C로 종료한다. DB 데이터는 Docker의 postgres_data volume에 유지된다.

| 증상 | 확인할 내용 |
|---|---|
| DATABASE_URL is not configured | 저장소 루트 .env와 Backend 실행 환경 확인 |
| DB 연결 실패 | DB 실행·health 상태, db/127.0.0.1 구분, 실제 로컬 접속 설정 확인 |
| relation snippets does not exist | 3절의 테이블 존재 확인과 init.sql 적용 |
| embedding 컬럼이 없음 | 기존 DB migration 적용 및 실제 타입 조회 |
| 검색 결과가 없음 | 해당 DB에 벡터가 있는 행이 있는지, 수동 처리 실패가 있었는지 확인 |
| 첫 검색 시간 초과 | 모델 다운로드·로드가 끝났는지 Backend 로그와 Swagger로 확인 |
| torch_dtype deprecated 경고 | 현재 고정 라이브러리에서 보인 경고다. 실제 예외·HTTP 실패 여부와 구분해 확인 |
| Extension 원본 열기 실패 | 실제 로컬 파일, 열린 프로젝트 이름, 상대 경로 확인 |

모델 비교 원본은 [기존 실험 폴더](../rag/experiments/embedding_compare/README.md)에 보존되어 있다. 추가 실행을 했다면 날짜·환경·SHA·실제 응답을 새 기록에 남긴다.
