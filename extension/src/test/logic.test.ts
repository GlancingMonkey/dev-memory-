// logic.ts 단위 테스트 — VS Code 없이 돌아간다: npm run test:unit
import * as assert from 'assert';
import {
  addUsage, adjustEndLine, groupDuplicates, parseDeleteResponse, canSendKey, guessProvider, maskKey, validateKey, evalToCsv, evalToMarkdown, EvalRow, parseEvalQuestions, rankOf, summarizeEval, compareSource, maskSecrets, scanSecrets, buildSearchUrl, checkAppliedFilter, errorDetailText, filterLocally, hasFilter, normalizeFilter, parseFilterOptions, answerToMarkdown, askCacheKey, AskError, buildAskRequest, endsWithQuestionMark, isVagueQuestion, localDateKey, parseSse, todayUsage, looksLikeQuestion, askErrorFor, clamp, extractCitations, findFunctionNameByRegex, formatSeconds, isStorageUnavailable, parseAskResponse, parseSaveResponse, pickSymbol, reindent, SaveUnconfirmedError, SimpleSymbol,
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

suite('검색 필터 — GET /search?project=&language= · GET /filters', () => {
  test('조건 정리: 앞뒤 공백 제거, 언어만 소문자, 빈 값 = 조건 없음', () => {
    assert.deepStrictEqual(normalizeFilter({ project: '  My-Proj ', language: ' Python ' }), { project: 'My-Proj', language: 'python', concept: '' });
    assert.strictEqual(hasFilter(normalizeFilter({ project: '   ', language: '' })), false);
    assert.strictEqual(hasFilter(normalizeFilter({ concept: ' loop ' })), true);
    assert.strictEqual(hasFilter(normalizeFilter(undefined)), false);
  });
  test('주소: 조건 없으면 예전과 같고, 있으면 붙인다 (한글·공백 인코딩)', () => {
    const none = normalizeFilter({});
    assert.strictEqual(buildSearchUrl('http://h:8000/', '정렬 함수', 10, none), 'http://h:8000/search?q=%EC%A0%95%EB%A0%AC+%ED%95%A8%EC%88%98&limit=10');
    const u = new URL(buildSearchUrl('http://h:8000', 'a', 5, normalizeFilter({ project: 'demo project', language: 'Python' })));
    assert.strictEqual(u.searchParams.get('project'), 'demo project');
    assert.strictEqual(u.searchParams.get('language'), 'python');
  });
  test('서버가 조건을 적용했는지: filters 를 돌려주면 applied, 없거나 다르면 ignored', () => {
    const f = normalizeFilter({ project: 'p', language: 'python' });
    assert.strictEqual(checkAppliedFilter(f, { project: 'p', language: 'python' }), 'applied');
    assert.strictEqual(checkAppliedFilter(f, undefined), 'ignored');
    assert.strictEqual(checkAppliedFilter(f, { project: 'p', language: null }), 'ignored');
    assert.strictEqual(checkAppliedFilter(normalizeFilter({}), undefined), 'none');
    assert.strictEqual(checkAppliedFilter(normalizeFilter({ language: 'python' }), { project: null, language: 'Python' }), 'applied');
  });
  test('화면에서만 거르기 (옛 서버 대비)', () => {
    const rows = [{ project_name: 'a', language: 'python' }, { project_name: 'b', language: 'Python' }, { project_name: 'a', language: 'go' }];
    assert.strictEqual(filterLocally(rows, normalizeFilter({ project: 'a' })).length, 2);
    assert.strictEqual(filterLocally(rows, normalizeFilter({ language: 'python' })).length, 2);
    assert.strictEqual(filterLocally(rows, normalizeFilter({ project: 'a', language: 'python' })).length, 1);
    // 개념은 결과에 concepts 가 없으니 코드에서 찾은 개념으로 거른다
    assert.strictEqual(filterLocally(rows, normalizeFilter({ concept: 'loop' }), (r) => (r.project_name === 'a' ? ['loop'] : [])).length, 2);
  });
  test('/filters: {name,count} 또는 이름 배열, 빈 이름·중복은 건너뜀', () => {
    const a = parseFilterOptions(JSON.stringify({ projects: [{ name: 'p1', count: 3 }, { name: 'p1', count: 1 }, { name: '' }], languages: ['python', 'go'] }));
    assert.deepStrictEqual(a.projects, [{ name: 'p1', count: 3 }]);
    assert.deepStrictEqual(a.languages, [{ name: 'python', count: null }, { name: 'go', count: null }]);
    assert.throws(() => parseFilterOptions('{"projects":[]}'));
    assert.throws(() => parseFilterOptions('<html>'));
  });
  test('오류 detail: 문자열 · {code,message} · FastAPI 검증 배열', () => {
    assert.strictEqual(errorDetailText({ detail: '검색 질문을 입력해주세요.' }), '검색 질문을 입력해주세요.');
    assert.strictEqual(errorDetailText({ detail: { code: 'ask_timeout', message: '시간 초과' } }), '시간 초과');
    assert.strictEqual(errorDetailText({ detail: [{ msg: 'a' }, { msg: 'b' }] }), 'a / b');
    assert.strictEqual(errorDetailText(null), '');
  });
  test('/ask 오류 detail 이 객체여도 메시지를 보여준다', () => {
    try {
      parseAskResponse(JSON.stringify({ detail: { code: 'ask_service_unavailable', message: 'AI 질문을 처리할 수 없습니다.' } }), 503);
      assert.fail('throw 해야 함');
    } catch (e) {
      assert.ok(e instanceof AskError);
      assert.strictEqual((e as AskError).kind, 'unavailable');
      assert.strictEqual((e as AskError).detail, 'AI 질문을 처리할 수 없습니다.');
    }
  });
});

suite('저장 전 비밀값 감지 — scanSecrets / maskSecrets', () => {
  test('모양으로 알 수 있는 키 + 이름이 수상한 변수', () => {
    const code = 'def call():\n    key = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx12"\n    db_password = "hunter2!"\n    return 1';
    const f = scanSecrets(code);
    assert.deepStrictEqual(f.map((x) => [x.kind, x.line]), [['api_key', 2], ['password', 3]]);
    const masked = maskSecrets(code, f);
    assert.ok(masked.includes('"sk-proj-****"'), masked);
    assert.ok(masked.includes('db_password = "****"'), masked);
    assert.ok(!masked.includes('hunter2'));
    assert.strictEqual(masked.split('\n').length, 4);
  });
  test('AWS · GitHub · Google · Slack · JWT · 주소 안 비밀번호 · 개인 키', () => {
    const code = [
      'a = "AKIAABCDEFGHIJKLMNOP"',
      'b = "ghp_' + 'a'.repeat(36) + '"',
      'c = "AIza' + 'b'.repeat(35) + '"',
      'd = "xoxb-1234567890-abcdef"',
      'e = "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q"',
      'url = "postgres://admin:S3cr3tPw@db:5432/app"',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const kinds = scanSecrets(code).map((x) => x.kind);
    assert.deepStrictEqual(kinds, ['api_key', 'api_key', 'api_key', 'api_key', 'jwt', 'url_password', 'private_key']);
    const masked = maskSecrets(code, scanSecrets(code));
    assert.ok(masked.includes('postgres://admin:****@db'), masked);
    assert.ok(masked.includes('-----BEGIN RSA PRIVATE KEY-----\n****\n-----END'), masked);
    assert.ok(!masked.includes('MIIEow'));
  });
  test('예시·자리표시 값과 환경변수는 비밀값으로 안 봄', () => {
    const code = [
      'password = "****"', 'api_key = "<your-key>"', 'token = "${TOKEN}"', 'secret = os.environ["SECRET"]',
      'password = ""', 'API_KEY = "changeme"', 'url = "postgres://user:<password>@host/db"', 'pwd = input()',
    ].join('\n');
    assert.deepStrictEqual(scanSecrets(code), []);
  });
  test('비밀값 없으면 코드 그대로', () => {
    const code = 'def add(a, b):\n    return a + b';
    assert.strictEqual(maskSecrets(code, scanSecrets(code)), code);
  });
});

suite('원본 변경 감지 — compareSource', () => {
  const saved = 'def add(a, b):\n    return a + b';
  test('같은 자리에 그대로 (CRLF·끝 공백 무시)', () => {
    assert.deepStrictEqual(compareSource(saved, 'def add(a, b):   \r\n    return a + b\r\n\r\nx = 1', 1, 2), { state: 'same' });
  });
  test('위에 코드가 추가돼서 내려감 → 위치 이동', () => {
    assert.deepStrictEqual(compareSource(saved, 'import os\n\n\ndef add(a, b):\n    return a + b\n', 1, 2), { state: 'moved', start: 4, end: 5 });
  });
  test('내용이 바뀜', () => {
    assert.deepStrictEqual(compareSource(saved, 'def add(a, b, c=0):\n    return a + b + c\n', 1, 2), { state: 'changed' });
  });
  test('같은 코드가 여러 곳이면 원래 자리에서 가까운 곳', () => {
    const file = 'def add(a, b):\n    return a + b\n#\n#\n#\n#\ndef add(a, b):\n    return a + b';
    assert.deepStrictEqual(compareSource(saved, file, 6, 7), { state: 'moved', start: 7, end: 8 });
  });
});

suite('성능 평가 — 질문 파일 · Hit@1/Hit@3 · 내보내기', () => {
  test('질문 파일: {questions:[…]} 또는 배열, id 없으면 Q1…, expected 숫자 하나도 허용', () => {
    const a = parseEvalQuestions(JSON.stringify({ questions: [{ q: ' 더하기 ', expected: [12] }, { id: 'X', q: 'JWT', expected: [] }, { q: '정렬', expected: 3 }] }));
    assert.deepStrictEqual(a.map((x) => [x.id, x.q, x.expected]), [['Q1', '더하기', [12]], ['X', 'JWT', []], ['Q3', '정렬', [3]]]);
    assert.throws(() => parseEvalQuestions('{"questions":[{"q":""}]}'), /q 가 비어/);
    assert.throws(() => parseEvalQuestions('{"questions":[{"q":"a","expected":["x"]}]}'), /양의 정수/);
    assert.throws(() => parseEvalQuestions('[]'));
  });
  test('순위: 정답 중 처음 나온 위치', () => {
    assert.strictEqual(rankOf([12], [3, 12, 5]), 2);
    assert.strictEqual(rankOf([5, 9], [9, 5]), 1);
    assert.strictEqual(rankOf([7], [1, 2]), null);
  });
  const rows: EvalRow[] = [
    { id: 'Q1', q: 'a', expected: [1], rank: 1, topIds: [1], searchMs: 100, ask: { status: 'answered', ms: 4000, totalTokens: 1000, citations: 1 } },
    { id: 'Q2', q: 'b', expected: [2], rank: 3, topIds: [9, 8, 2], searchMs: 300, ask: { status: 'answered', ms: 6000, totalTokens: 1400, citations: 2 } },
    { id: 'Q3', q: 'c', expected: [3], rank: null, topIds: [9], searchMs: 200 },
    { id: 'Q4', q: 'd', expected: [], rank: null, topIds: [9], searchMs: 400, ask: { status: 'insufficient_context', ms: 1000, totalTokens: null, citations: 0 } },
    { id: 'Q5', q: 'e', expected: [5], rank: null, topIds: [], searchMs: null, searchError: '연결 안 됨' },
  ];
  test('요약: Hit@1·Hit@3 은 정답 있고 검색 성공한 질문만, 근거 부족은 정답 없는 질문으로', () => {
    const s = summarizeEval(rows);
    assert.strictEqual(s.withAnswer, 3);
    assert.strictEqual(s.hit1, 1);
    assert.strictEqual(s.hit3, 2);
    assert.strictEqual(s.missed, 1);
    assert.strictEqual(s.meanRank, 2);
    assert.deepStrictEqual(s.buckets, { first: 1, top3: 1, top10: 0, missed: 1 });
    assert.strictEqual(s.searchFailed, 1);
    assert.strictEqual(s.searchAvgMs, 250);
    assert.strictEqual(s.searchP95Ms, 400);
    assert.strictEqual(s.asked, 3);
    assert.strictEqual(s.askAvgTokens, 1200);
    assert.strictEqual(s.noAnswerCorrect, 1);
    assert.strictEqual(s.noAnswerTotal, 1);
  });
  test('CSV · 마크다운', () => {
    const csv = evalToCsv([{ id: 'Q1', q: 'a, "b"', expected: [1], rank: 1, topIds: [1, 2], searchMs: 10 }]);
    assert.ok(csv.split('\n')[1].startsWith('Q1,"a, ""b""",1,1,1,1,10,1 2'), csv);
    const md = evalToMarkdown(rows, summarizeEval(rows), '실제 서버');
    assert.ok(md.includes('| 한 번에 찾음 (Hit@1) | 33% (1/3) |'), md);
    assert.ok(md.includes('| 모르는 건 모른다고 함 | 1/1 |'));
    assert.ok(md.includes('| Q3 | c | 3 | 못 찾음 |'));
  });
});

suite('사용자 AI 키 — 회사 짐작 · 가리기 · 보내도 되는 주소', () => {
  test('키 모양으로 회사 짐작', () => {
    assert.strictEqual(guessProvider('sk-ant-api03-abcdefghijklmnop'), 'anthropic');
    assert.strictEqual(guessProvider('AIzaSyA1234567890abcdefghijklmnopqrstu'), 'google');
    assert.strictEqual(guessProvider('sk-proj-abcdefghijklmnop'), 'openai');
    assert.strictEqual(guessProvider('hello'), null);
  });
  test('가리기: 앞부분 + 끝 4자리', () => {
    assert.strictEqual(maskKey('sk-proj-abcdefghijklmnopa1b2'), 'sk-proj-…a1b2');
    assert.strictEqual(maskKey('AIzaSyA1234567890abcdefghijklmnopqrstu'), 'AIza…rstu');
    assert.strictEqual(maskKey('short'), '****');
  });
  test('localhost 나 https 일 때만 키를 보낸다', () => {
    assert.strictEqual(canSendKey('http://localhost:8000'), true);
    assert.strictEqual(canSendKey('http://127.0.0.1:8000'), true);
    assert.strictEqual(canSendKey('https://api.example.com'), true);
    assert.strictEqual(canSendKey('http://192.168.0.5:8000'), false);
    assert.strictEqual(canSendKey('not a url'), false);
  });
  test('키 검사', () => {
    assert.strictEqual(validateKey(''), '키를 붙여넣으세요');
    assert.ok(validateKey('sk-abc def ghij klmnop qrst'));
    assert.strictEqual(validateKey('sk-proj-abcdefghijklmnop'), null);
  });
  test('401·403 은 키 오류로', () => {
    assert.strictEqual(parseAskErrKind(401), 'key');
    assert.strictEqual(parseAskErrKind(403), 'key');
  });
});
function parseAskErrKind(status: number): string {
  try {
    parseAskResponse(JSON.stringify({ detail: { code: 'llm_key_invalid', message: 'x' } }), status);
  } catch (e) {
    return (e as AskError).kind;
  }
  return '';
}

suite('groupDuplicates — 같은 코드 묶기', () => {
  const r = (id: number, code: string) => ({ id, code });
  test('같은 코드는 앞의 것 하나로 묶고 순서 유지', () => {
    const g = groupDuplicates([r(41, 'def a():\n  return 1'), r(39, 'def b(): pass'), r(40, 'def a():\n  return 1')]);
    assert.deepStrictEqual(g.map((x) => [x.head.id, x.dups.map((d) => d.id)]), [[41, [40]], [39, []]]);
  });
  test('줄바꿈 종류·줄 끝 공백·앞뒤 빈 줄은 무시', () => {
    const g = groupDuplicates([r(1, 'x = 1\ny = 2'), r(2, '\nx = 1  \r\ny = 2\n\n')]);
    assert.strictEqual(g.length, 1);
    assert.strictEqual(g[0].dups.length, 1);
  });
  test('들여쓰기나 내용이 다르면 따로', () => {
    assert.strictEqual(groupDuplicates([r(1, 'x = 1'), r(2, '  x = 1'), r(3, 'x = 2')]).length, 3);
  });
  test('객체 기본 속성 이름 같은 코드도 깨지지 않음 (constructor·__proto__·toString)', () => {
    for (const c of ['constructor', '__proto__', 'toString']) {
      assert.strictEqual(groupDuplicates([r(1, c)]).length, 1, c + ' 단일');
      const g = groupDuplicates([r(1, c), r(2, c)]);
      assert.deepStrictEqual(g.map((x) => [x.head.id, x.dups.map((d) => d.id)]), [[1, [2]]], c + ' 중복');
    }
  });
  test('빈 코드는 묶지 않음', () => {
    assert.strictEqual(groupDuplicates([r(1, ''), r(2, '')]).length, 2);
  });
  test('웹페이지에 넣을 수 있게 혼자 돌아감', () => {
    const fn = new Function('return ' + groupDuplicates.toString())() as typeof groupDuplicates;
    assert.strictEqual(fn([r(1, 'a'), r(2, 'a')]).length, 1);
  });
});

suite('parseDeleteResponse — 저장 코드 삭제 응답', () => {
  test('200·204 는 지움', () => {
    assert.strictEqual(parseDeleteResponse(204, ''), 'deleted');
    assert.strictEqual(parseDeleteResponse(200, '{"deleted":true}'), 'deleted');
  });
  test('404 는 이미 없음', () => {
    assert.strictEqual(parseDeleteResponse(404, '{"detail":"not found"}'), 'missing');
  });
  test('422 는 잘못된 ID, 503 은 삭제 확인 실패', () => {
    assert.throws(() => parseDeleteResponse(422, '{"detail":"invalid id"}'), /잘못된 ID/);
    assert.throws(() => parseDeleteResponse(503, ''), /확인하지 못했어요/);
  });
  test('405 는 서버에 기능 없음 안내', () => {
    assert.throws(() => parseDeleteResponse(405, '{"detail":"Method Not Allowed"}'), /DELETE \/snippets/);
  });
  test('그 밖은 서버 사유를 붙여 오류', () => {
    assert.throws(() => parseDeleteResponse(500, '{"detail":{"code":"db","message":"DB 연결 실패"}}'), /HTTP 500.*DB 연결 실패/);
  });
});

suite('개념 필터 — GET /search?concept= · POST /snippets concepts (PR #75)', () => {
  test('주소에 개념 ID 를 붙이고, 응답 filters.concept 가 같아야 적용으로 본다', () => {
    const f = normalizeFilter({ language: 'python', concept: 'list_comp' });
    assert.strictEqual(new URL(buildSearchUrl('http://h', 'a', 5, f)).searchParams.get('concept'), 'list_comp');
    assert.strictEqual(checkAppliedFilter(f, { project: null, language: 'python', concept: 'list_comp' }), 'applied');
    assert.strictEqual(checkAppliedFilter(f, { project: null, language: 'python' }), 'ignored');
    assert.strictEqual(checkAppliedFilter(normalizeFilter({ language: 'python' }), { project: null, language: 'python' }), 'applied');
  });
  test('개념을 뺀 재저장은 id 없는 503 일 때만', () => {
    assert.strictEqual(isStorageUnavailable('{"detail":"Snippet storage unavailable"}', 503), true);
    assert.strictEqual(isStorageUnavailable('{"id":7,"message":"snippet saved","embedding_status":null,"embedding_error":"embedding_storage_failed"}', 503), false);
    assert.strictEqual(isStorageUnavailable('{"detail":"x"}', 500), false);
    assert.strictEqual(isStorageUnavailable('<html>', 503), false);
  });
});
