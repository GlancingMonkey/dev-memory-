# 11월 18일 마감용 검색·RAG 평가

기존 개발 DB의 함수 5개와 실제 저장소 함수 9개로 만든 코드 14개, 질문 25개다.
정답 코드가 있는 20개와 근거가 없는 5개를 구분한다.
기존 세 모델·10개 질문 비교를 다시 실행하거나 그 결과를 덮어쓰지 않는다.

## 자료와 원본

- samples.json: 저장 7개 필드, 실제 출처·줄 범위·해시, 질문과 사전 정의한 기대 설명.
- seed.py: 기본 읽기 전용 사전 확인, --apply에서만 자료 준비.
- evaluate.py: 기본 실제 E5·DB 검색, --ask에서 실제 모델 계수·답변 전후 비교.
- measure.py: 단계별 시간·usage·후보/선택/제외 ID·원문 대조와 요청 체크포인트.
- [첫 실제 실행](results/2026-11-16-local/summary.json): 기준/개선 각 25개 실행의 원본 기록.
- [검증 해석과 한계](../../../docs/EVALUATION_2026-11-16.md).

일부 코드는 다른 함수·타입·상수를 참조하는 실제 파일의 조각이다.
독립 실행 가능한 예제로 가정하지 않는다.
기존 DB 스니펫의 상대 경로가 이 PC에 존재한다고 가정하지 않는다.
각 실행의 숫자 DB ID 대신 sample_id와 원문·프로젝트·언어를 함께 대조한다.

## 실행

Dev Container Bash의 저장소 루트에서 잠긴 의존성과 기존 .env를 사용한다.
실제 비밀값은 명령·결과·Git에 넣지 않는다.

```bash
uv run --locked python -m rag.experiments.deadline_eval.seed --output out/reports/eval-preflight.json
```

기본은 읽기 전용이다. 필요한 자료를 확인한 뒤 다음 명령을 실행하면,
없는 예시는 기존 POST /snippets로 추가하고 벡터가 없는 일치 행은 같은 ID로 재처리한다.
이미 벡터가 있는 행을 덮어쓰지 않는다.

```bash
uv run --locked python -m rag.experiments.deadline_eval.seed --apply --output out/reports/eval-preparation.json
```

검색만 측정하면 LLM을 호출하지 않는다.

```bash
uv run --locked python -m rag.experiments.deadline_eval.evaluate --output out/reports/search-evaluation
```

다음 명령은 실제 계수 API와 유료 답변 생성을 사용한다.
25개 질문을 기준·개선에 각 1회씩, 최대 50회 생성하며 자동 재시도하지 않는다.
먼저 1개만 확인하려면 --max-questions 1을 지정하고 별도 결과 경로를 사용한다.

```bash
uv run --locked python -m rag.experiments.deadline_eval.evaluate --ask --budget-probe --output out/reports/rag-evaluation
```

기존 출력 파일은 덮어쓰지 않는다. 시작된 요청의 완료가 확인되지 않으면
해당 체크포인트를 자동 재실행하지 않는다. 과금·로그·결과를 확인하기 전에 체크포인트를 지우지 않는다.
동일한 코드·DB·샘플·설정일 때만 완료된 파일을 재사용한다.
서비스 실패가 반복되면 추가 생성을 중단하고 검색 결과만 기록한다.

## 비교 조건

- 기준: 이전 전체 스니펫 예산 선택, deduplicate=False.
- 개선: 같은 프로젝트·언어에서 줄바꿈만 다른 동일 코드를 묶어 선택.
- 두 방식 모두 같은 후보 순서, 모델·지시문·추론·출력 제한·4000 참고 자료 예산·8000 전체 입력 제한을 사용한다.
- 동일 요청 내 토큰 계수 재사용은 두 방식 모두 적용한다. 전체 이전 앱과 개선 앱의 비교라고 부르지 않는다.
- 질문별 실행 순서는 번갈아 배치한다. 각 1회 관측이므로 시간 변동이나 모델 비결정성을 제거한 실험이 아니다.
- 참고 자료 토큰, 최종 입력 계수, 실제 provider usage를 구분한다.
- HTTP 502처럼 응답이 실패해도 알려진 provider usage를 누락하지 않는다.
- 문법·인용 ID 검사와 답변 내용의 정확성 검토는 별도로 기록한다.
- 512토큰 budget-probe는 실제 계수로 전체 스니펫 경계를 확인하는 별도 검사다. 운영 예산 4000을 바꾸지 않으며 답변을 생성하지 않는다.
- 직접 호출한 FastAPI 처리 시간이며 TCP·Windows UI 시간은 포함하지 않는다.
- 작은 내부 데이터셋의 결과이며 전체 실무 품질·경쟁 제품 우위를 증명하지 않는다.
