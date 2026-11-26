// 공부 모드 단위 테스트 — 개념 찾기 · 간격 반복
import * as assert from 'assert';
import { detectConcepts, dueCards, scheduleNext, STUDY_CONCEPTS, studyLangOf } from '../study';

const ids = (code: string, lang: string, fn: string | null = null) => detectConcepts(code, lang, fn, STUDY_CONCEPTS).map((h) => h.id);

suite('detectConcepts — 코드에 쓰인 개념', () => {
  test('리스트 컴프리헨션 · 나머지 연산 (파이썬)', () => {
    const got = ids('def even_numbers(values):\n    return [n for n in values if n % 2 == 0]', 'python', 'even_numbers');
    assert.ok(got.includes('list_comp'));
    assert.ok(got.includes('modulo'));
    assert.ok(!got.includes('recursion'));
  });
  test('줄 번호는 0부터', () => {
    const h = detectConcepts('x = 1\ny = [a for a in b]', 'python', null, STUDY_CONCEPTS).find((x) => x.id === 'list_comp');
    assert.deepStrictEqual(h?.lines, [1]);
  });
  test('재귀는 함수 이름이 몸통에서 다시 불릴 때만', () => {
    const code = 'def fact(n):\n    if n <= 1:\n        return 1\n    return n * fact(n - 1)';
    assert.ok(ids(code, 'python', 'fact').includes('recursion'));
    assert.ok(!ids(code, 'python', 'other').includes('recursion'));
    assert.ok(!ids('def fact(n):\n    return math.fact(n)', 'python', 'fact').includes('recursion'));
  });
  test('주석 줄은 건너뜀', () => {
    assert.ok(!ids('# [x for x in y]\nreturn 1', 'python').includes('list_comp'));
  });
  test('JS 개념은 TS 에도, TS 전용은 JS 에 안 나옴', () => {
    const code = 'export function evens<T>(xs: number[]): number[] {\n  return xs.filter((n) => n % 2 === 0);\n}';
    const ts = ids(code, 'typescript');
    ['array_methods', 'arrow', 'strict_eq', 'ts_types', 'generics', 'modulo'].forEach((id) => assert.ok(ts.includes(id), id));
    const js = ids('const evens = (xs) => xs.filter((n) => n % 2 === 0);', 'javascript');
    assert.ok(js.includes('array_methods'));
    assert.ok(!js.includes('ts_types'));
  });
  test('f-문자열 · try · None · sort key', () => {
    const code = 'def f(users):\n    try:\n        best = max(users, key=lambda u: u.age)\n    except ValueError:\n        return None\n    return f"{best.name}"';
    const got = ids(code, 'python');
    ['try_except', 'sort_key', 'lambda', 'none_check', 'fstring'].forEach((id) => assert.ok(got.includes(id), id));
  });
  test('모르는 언어는 빈 목록', () => {
    assert.deepStrictEqual(ids('for x in y', 'rust'), []);
    assert.strictEqual(studyLangOf('typescriptreact'), 'ts');
    assert.strictEqual(studyLangOf('go'), null);
  });
  test('모든 패턴이 정규식으로 만들어지고 id 가 겹치지 않음', () => {
    const seen = new Set<string>();
    STUDY_CONCEPTS.forEach((c) => {
      assert.ok(!seen.has(c.id), c.id);
      seen.add(c.id);
      if (c.pattern) { assert.doesNotThrow(() => new RegExp(c.pattern), c.id); }
      c.prereq.forEach((p) => assert.ok(STUDY_CONCEPTS.some((x) => x.id === p), c.id + ' → ' + p));
      assert.ok(/^https:\/\//.test(c.doc), c.id);
    });
  });
  test('웹페이지에 넣을 수 있게 혼자 돌아감', () => {
    const fn = new Function('return ' + detectConcepts.toString())() as typeof detectConcepts;
    assert.ok(fn('[a for a in b]', 'python', null, STUDY_CONCEPTS).some((h) => h.id === 'list_comp'));
  });
});

suite('scheduleNext — 간격 반복', () => {
  const now = new Date(2026, 10, 25, 15, 0, 0);
  const days = (iso: string) => Math.round((new Date(iso).getTime() - new Date(2026, 10, 25, 4, 0, 0).getTime()) / 86400000);
  test('처음: 모름 1일 · 헷갈림 2일 · 알겠음 3일', () => {
    assert.strictEqual(scheduleNext(null, 'again', now).interval, 1);
    assert.strictEqual(scheduleNext(null, 'hard', now).interval, 2);
    const g = scheduleNext(null, 'good', now);
    assert.strictEqual(g.interval, 3);
    assert.strictEqual(days(g.due), 3);
  });
  test('알겠음이 이어지면 2.5배씩, 최대 180일', () => {
    let s = scheduleNext(null, 'good', now);
    s = scheduleNext(s, 'good', now);
    assert.strictEqual(s.interval, 8);
    s = scheduleNext(s, 'good', now);
    assert.strictEqual(s.interval, 20);
    assert.strictEqual(scheduleNext({ interval: 150, reps: 5 }, 'good', now).interval, 180);
  });
  test('모름은 1일로 돌아가고 틀린 횟수 +1', () => {
    const s = scheduleNext({ interval: 20, reps: 3, lapses: 0 }, 'again', now);
    assert.deepStrictEqual([s.interval, s.reps, s.lapses], [1, 0, 1]);
  });
  test('헷갈림은 조금만 늘림', () => {
    assert.strictEqual(scheduleNext({ interval: 10, reps: 2 }, 'hard', now).interval, 12);
    assert.strictEqual(scheduleNext({ interval: 1, reps: 0 }, 'hard', now).interval, 2);
  });
  test('오늘 복습할 것만, 오래 밀린 순', () => {
    const cards = [{ k: 'a', due: '2026-11-20T00:00:00Z' }, { k: 'b', due: '2026-12-30T00:00:00Z' }, { k: 'c', due: '2026-11-10T00:00:00Z' }, { k: 'd' }];
    assert.deepStrictEqual(dueCards(cards, new Date('2026-11-25T00:00:00Z')).map((c) => c.k), ['c', 'a']);
  });
});

suite('AI 개념 · 개념 지도 · 리포트 · 노트', () => {
  const S = require('../study') as typeof import('../study');
  const ids = S.STUDY_CONCEPTS.map((c) => c.id);
  test('AI 응답 — 모양이 틀린 항목은 버리고 모르는 id 는 null', () => {
    const got = S.parseAiConcepts({ concepts: [
      { id: 'list_comp', name: '리스트 컴프리헨션', level: 2, summary: 's', in_this_code: 'h', lines: [2, 'x', 0], prereq: ['반복문'] },
      { id: 'nope', name: '순수 함수', level: 9 },
      { name: '' }, 'x', { name: '순수 함수' },
    ] }, ids);
    assert.strictEqual(got.length, 2);
    assert.deepStrictEqual(got[0].lines, [2]);
    assert.strictEqual(got[1].id, null);
    assert.strictEqual(got[1].level, 2);
    assert.throws(() => S.parseAiConcepts({}, ids), /concepts/);
  });
  test('지도 상태 — 약함 · 처음 봄 · 탄탄 · 다음 추천 · 아직', () => {
    const cards = [
      { key: 'a', last: 'good', concepts: ['loop', 'condition'] },
      { key: 'b', last: 'hard', concepts: ['modulo'] },
      { key: 'c', last: 'good', concepts: ['list_comp'] },
    ];
    const nodes = S.buildConceptGraph(cards, { list_comp: 'new' }, S.STUDY_CONCEPTS);
    const st = (id: string) => nodes.find((n) => n.id === id)?.status;
    assert.strictEqual(st('loop'), 'ok');
    assert.strictEqual(st('modulo'), 'weak');
    assert.strictEqual(st('list_comp'), 'new');
    assert.strictEqual(st('generator'), 'next');      // 먼저 알 것: 반복문 (탄탄)
    assert.strictEqual(st('dict_comp'), 'todo');      // 먼저 알 것: 리스트 컴프리헨션 (처음 봄)
  });
  test('AI 개념은 ai: 마디로, 이름이 같은 목록 개념에 붙고 선수 개념 이름을 이어줌', () => {
    const nodes = S.buildConceptGraph([{ key: 'a', last: 'good', concepts: [], ai: [
      { id: null, name: '순수 함수', level: 2, prereq: ['반복문'] }, { id: null, name: '재귀', prereq: [] },
    ] }], {}, S.STUDY_CONCEPTS);
    const pure = nodes.find((n) => n.id === 'ai:순수 함수');
    assert.ok(pure && pure.ai && pure.count === 1);
    assert.deepStrictEqual(pure?.prereq, ['loop']);
    assert.strictEqual(nodes.find((n) => n.id === 'recursion')?.count, 1);
  });
  test('학습 경로 — 선수 개념부터 순서대로', () => {
    const nodes = S.buildConceptGraph([], {}, S.STUDY_CONCEPTS);
    const path = S.learningPath('dict_comp', nodes).map((n) => n.id);
    assert.strictEqual(path[path.length - 1], 'dict_comp');
    assert.ok(path.indexOf('list_comp') < path.indexOf('dict_comp'));
    assert.ok(path.indexOf('loop') < path.indexOf('list_comp'));
    assert.ok(path.indexOf('condition') < path.indexOf('list_comp'));
  });
  test('이번 주 리포트 — 최근 7일 틀린 개념, 30일 넘게 안 본 코드', () => {
    const now = new Date('2026-11-25T12:00:00Z');
    const r = S.weeklyReport([
      { key: 'a', name: 'a', lastAt: '2026-11-24T00:00:00Z', concepts: ['modulo', 'loop'], history: [{ at: '2026-11-24T00:00:00Z', grade: 'again' }, { at: '2026-11-01T00:00:00Z', grade: 'again' }] },
      { key: 'b', name: 'b', lastAt: '2026-10-01T00:00:00Z', concepts: ['modulo'], history: [{ at: '2026-11-23T00:00:00Z', grade: 'hard' }] },
    ], now);
    assert.deepStrictEqual(r.weak[0], { id: 'modulo', misses: 2 });
    assert.deepStrictEqual(r.stale.map((c) => c.key), ['b']);
    assert.strictEqual(r.reviewed, 2);
  });
  test('공부 노트 — 개념·오해·내 코드가 들어감', () => {
    const cards = [{ key: 'a', name: 'even_numbers', file_path: 'e.py', language: 'python', code: 'return [n for n in v]', last: 'good', concepts: ['list_comp'] }];
    const md = S.studyNotesMarkdown(cards, S.buildConceptGraph(cards, {}, S.STUDY_CONCEPTS), S.STUDY_CONCEPTS, new Date());
    assert.ok(md.includes('### 리스트 컴프리헨션'));
    assert.ok(md.includes('흔한 오해'));
    assert.ok(md.includes('```python'));
  });
  test('모든 개념에 흔한 오해·비교가 있음', () => {
    S.STUDY_CONCEPTS.forEach((c) => { assert.ok(c.misconception && c.contrast, c.id); });
  });
  test('지도·리포트 함수도 웹페이지에 넣을 수 있게 혼자 돌아감', () => {
    const g = new Function('return ' + S.buildConceptGraph.toString())() as typeof S.buildConceptGraph;
    assert.ok(g([{ key: 'a', last: 'good', concepts: ['loop'] }], {}, S.STUDY_CONCEPTS).length > 30);
    const w = new Function('return ' + S.weeklyReport.toString())() as typeof S.weeklyReport;
    assert.strictEqual(w([], new Date()).reviewed, 0);
    const p = new Function('return ' + S.learningPath.toString())() as typeof S.learningPath;
    assert.ok(p('loop', g([], {}, S.STUDY_CONCEPTS)).length === 1);
  });
});

suite('parseStudyResult — 문제·다른 언어로·내 말로·왜·리뷰·과제·버그·실행', () => {
  const S = require('../study') as typeof import('../study');
  const P = S.parseStudyResult;
  test('문제 — 정답 번호가 보기 밖이거나 보기가 1개면 버림', () => {
    const r = P('quiz', { questions: [
      { kind: 'output', prompt: 'p', choices: ['a', 'b'], answer: 1, explain: 'e' },
      { prompt: 'x', choices: ['a'], answer: 0 }, { prompt: 'y', choices: ['a', 'b'], answer: 5 },
    ] }) as { questions: { kind: string }[] };
    assert.strictEqual(r.questions.length, 1);
    assert.throws(() => P('quiz', { questions: [] }), /문제가 없/);
  });
  test('내 말로 — verdict 는 ok·partial·wrong 만, 줄 번호는 1 이상', () => {
    const r = P('explain', { points: [{ verdict: 'ok', text: 'a', lines: [2, 0, 'x'] }, { verdict: '??', text: 'b' }] }) as { points: { verdict: string; lines: number[] }[] };
    assert.deepStrictEqual(r.points.map((p) => p.verdict), ['ok', 'partial']);
    assert.deepStrictEqual(r.points[0].lines, [2]);
  });
  test('왜 — 문서는 https 만', () => {
    const r = P('why', { alternatives: [{ label: 'a', code: 'x' }], complexity: { time: 'O(n)' }, deeper: [{ title: 't', text: 'x', doc: 'javascript:alert(1)' }] }) as { deeper: { doc: string }[] };
    assert.strictEqual(r.deeper[0].doc, '');
  });
  test('버그 — 줄 번호가 코드 밖이면 오류', () => {
    assert.throws(() => P('bug', { code: 'a\nb', line: 3 }), /버그 위치/);
    assert.strictEqual((P('bug', { code: 'a\nb', line: 2 }) as { line: number }).line, 2);
  });
  test('실행 기록 — 줄 없는 단계는 버리고 값은 문자열로', () => {
    const r = P('trace', { call: 'f(1)', steps: [{ line: 0 }, { line: 1, frames: [{ name: 'f', vars: { n: 1 } }], objects: [{ label: 'l', items: [1, 2], look: 0 }] }] }) as { steps: { frames: { vars: Record<string, string> }[]; objects: { items: string[] }[] }[] };
    assert.strictEqual(r.steps.length, 1);
    assert.strictEqual(r.steps[0].frames[0].vars.n, '');
    assert.deepStrictEqual(r.steps[0].objects[0].items, ['', '']);
  });
  test('채점 — ok 는 true·false·null', () => {
    const r = P('run', { cases: [{ call: 'f()', output: '1', ok: true }, { call: 'g()', error: 'E' }] }) as { cases: { ok: boolean | null }[] };
    assert.deepStrictEqual(r.cases.map((c) => c.ok), [true, null]);
  });
  test('다른 언어로·리뷰·과제 — 내용 없으면 오류', () => {
    assert.throws(() => P('translate', { notes: [] }), /바꾼 코드/);
    assert.throws(() => P('review', { items: [] }), /리뷰/);
    assert.throws(() => P('task', { task: '과제', tests: [] }), /과제/);
  });
});

suite('parseStudyResult — 쉬운 말 (Code Memory 탭)', () => {
  const S = require('../study') as typeof import('../study');
  const P = S.parseStudyResult;
  test('이 코드가 하는 일 — 한 문장이 없으면 오류', () => {
    assert.deepStrictEqual(P('plain', { one_line: '짝수만 골라요', analogy: '구슬 고르기' }), { one_line: '짝수만 골라요', analogy: '구슬 고르기', use: '' });
    assert.throws(() => P('plain', { analogy: '비유만' }), /설명/);
  });
  test('줄별 설명 — 줄 번호가 없거나 설명이 비면 버림', () => {
    const r = P('lines', { lines: [{ line: 1, plain: '함수를 만들어요' }, { line: 0, plain: 'x' }, { line: 2, plain: '' }, { plain: 'y' }] }) as { lines: { line: number }[] };
    assert.deepStrictEqual(r.lines.map((l) => l.line), [1]);
    assert.throws(() => P('lines', { lines: [] }), /줄별/);
  });
  test('실행 과정 해설 — 단계 순서 유지, 전부 비면 오류', () => {
    const r = P('narrate', { summary: '요약', steps: ['하나', 3, '셋'] }) as { steps: string[] };
    assert.deepStrictEqual(r.steps, ['하나', '', '셋']);
    assert.throws(() => P('narrate', { steps: ['', ''] }), /해설/);
  });
  test('실행 기록 — 최종 값과 출력도 남김', () => {
    const r = P('trace', { call: 'f(1)', steps: [{ line: 1, frames: [] }], value: '2', stdout: 'hi' }) as { value: string; stdout: string };
    assert.strictEqual(r.value, '2');
    assert.strictEqual(r.stdout, 'hi');
  });
});
