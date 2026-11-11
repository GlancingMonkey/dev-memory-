// logic.ts 단위 테스트 — VS Code 없이 돌아간다: npm run test:unit
import * as assert from 'assert';
import {
  addUsage, adjustEndLine, answerToMarkdown, askCacheKey, AskError, buildAskRequest, endsWithQuestionMark, isVagueQuestion, localDateKey, parseSse, todayUsage, looksLikeQuestion, askErrorFor, clamp, extractCitations, findFunctionNameByRegex, formatSeconds, parseAskResponse, parseSaveResponse, pickSymbol, reindent, SaveUnconfirmedError, SimpleSymbol,
} from '../logic';

const linesOf = (src: string) => {
  const lines = src.split('\n');
  return (i: number) => lines[i] ?? '';
};

suite('findFunctionNameByRegex — 정규식으로 함수 이름 찾기', () => {
  test('python: 위로 올라가서 가장 가까운 def', () => {
    const src = 'def outer():\n    x = 1\n    def inner(a):\n        return a\n';
    assert.strictEqual(findFunctionNameByRegex(linesOf(src), 'python', 3), 'inner');
    assert.strictEqual(findFunctionNameByRegex(linesOf(src), 'python', 1), 'outer');
  });

  test('typescript: 화살표 함수와 메서드', () => {
    assert.strictEqual(findFunctionNameByRegex(linesOf('const add = (a, b) => a + b;'), 'typescript', 0), 'add');
    assert.strictEqual(findFunctionNameByRegex(linesOf('  private load(id: number): void {'), 'typescript', 0), 'load');
  });

  test('java: if (...) { 는 함수로 치지 않는다', () => {
    const src = 'public int sum(int a) {\n  if (a > 0) {\n    return a;';
    assert.strictEqual(findFunctionNameByRegex(linesOf(src), 'java', 2), 'sum');
  });

  test('지원 안 하는 언어 / 못 찾으면 null', () => {
    assert.strictEqual(findFunctionNameByRegex(linesOf('fn main() {}'), 'rust', 0), null);
    assert.strictEqual(findFunctionNameByRegex(linesOf('x = 1'), 'python', 0), null);
  });
});

suite('pickSymbol — 코드 구조에서 커서를 감싸는 함수 고르기', () => {
  const symbols: SimpleSymbol[] = [
    {
      name: 'Calc', kind: 'class', startLine: 0, endLine: 10, children: [
        { name: 'divide', kind: 'function', startLine: 2, endLine: 5, children: [] },
        { name: 'PI', kind: 'other', startLine: 7, endLine: 7, children: [] },
      ],
    },
    { name: 'main', kind: 'function', startLine: 12, endLine: 20, children: [] },
  ];

  test('클래스 안 메서드 → 가장 안쪽 함수', () => {
    const r = pickSymbol(symbols, 3);
    assert.strictEqual(r.fn?.name, 'divide');
    assert.strictEqual(r.cls?.name, 'Calc');
  });

  test('메서드 밖, 클래스 안 → 함수 없음, 클래스만', () => {
    const r = pickSymbol(symbols, 7);
    assert.strictEqual(r.fn, undefined);
    assert.strictEqual(r.cls?.name, 'Calc');
  });

  test('아무것도 안 감싸면 둘 다 없음', () => {
    assert.deepStrictEqual(pickSymbol(symbols, 11), { fn: undefined, cls: undefined });
  });
});

suite('adjustEndLine — 다음 줄 맨 앞에서 끝난 선택 보정', () => {
  test('여러 줄 + 끝이 0열이면 한 줄 뺀다', () => {
    assert.strictEqual(adjustEndLine(0, 4, 0), 3);
  });
  test('끝이 0열이 아니거나 한 줄 선택이면 그대로', () => {
    assert.strictEqual(adjustEndLine(0, 4, 5), 4);
    assert.strictEqual(adjustEndLine(2, 2, 0), 2);
  });
});

suite('reindent — 삽입할 때 들여쓰기 맞추기', () => {
  test('공통 들여쓰기를 걷어내고 둘째 줄부터 prefix', () => {
    const code = '    if b == 0:\n        return None\n    return a / b\n';
    assert.strictEqual(reindent(code, '  ', '\n'), 'if b == 0:\n      return None\n  return a / b');
  });
  test('CRLF 를 받아서 원하는 줄바꿈으로', () => {
    assert.strictEqual(reindent('a\r\n  b\r\n', '', '\r\n'), 'a\r\n  b');
  });
  test('빈 줄은 prefix 없이 빈 줄로', () => {
    assert.strictEqual(reindent('x\n\ny', '\t', '\n'), 'x\n\n\ty');
  });
});

suite('parseSaveResponse — 확정된 저장 API 계약', () => {
  const reply = (status: unknown, error: unknown, id: unknown = 5) => JSON.stringify({
    id, message: 'snippet saved', embedding_status: status, embedding_error: error,
  });

  test('HTTP 200 ready — 실제 ID와 검색 준비 완료', () => {
    assert.deepStrictEqual(parseSaveResponse(reply('ready', null, 37), 200), {
      id: 37, embedding: 'ready', embeddingError: null,
    });
  });

  test('HTTP 200 failed — 세 실패 코드 모두 원문 저장은 유지', () => {
    for (const code of ['embedding_input_invalid', 'embedding_generation_failed', 'embedding_storage_failed']) {
      assert.deepStrictEqual(parseSaveResponse(reply('failed', code)), {
        id: 5, embedding: 'failed', embeddingError: code,
      });
    }
  });

  test('HTTP 503 + 저장된 ID — 저장 실패로 버리지 않고 검색 준비만 미확정', () => {
    assert.deepStrictEqual(parseSaveResponse(reply(null, 'embedding_storage_failed', 37), 503), {
      id: 37, embedding: null, embeddingError: 'embedding_storage_failed',
    });
  });

  test('HTTP 503 + detail만 있음 — 저장 안 됐다고 단정하거나 재전송하지 않음', () => {
    assert.throws(
      () => parseSaveResponse('{"detail":"Snippet storage unavailable"}', 503),
      (err: unknown) => err instanceof SaveUnconfirmedError && err.message.includes('다시 보내지 말고'),
    );
  });

  test('JSON이 아니거나 객체가 아니면 저장 여부 확인 필요', () => {
    for (const text of ['<html>', 'null', '[]', '5']) {
      assert.throws(() => parseSaveResponse(text), SaveUnconfirmedError);
    }
  });

  test('양의 안전한 정수 ID만 저장된 ID로 사용', () => {
    for (const id of ['5', null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => parseSaveResponse(reply('ready', null, id)), SaveUnconfirmedError);
    }
    assert.throws(() => parseSaveResponse('{"message":"snippet saved"}'), SaveUnconfirmedError);
  });

  test('저장 완료 메시지가 없거나 다르면 성공으로 표시하지 않음', () => {
    for (const message of [undefined, 'failed']) {
      assert.throws(() => parseSaveResponse(JSON.stringify({
        id: 5, message, embedding_status: 'ready', embedding_error: null,
      })), SaveUnconfirmedError);
    }
  });

  test('확정 전 별칭 필드는 공식 필드를 대신할 수 없음', () => {
    assert.throws(() => parseSaveResponse('{"id":5,"message":"snippet saved","embedding":{"status":"ready"}}'), SaveUnconfirmedError);
    assert.throws(() => parseSaveResponse('{"id":5,"message":"snippet saved","status":"ready"}'), SaveUnconfirmedError);
  });

  test('pending이나 모르는 상태를 검색 준비 중 또는 완료로 표시하지 않음', () => {
    for (const status of ['pending', 'READY', 'unknown', undefined]) {
      assert.throws(() => parseSaveResponse(reply(status, null)), SaveUnconfirmedError);
    }
  });

  test('상태와 실패 코드의 조합이 계약과 맞아야 함', () => {
    for (const [status, code] of [
      ['ready', 'embedding_storage_failed'], ['failed', null], ['failed', 'server traceback'],
    ]) {
      assert.throws(() => parseSaveResponse(reply(status, code)), SaveUnconfirmedError);
    }
  });

  test('HTTP 상태와 본문의 조합이 맞지 않으면 확인 필요', () => {
    assert.throws(() => parseSaveResponse(reply('ready', null), 503), SaveUnconfirmedError);
    assert.throws(() => parseSaveResponse(reply(null, 'embedding_storage_failed'), 200), SaveUnconfirmedError);
    assert.throws(() => parseSaveResponse(reply('ready', null), 500), SaveUnconfirmedError);
  });

  test('HTTP 422는 요청 검증 오류로 구분', () => {
    assert.throws(() => parseSaveResponse('{"detail":[]}', 422), (err: unknown) =>
      err instanceof Error && !(err instanceof SaveUnconfirmedError) && err.message.includes('422'));
  });
});

suite('기타', () => {
  test('formatSeconds', () => {
    assert.strictEqual(formatSeconds(1834), '1.83초');
  });
  test('clamp — 범위 밖·숫자 아님 처리', () => {
    assert.strictEqual(clamp(50, 1, 20, 10), 20);
    assert.strictEqual(clamp(0, 1, 20, 10), 1);
    assert.strictEqual(clamp(undefined, 1, 20, 10), 10);
    assert.strictEqual(clamp(7.6, 1, 20, 10), 8);
  });
});

suite('AI 질문 — extractCitations / parseAskResponse (POST /ask 제안안)', () => {
  const source = (citation_id: string, id = 1) => ({
    citation_id, id, project_name: 'mvp-save-test', file_path: 'sample.py', language: 'python',
    function_name: 'add', start_line: 1, end_line: 2, code: 'def add(a, b):\n    return a + b', score: 0.84,
  });
  const reply = (over: Record<string, unknown> = {}) => JSON.stringify({
    status: 'answered', answer: 'add 함수입니다 [S1]. 합을 반환합니다 [S1].', sources: [source('S1')],
    model: 'gpt-6.1-sol', usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }, ...over,
  });

  test('인용은 나온 순서대로, 같은 건 한 번만', () => {
    assert.deepStrictEqual(extractCitations('a [S2] b [S1] c [S2] [X1] [S]'), ['S2', 'S1']);
  });

  test('정상 답변 — 출처·모델·사용량 그대로', () => {
    const r = parseAskResponse(reply());
    assert.strictEqual(r.status, 'answered');
    assert.deepStrictEqual(r.citations, ['S1']);
    assert.deepStrictEqual(r.unknownCitations, []);
    assert.strictEqual(r.sources[0].id, 1);
    assert.deepStrictEqual(r.usage, { input_tokens: 100, output_tokens: 20, total_tokens: 120 });
  });

  test('답변에 있지만 sources 에 없는 인용은 따로 표시', () => {
    assert.deepStrictEqual(parseAskResponse(reply({ answer: '[S1] 그리고 [S3]' })).unknownCitations, ['S3']);
  });

  test('근거 부족 — 빈 답변·빈 출처·LLM 미호출 허용', () => {
    const r = parseAskResponse(JSON.stringify({ status: 'insufficient_context', answer: null, sources: [], model: null, usage: null }));
    assert.strictEqual(r.status, 'insufficient_context');
    assert.strictEqual(r.answer, '');
    assert.strictEqual(r.usage, null);
  });

  test('계약과 다른 모양은 format 오류 — 성공으로 표시하지 않음', () => {
    const kind = (text: string) => {
      try { parseAskResponse(text); return 'ok'; } catch (e) { return e instanceof AskError ? e.kind : 'other'; }
    };
    assert.strictEqual(kind('<html>'), 'format');
    assert.strictEqual(kind(reply({ status: 'done' })), 'format');
    assert.strictEqual(kind(reply({ answer: '  ' })), 'format');
    assert.strictEqual(kind(reply({ sources: [{ ...source('S1'), citation_id: '1' }] })), 'format');
    assert.strictEqual(kind(reply({ sources: [{ ...source('S1'), id: 0 }] })), 'format');
    assert.strictEqual(kind(reply({ sources: [{ ...source('S1'), start_line: 3, end_line: 2 }] })), 'format');
    assert.strictEqual(kind(reply({ sources: [source('S1'), source('S1', 2)] })), 'format');
    assert.strictEqual(kind(reply({ usage: { input_tokens: 1 } })), 'format');
  });

  test('HTTP 오류 구분 — 422 / 502 / 503 / 504 / 그 밖', () => {
    const kindOf = (status: number) => {
      try { parseAskResponse('{"detail":"x"}', status); return 'ok'; } catch (e) { return e instanceof AskError ? e.kind : 'other'; }
    };
    assert.strictEqual(kindOf(422), 'input');
    assert.strictEqual(kindOf(502), 'bad_answer');
    assert.strictEqual(kindOf(503), 'unavailable');
    assert.strictEqual(kindOf(504), 'timeout');
    assert.strictEqual(kindOf(500), 'server');
    assert.strictEqual(askErrorFor(503, '').detail.length > 0, true);
  });
});

suite('검색 / AI 질문 구분 — 규칙만, LLM 없음', () => {
  test('끝에 ? 가 있으면 AI 질문 (전각·뒤 공백 포함)', () => {
    assert.strictEqual(endsWithQuestionMark('add 함수는 뭘 반환해?'), true);
    assert.strictEqual(endsWithQuestionMark('정렬 차이가 뭐야？  '), true);
  });
  test('중간에 ? 가 있어도 끝이 아니면 검색 — 삼항·옵셔널 체이닝', () => {
    assert.strictEqual(endsWithQuestionMark('a ? b : c 삼항 연산자 쓰는 코드'), false);
    assert.strictEqual(endsWithQuestionMark('optional chaining ?. 쓰는 부분'), false);
    assert.strictEqual(endsWithQuestionMark('정렬 함수'), false);
  });
  test('질문처럼 생긴 문장 → 제안 대상', () => {
    for (const q of ['두 숫자 더하는 함수 동작 설명해줘', '이 코드 왜 None 을 반환해', '정렬 두 개 차이', 'how does add work']) {
      assert.strictEqual(looksLikeQuestion(q), true, q);
    }
  });
  test('평범한 검색어 → 제안 안 함', () => {
    for (const q of ['정렬 함수', '두 숫자를 더하는 함수', '리스트에서 짝수만 고르기', 'sort users by age', '']) {
      assert.strictEqual(looksLikeQuestion(q), false, q);
    }
  });
});

suite('AI 질문 부가 기능 — 이어서 묻기 · 한 글자씩 · 저장된 답변 · 사용량 · 복사 · 애매한 질문', () => {
  test('요청 본문: 이전 대화가 없으면 예전과 똑같이 {q, limit}', () => {
    assert.deepStrictEqual(buildAskRequest('add 는?', 5), { q: 'add 는?', limit: 5 });
  });
  test('요청 본문: 이전 대화는 최근 2개만, stream 은 켤 때만', () => {
    const h = [{ q: '1', answer: 'a' }, { q: '2', answer: 'b' }, { q: '3', answer: 'x'.repeat(2000) }];
    const body = buildAskRequest('4', 10, h, true) as { history: { q: string; answer: string }[]; stream: boolean };
    assert.deepStrictEqual(body.history.map((x) => x.q), ['2', '3']);
    assert.strictEqual(body.history[1].answer.length, 1500);
    assert.strictEqual(body.stream, true);
  });
  test('history_used: 서버가 주면 숫자, 안 주면 null', () => {
    const base = { status: 'answered', answer: '네', sources: [], model: 'm', usage: null };
    assert.strictEqual(parseAskResponse(JSON.stringify(base)).historyUsed, null);
    assert.strictEqual(parseAskResponse(JSON.stringify({ ...base, history_used: 1 })).historyUsed, 1);
    assert.throws(() => parseAskResponse(JSON.stringify({ ...base, history_used: -1 })), AskError);
  });
  test('SSE 조각 자르기: 덜 온 조각은 rest 로 남긴다 · CRLF · 주석 · 여러 줄 data', () => {
    const a = parseSse('event: sources\ndata: {"sources":[]}\n\nevent: delta\ndata: {"text":"안');
    assert.deepStrictEqual(a.events, [{ event: 'sources', data: '{"sources":[]}' }]);
    const b = parseSse(a.rest + '녕"}\r\n\r\n: ping\n\ndata: a\ndata: b\n\n');
    assert.deepStrictEqual(b.events, [{ event: 'delta', data: '{"text":"안녕"}' }, { event: 'message', data: 'a\nb' }]);
    assert.strictEqual(b.rest, '');
  });
  test('저장된 답변 키: 띄어쓰기·대소문자·끝의 ? 는 같은 질문', () => {
    assert.strictEqual(askCacheKey('  Add   함수 뭐야 ?? '), askCacheKey('add 함수 뭐야'));
    assert.notStrictEqual(askCacheKey('add 함수 뭐야'), askCacheKey('sub 함수 뭐야'));
  });
  test('오늘 사용량: 날짜가 바뀌면 0부터', () => {
    const d1 = localDateKey(new Date(2026, 10, 11, 23, 59));
    assert.strictEqual(d1, '2026-11-11');
    const s1 = addUsage(undefined, d1, 800);
    const s2 = addUsage(s1, d1, 0);
    assert.deepStrictEqual(s2, { date: d1, count: 2, tokens: 800 });
    assert.deepStrictEqual(todayUsage(s2, '2026-11-12'), { date: '2026-11-12', count: 0, tokens: 0 });
    assert.deepStrictEqual(addUsage(s2, '2026-11-12', 10), { date: '2026-11-12', count: 1, tokens: 10 });
  });
  test('답변 복사: 질문 · 답변 · 참고 코드 목록 마크다운', () => {
    const md = answerToMarkdown('add 뭐야?', 'add 입니다 [S1].', [
      { citation_id: 'S1', function_name: 'add', file_path: 'sample.py', start_line: 1, end_line: 2, language: 'python' },
    ]);
    assert.strictEqual(md, '**Q. add 뭐야?**\n\nadd 입니다 [S1].\n\n- [S1] add — sample.py:1-2 (python)');
    assert.ok(answerToMarkdown('q', '', []).includes('근거 부족'));
  });
  test('애매한 질문: 너무 짧거나 내용 없는 말만', () => {
    for (const q of ['함수 ?', '이거 뭐야?', '코드 설명해줘 ?', 'what is this?', '정렬함수?']) {
      assert.strictEqual(isVagueQuestion(q), true, q);
    }
    for (const q of ['정렬하는 함수 어떻게 동작해?', 'add 함수는 뭘 반환해?', '두 숫자 더하는 함수 설명해줘 ?', '']) {
      assert.strictEqual(isVagueQuestion(q), false, q);
    }
  });
});
