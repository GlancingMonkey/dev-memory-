// logic.ts 단위 테스트 — VS Code 없이 돌아간다: npm run test:unit
import * as assert from 'assert';
import {
  adjustEndLine, clamp, findFunctionNameByRegex, formatSeconds, parseSaveResponse, pickSymbol, reindent, SaveUnconfirmedError, SimpleSymbol,
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
