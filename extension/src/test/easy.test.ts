// 쉬운 말 설명 단위 테스트 — 줄별 설명 · 실행 과정 해설 · 오류 풀이 · 예시 입력값
import * as assert from 'assert';
import { argFor, errPlain, explainLine, fnFrames, judge, keyNarrate, kindOf, mutate, narrate, paramNames, peek, splitIf } from '../easy';
import { TraceStep } from '../study';

suite('explainLine — 줄별 설명', () => {
  test('함수 · 조건 · 반복 · 돌려주기 · 더하기 · 빈 목록', () => {
    assert.match(explainLine('def fact(n):', null), /fact 라는 함수.*입력값으로 n/);
    assert.match(explainLine('    if n <= 1:', null), /조건 「n <= 1」 이 맞으면/);
    assert.match(explainLine('for word in text.split():', null), /text\.split\(\) 에서 값을 하나씩 꺼내 word/);
    assert.match(explainLine('return [n for n in values if n % 2 == 0]', null), /values 에서 n 를 하나씩.*「n % 2 == 0」.*새 목록/);
    assert.match(explainLine('total += n', null), /total 에 n 을\(를\) 더해요/);
    assert.match(explainLine('out = []', null), /out 라는 빈 목록/);
    assert.match(explainLine('# 메모', null), /주석/);
    assert.match(explainLine('const sumBy = (rows, key) => {', null), /sumBy 라는 함수.*rows, key/);
  });
  test('실행 중이면 조건이 맞았는지 · 이번에 꺼낸 값까지', () => {
    assert.match(explainLine('if n <= 1:', { vars: { n: '5' }, next: true, nextVars: null, inside: false }), /지금 n 은\(는\) 5.*아니에요/);
    assert.match(explainLine('if n <= 1:', { vars: { n: '1' }, next: true, nextVars: null, inside: true }), /맞아요/);
    assert.match(explainLine('for n in nums:', { vars: {}, next: true, nextVars: { n: '3' }, inside: true }), /이번 값은 3/);
    assert.match(explainLine('for n in nums:', { vars: {}, next: true, nextVars: null, inside: false }), /더 꺼낼 값이 없어서/);
  });
});

suite('narrate — 실행 과정 해설', () => {
  const lines = ['def fact(n):', '    if n <= 1:', '        return 1', '    return n * fact(n - 1)'];
  const fr = (...ns: string[]) => [{ name: '부른 곳', vars: {} }, ...ns.map((n) => ({ name: 'fact', vars: { n } }))];
  const steps: TraceStep[] = [
    { line: 2, say: '', frames: fr('2'), objects: [], ret: '' },
    { line: 4, say: '', frames: fr('2'), objects: [], ret: '' },
    { line: 2, say: '', frames: fr('2', '1'), objects: [], ret: '' },
    { line: 3, say: '', frames: fr('2', '1'), objects: [], ret: '' },
    { line: 3, say: '', frames: fr('2', '1'), objects: [], ret: 'fact() = 1' },
    { line: 4, say: '', frames: fr('2'), objects: [], ret: 'fact() = 2' },
  ];
  test('시작 · 조건 거짓 · 재귀 · 돌려주기 · 최종 결과', () => {
    assert.match(narrate(steps, 0, lines), /^시작! fact 함수가 입력값 n = 2.*아니에요/);
    assert.match(narrate(steps, 1, lines), /함수를 새로 불러요/);
    assert.match(narrate(steps, 2, lines), /자기 자신을 다시 부른 거예요\(재귀\).*2개 실행 중/);
    assert.match(narrate(steps, 4, lines), /결과 1 을\(를\) 돌려줘요.*불렀던 함수로/);
    assert.match(narrate(steps, 5, lines), /결과 2 을\(를\) 돌려줘요.*최종 결과/);
  });
  test('값이 바뀌면 무엇에서 무엇으로', () => {
    const s: TraceStep[] = [
      { line: 2, say: '', frames: [{ name: 'f', vars: { total: '0' } }], objects: [], ret: '' },
      { line: 3, say: '', frames: [{ name: 'f', vars: { total: '3' } }], objects: [], ret: '' },
    ];
    assert.match(narrate(s, 0, ['def f():', '    total += 3', '    return total']), /total 이\(가\) 0 에서 3 \(으\)로 바뀌어요/);
  });
});

suite('errPlain · 예시 입력값 · 값 종류 · 헷갈리는 보기', () => {
  test('자주 나는 오류를 쉬운 말로', () => {
    assert.match(errPlain("TypeError: 'NoneType' object is not iterable"), /꺼낼 수 없는 값/);
    assert.match(errPlain('ZeroDivisionError: division by zero'), /0으로 나누려고/);
    assert.match(errPlain('RecursionError: maximum recursion depth exceeded'), /끝없이/);
    assert.strictEqual(errPlain('뭔가 이상함'), '');
  });
  test('매개변수 이름으로 예시 값', () => {
    assert.deepStrictEqual(paramNames('self, values: list[int] = None, *args, **kw'), ['values']);
    assert.strictEqual(argFor('values', 'python', 0), '[3, -4, 0, 7]');
    assert.strictEqual(argFor('values', 'python', 2), '[]');
    assert.strictEqual(argFor('n', 'python', 0), '5');
    assert.strictEqual(argFor('d', 'javascript', 0), '{ a: 1 }');
  });
  test('값 종류 · 헷갈리는 보기', () => {
    assert.deepStrictEqual(['[1]', "'a'", '-3', 'None', '{}'].map(kindOf), ['목록', '글자', '숫자', '없음', '사전']);
    assert.deepStrictEqual(mutate('[-4, 0]'), ['[0, -4]', '[0]']);
    assert.deepStrictEqual(mutate('5'), ['6', '10', '4']);
  });
});

suite('목록 만들기 한 줄 [x for x in xs if 조건]', () => {
  const lines = ['def even_numbers(values):', '    return [n for n in values if n % 2 == 0]'];
  const f = (vars: Record<string, string>) => [{ name: '부른 곳', vars: {} }, { name: 'even_numbers', vars }];
  const steps: TraceStep[] = [
    { line: 2, say: '', frames: f({ values: '[3, -4]' }), objects: [], ret: '' },
    { line: 2, say: '', frames: f({ values: '[3, -4]', n: '3' }), objects: [], ret: '' },
    { line: 2, say: '', frames: f({ values: '[3, -4]', n: '-4' }), objects: [], ret: '' },
    { line: 2, say: '', frames: f({ values: '[3, -4]', n: '-4' }), objects: [], ret: 'even_numbers() = [-4]' },
  ];
  test('값마다 조건을 판정하고, 같은 설명을 되풀이하지 않음', () => {
    assert.match(narrate(steps, 0, lines), /하나씩 꺼내 조건 「n % 2 == 0」.*첫 값 n = 3.*아니에요\. 버려요/);
    assert.match(narrate(steps, 1, lines), /^다음 값 n = -4.*맞아요\. 새 목록에 넣어요/);
    assert.match(narrate(steps, 2, lines), /다 꺼내 봤어요/);
  });
  test('판정 — 파이썬 나머지 규칙 · 비교 · 모르는 조건은 null', () => {
    assert.strictEqual(judge('n % 2 == 0', 'n', '-4'), true);
    assert.strictEqual(judge('n % 2 == 1', 'n', '-3'), true);
    assert.strictEqual(judge('x > 10', 'x', '3'), false);
    assert.strictEqual(judge('0 < x', 'x', '3'), true);
    assert.strictEqual(judge('is_ok(n)', 'n', '3'), null);
    assert.strictEqual(judge('n % 2 == 0', 'n', "'a'"), null);
  });
  test('Python 3.11 이하의 <listcomp> 칸은 바깥 함수에 합침', () => {
    const fr = fnFrames([{ name: '부른 곳', vars: {} }, { name: 'even_numbers', vars: { values: '[3]' } }, { name: '<listcomp>', vars: { '.0': '<it>', n: '3' } }]);
    assert.deepStrictEqual(fr, [{ name: 'even_numbers', vars: { values: '[3]', n: '3' } }]);
  });
  test('값만 돌려주는 줄', () => {
    assert.strictEqual(explainLine('return 1', null), '1 을(를) 결과로 돌려줘요.');
  });
});

suite('easy — JavaScript 해설', () => {
  test('splitIf 는 괄호 짝을 맞춰 조건과 몸통을 나눈다', () => {
    assert.deepStrictEqual(splitIf('if (f(x) > 0) g(y);'), ['f(x) > 0', 'g(y);']);
    assert.deepStrictEqual(splitIf('if (a) {'), ['a', '{']);
    assert.strictEqual(splitIf('total += 1'), null);
  });
  test('peek 은 arr[i] 와 arr.length 값을 보여 준다', () => {
    assert.strictEqual(peek('arr[i] % 2 === 0', { arr: '[3, -4, 0, 7]', i: '1' }), 'arr[i] 은(는) -4, i 은(는) 1');
    assert.strictEqual(peek('i < arr.length', { arr: '[3, -4]', i: '2' }), 'i 은(는) 2, arr.length 은(는) 2');
  });
  test('for 머리 · 한 줄 if · i++ 는 제 줄에서 말한다', () => {
    const lines = ['function f(arr) {', '  let t = 0;', '  for (let i = 0; i < arr.length; i++) {', '    if (arr[i] > 0) t += arr[i];', '  }', '  return t;', '}'];
    const fr = (vars: Record<string, string>) => [{ name: '부른 곳', vars: {} }, { name: 'f', vars }];
    const st = (line: number, col: number, vars: Record<string, string>) => ({ line, col, say: '', frames: fr(vars), objects: [], ret: '' });
    const steps: TraceStep[] = [
      st(2, 2, { arr: '[5]' }),
      st(3, 2, { arr: '[5]', t: '0', i: '0' }),
      st(4, 4, { arr: '[5]', t: '0', i: '0' }),
      st(4, 20, { arr: '[5]', t: '0', i: '0' }),
      st(3, 2, { arr: '[5]', t: '5', i: '1' }),
      st(6, 2, { arr: '[5]', t: '5', i: '1' }),
    ];
    assert.ok(!/i 이\(가\) 새로/.test(narrate(steps, 0, lines)));
    assert.match(narrate(steps, 1, lines), /되풀이를 시작해요.*→ 맞아요/);
    assert.match(narrate(steps, 2, lines), /arr\[i\] 은\(는\) 5.*→ 맞아요. 바로 뒤/);
    const body = narrate(steps, 3, lines);
    assert.match(body, /^조건이 맞았으니 t 에 arr\[i\]/);
    assert.ok(!/i 이\(가\)/.test(body));
    assert.match(narrate(steps, 4, lines), /한 바퀴 끝났어요. 「i\+\+」 로 i 이\(가\) 0 에서 1.*→ 아니에요. 되풀이를 끝내요/);
  });
});

suite('easy — 섞은 해설 (중요한 순간에만)', () => {
  const fr = (name: string, vars: Record<string, string>) => ({ name, vars });
  const st = (line: number, frames: { name: string; vars: Record<string, string> }[], ret = ''): TraceStep => ({ line, say: '', frames: [{ name: '부른 곳', vars: {} }, ...frames], objects: [], ret });
  test('반복은 시작 · 끝만 말하고 중간은 조용히', () => {
    const lines = ['def total(xs):', '    s = 0', '    for x in xs:', '        s += x', '    return s'];
    const v = (o: Record<string, string>) => [fr('total', { xs: '[1, 2]', ...o })];
    const steps = [st(2, v({})), st(3, v({ s: '0' })), st(4, v({ s: '0', x: '1' })), st(3, v({ s: '1', x: '1' })), st(4, v({ s: '1', x: '2' })), st(3, v({ s: '3', x: '2' })), st(5, v({ s: '3', x: '2' })), st(5, v({ s: '3', x: '2' }), 'total() = 3')];
    const k = steps.map((_, i) => keyNarrate(steps, i, lines));
    assert.ok(k[0].key && /시작해요/.test(k[0].text));
    assert.ok(k[1].key && /하나씩 꺼내며 반복을 시작/.test(k[1].text));
    assert.ok(!k[2].key && /반복 중 · 1번째 \(x = 1\)/.test(k[2].text));
    assert.ok(!k[3].key && /2번째로 넘어가요/.test(k[3].text));
    assert.ok(k[5].key && /반복 끝. 2번 돌았어요. 그동안 s 은\(는\) 0 → 3/.test(k[5].text));
    assert.ok(k[7].key && /total\(\[1, 2\]\) 은\(는\) 3 을\(를\) 돌려줘요. 이게 최종 결과예요!/.test(k[7].text));
  });
  test('재귀 결과는 계산을 풀어서 보여 준다', () => {
    const lines = ['def fact(n):', '    if n <= 1:', '        return 1', '    return n * fact(n - 1)'];
    const steps = [st(3, [fr('fact', { n: '2' }), fr('fact', { n: '1' })], 'fact() = 1'), st(4, [fr('fact', { n: '2' })], 'fact() = 2')];
    assert.strictEqual(keyNarrate(steps, 1, lines).text, 'fact(2) = 2 × 1 = 2 을(를) 돌려줘요. 이게 최종 결과예요!');
  });
});
