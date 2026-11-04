// logic.ts 단위 테스트 — VS Code 없이 돌아간다: npm run test:unit
import * as assert from 'assert';
import {
  adjustEndLine, clamp, findFunctionNameByRegex, formatSeconds, parseSaveResponse, pickSymbol, reindent, SimpleSymbol,
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

suite('parseSaveResponse — 저장 응답 읽기', () => {
  test('계약 그대로 { id, message }', () => {
    assert.deepStrictEqual(parseSaveResponse('{"id": 5, "message": "snippet saved"}'), { id: 5, embedding: undefined, embeddingError: undefined });
  });
  test('임베딩 상태가 붙은 경우 (필드 이름 여러 가지 허용)', () => {
    assert.strictEqual(parseSaveResponse('{"id":1,"embedding_status":"ready"}').embedding, 'ready');
    assert.strictEqual(parseSaveResponse('{"id":1,"embedding":{"status":"FAILED","error":"too_long"}}').embedding, 'failed');
    assert.strictEqual(parseSaveResponse('{"id":1,"embedding":{"status":"FAILED","error":"too_long"}}').embeddingError, 'too_long');
    assert.strictEqual(parseSaveResponse('{"id":1,"status":"pending"}').embedding, 'pending');
  });
  test('모르는 상태 값은 무시', () => {
    assert.strictEqual(parseSaveResponse('{"id":1,"status":"ok"}').embedding, undefined);
  });
  test('id 가 없거나 JSON 이 아니면 오류 — 성공으로 치지 않는다', () => {
    assert.throws(() => parseSaveResponse('{"message":"saved"}'), /id 가 없습니다/);
    assert.throws(() => parseSaveResponse('{"id":"5"}'), /id 가 없습니다/);
    assert.throws(() => parseSaveResponse('<html>'), /JSON 이 아닙니다/);
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
