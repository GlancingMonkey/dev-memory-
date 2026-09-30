# STEP 2 — Embedding 모델 로컬 비교

한국어 질문으로 한국어 문서와 Java/Python/TypeScript 코드를 검색할 Embedding 모델 후보 3개를 비교했다.
2026-10-01에 Windows CPU 환경에서 직접 실행한 결과를 기록한다.

**현재의 짧은 입력·CPU 조건에서는 `intfloat/multilingual-e5-base`를 우선 후보로 선택한다.**
E5와 Qwen은 10개 질문 모두 정답을 1위로 찾았으며, E5의 질문 처리 시간이 가장 짧았다.

## 결과

| 모델 | 전체 정답 1위 | 한국어→코드 정답 1위 | 질문 p50 / p95 (ms) | 문서 처리량 (docs/s) | Dimension |
|---|---:|---:|---:|---:|---:|
| multilingual-e5-base | 10/10 | 4/4 | 50.94 / 59.53 | 15.26 | 768 |
| BGE-M3 | 9/10 | 3/4 | 169.00 / 188.80 | 4.68 | 1024 |
| Qwen3-Embedding-0.6B | 10/10 | 4/4 | 337.45 / 381.15 | 3.31 | 1024 |

세 모델 모두 정답을 Top 3 안에 포함했다. Qwen의 질문 p50은 E5의 약 6.62배였다.
BGE는 한국어 TypeScript 저장 질문에서 읽기 코드를 1위, 정답인 저장 코드를 2위로 찾았다.

[상세 비교표·해석·모델 revision·원본 결과](comparison_results.md)

## 실험 범위와 조건

- 실제 저장 API와 PostgreSQL/pgvector 연결 없이 메모리에서 cosine similarity로 전체 후보를 정렬했다.
- RAG 답변 생성과 reranker는 포함하지 않았다. 코드 샘플은 검색 대상 문자열이며 실행하지 않는다.
- 문서·코드 10개와 질문 10개: 한국어 문서 2문제, 한국어 코드 4문제, 같은 코드에 대한 영어 질문 4문제.
- CPU, FP32, thread 4, 최대 512토큰. 문서 batch 4, 질문 batch 1. 워밍업 후 5회 반복.
- 질문 p50/p95는 embedding 생성 시간이다. 토큰화·정규화·CPU 배열 변환을 포함하며 DB 검색·답변 생성은 포함하지 않는다.
- Python 3.10.2, PyTorch 2.8.0+cpu, Sentence Transformers 5.1.2, Transformers 4.57.1, NumPy 2.2.6.
- 같은 데이터 해시·공통 설정을 확인하고 질문별 순위와 원본 시간에서 지표를 재계산했다.

## 파일

- `benchmark.py`: 모델 1개를 로드하고 검색 순위·품질·처리 시간을 기록하는 최소 실험 코드.
- `samples.json`: 질문과 정답 라벨, 한국어 문서 및 코드 샘플.
- `requirements.txt`: 실험에 사용한 직접 의존성 버전.
- `comparison_results.md`: 실제 결과와 선택 근거.
- `results/`: 세 실행의 `result.json`과 질문별 `per_query.csv`.

## 다시 실행하기 — Windows CMD / PowerShell

저장소를 내려받은 뒤 저장소 루트에서 실행한다. 이 실험은 프로젝트의 주 실행 환경과 별도의 가상환경을 사용한다.
64비트 Python 3.10 또는 3.11이 필요하다. 아래는 실제 측정에 사용한 Python 3.10 기준이다.

```bat
cd rag\experiments\embedding_compare
py -3.10 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe benchmark.py --check-data
```

측정 당시의 모델 commit을 지정하여 모델 가중치 버전을 재현한다. 각 명령을 순서대로 실행한다.

```bat
.\.venv\Scripts\python.exe benchmark.py --model e5 --revision d128750597153bb5987e10b1c3493a34e5a4502a
.\.venv\Scripts\python.exe benchmark.py --model bge --revision 5617a9f61b028005a4858fdac845db406aefb181
.\.venv\Scripts\python.exe benchmark.py --model qwen --revision 97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3
```

최초 다운로드에는 인터넷이 필요하며, 추론은 로컬에서 수행한다.
모델 파일은 `cache/`에 저장하고 Git 기록에서 제외한다. 다운로드가 완료된 뒤에는 같은 명령에 `--offline`을 추가할 수 있다.
새 실행은 별도의 시간별 결과 폴더를 만들며 기록된 세 실행 파일을 덮어쓰지 않는다.
위 파일은 직접 의존성만 고정하므로 전이 의존성과 PC 부하 차이 때문에 결과가 완전히 같지는 않을 수 있다.

## 모델별 입력 규칙과 공식 근거

| 모델 | 비교 역할 | 입력 규칙 | 로컬 실행 결과 |
|---|---|---|---|
| [E5-base](https://huggingface.co/intfloat/multilingual-e5-base) | 한국어 검색 평가가 공개된 다국어 기준선 | 질문 `query: `, 문서·코드 `passage: ` | 동일 Python 환경에서 성공 |
| [BGE-M3](https://huggingface.co/BAAI/bge-m3) | 다국어 문서·코드 혼합 검색 후보; dense vector 비교 | 별도 질문 prefix 없음 | 동일 환경에서 성공 |
| [Qwen3-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) | 다국어·코드 검색 후보 | 질문에 영어 instruction, 문서·코드는 원문 | 동일 환경에서 성공 |

입력 규칙은 코드에서 처리한다. 모델 간 절대 cosine score 크기로 우열을 판단하지 않는다.

## 해석의 범위

이 결과는 작은 예제에서 첫 후보를 정하기 위한 기록이다. 한국어 코드 질문 4개에서는 한 문제 차이가 25%p다.
E5와 Qwen의 동점은 이 데이터에서의 동점이며 전체 코드 검색 성능이 같다는 뜻은 아니다.
긴 함수, GPU, 최대 RAM, 동시 요청, 대규모 벡터 인덱스, 답변 품질은 평가하지 않았다.
다음 품질 검증에서는 실제 프로젝트 질문·함수 20~30개와 비슷한 오답 후보를 사용해 E5와 Qwen을 재비교한다.

