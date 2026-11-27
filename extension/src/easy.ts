// 쉬운 말 — 코드를 처음 보는 사람용 설명 (Code Memory 탭의 줄별 설명 · 실행 과정 해설 · 퀴즈 · 오류 풀이)
//   웹 화면(src/web/hub.js)이 그대로 묶어 쓴다. vscode 모듈은 쓰지 않는다
import { TraceFrame, TraceStep } from './study';

// 실행 중이면 그 순간 값 · 다음 단계가 같은 함수 안쪽 줄인지 · 다음 단계의 값
export interface LineCtx { vars: Record<string, string> | null; next: boolean; nextVars: Record<string, string> | null; inside: boolean }

export function indentOf(s: string): number { return (s.match(/^\s*/) as RegExpMatchArray)[0].length; }
export function paramNames(params: string | null | undefined): string[] {
  return String(params || '').split(',').map((p) => p.trim()).filter(Boolean)
    .map((p) => p.replace(/^\.\.\./, '').replace(/[:=].*$/, '').trim())
    .filter((p) => p && p !== 'self' && p !== 'cls' && !p.startsWith('*'));
}
export function argFor(name: string, lang: string, variant: number): string {
  const n = name.toLowerCase();
  const js = lang !== 'python';
  const pick = (a: string, b: string, c: string) => (variant === 1 ? b : variant === 2 ? c : a);
  if (/^(values|nums|numbers|lst|list|arr|items|xs|data|seq|scores)$/.test(n) || /s$/.test(n) && /num|val|item|score/.test(n)) {return pick('[3, -4, 0, 7]', '[10, 15, 22]', '[]');}
  if (/^(rows|records)$/.test(n)) {return js ? pick('[{ price: 3 }, { price: 4 }, {}]', '[{ price: 10 }]', '[]') : pick('[{"price": 3}, {"price": 4}]', '[{"price": 10}]', '[]');}
  if (/^(key|field|prop)$/.test(n)) {return pick("'price'", "'price'", "'price'");}
  if (/^(text|s|string|sentence|word|name|line|msg)$/.test(n)) {return pick("'the cat and the hat'", "'hello world'", "''");}
  if (/^(words|names|strings)$/.test(n)) {return pick("['b', 'a', 'b']", "['x']", '[]');}
  if (/^(size|k|step|width)$/.test(n)) {return pick('2', '3', '1');}
  if (/^(n|num|number|count|i|x|y|a|b|m|limit)$/.test(n)) {return pick(n === 'b' || n === 'y' ? '3' : '5', n === 'b' || n === 'y' ? '4' : '1', '0');}
  if (/^(d|dict|mapping|obj|table)$/.test(n)) {return js ? pick('{ a: 1 }', '{}', '{}') : pick('{"a": 1}', '{}', '{}');}
  if (/^(fn|func|f|callback|cb)$/.test(n)) {return js ? '(x) => x * 2' : 'lambda x: x * 2';}
  if (/^(ms|delay|timeout)$/.test(n)) {return '10';}
  return pick('[3, 1, 2]', '[1]', '[]');
}
export const EASY: Record<string, string> = {
  loop: '빨래를 한 장씩 집어서 개는 것처럼, 목록에서 하나씩 꺼내 같은 일을 해요.',
  condition: '"비가 오면 우산을 챙긴다"처럼, 상황이 맞을 때만 그 일을 해요.',
  modulo: '사탕 7개를 2명이 나누면 1개가 남죠. 그 남은 1이 7 % 2 예요. 남는 게 0이면 짝수!',
  recursion: '러시아 인형처럼, 같은 일을 더 작은 크기로 다시 맡기다가 가장 작은 인형에서 멈춰요.',
  list_comp: '체로 거르듯, 목록에서 조건에 맞는 것만 골라 새 목록을 한 번에 만들어요.',
  dict_comp: '이름표와 값을 짝지은 사전을 한 줄로 만들어요.',
  generator: '한꺼번에 다 만들지 않고, 달라고 할 때마다 하나씩 내주는 자판기예요.',
  lambda: '이름 붙일 필요 없는 아주 짧은 일회용 레시피예요.',
  fstring: '빈칸 채우기 문장이에요. f"안녕 {name}" 의 {} 자리에 값이 들어가요.',
  try_except: '"혹시 실패하면 이렇게 하자" 하고 미리 대비책을 세워 두는 거예요.',
  try_catch: '"혹시 실패하면 이렇게 하자" 하고 미리 대비책을 세워 두는 거예요.',
  with_stmt: '문을 열고 들어갔다가, 나올 때 자동으로 문을 닫아 주는 거예요.',
  decorator: '선물 포장처럼, 원래 함수는 그대로 두고 겉에 기능을 덧씌워요.',
  slicing: '빵을 잘라 원하는 부분만 가져오듯, 목록이나 글자의 일부를 잘라 와요.',
  unpacking: '상자 여러 개를 한 번에 풀어 각자 이름표에 넣어요.',
  default_args: '재료를 안 주면 기본으로 쓰는 값이 미리 정해져 있어요.',
  args_kwargs: '재료가 몇 개 올지 몰라서 "몇 개든 다 받을게" 하고 열어 둔 거예요.',
  sort_key: '"키 순서로 줄 세우기"처럼 무엇을 기준으로 정렬할지 정해요.',
  enumerate_zip: '번호표를 붙여 꺼내거나(enumerate), 두 줄을 짝지어 꺼내요(zip).',
  type_hints: '상자에 "숫자만 넣어 주세요" 같은 안내 스티커를 붙여 둔 거예요.',
  none_check: '"아무것도 없음(None)"인지 먼저 확인해서 실수를 막아요.',
  arrow: '함수를 짧게 쓰는 방법이에요. (a, b) => a - b 는 "a와 b를 받아 a-b를 돌려줘".',
  array_methods: '목록에 한꺼번에 일을 시키는 도구예요. map 은 바꾸기, filter 는 거르기, reduce 는 하나로 합치기.',
  destructuring: '상자에서 필요한 것만 꺼내 이름표에 바로 넣어요.',
  spread: '상자 안에 든 것들을 쏟아서 펼쳐 놓아요.',
  template_literal: '빈칸 채우기 문장이에요. 백틱(`) 안의 ${} 자리에 값이 들어가요.',
  optional_chaining: '"있으면 꺼내고, 없으면 그냥 넘어가"예요. 없는 걸 꺼내다 멈추는 걸 막아요.',
  strict_eq: '값과 종류가 둘 다 같은지 엄격하게 비교해요. 숫자 1 과 글자 "1" 은 달라요.',
  class_py: '붕어빵 틀이에요. 틀 하나로 비슷한 물건을 여러 개 만들어요.',
  class_js: '붕어빵 틀이에요. 틀 하나로 비슷한 물건을 여러 개 만들어요.',
  async_py: '라면 물이 끓는 동안 다른 일을 하듯, 기다리는 동안 다른 일을 해요.',
  async_js: '라면 물이 끓는 동안 다른 일을 하듯, 기다리는 동안 다른 일을 해요.',
  ts_types: '상자에 "숫자만 넣어 주세요" 같은 안내 스티커를 붙여 둔 거예요.',
  generics: '"무엇이든 담을 수 있지만, 한번 정하면 그 종류만" 담는 상자예요.',
};
export const TERMS: Record<string, string> = {
  '함수': '이름이 붙은 작은 레시피예요. 재료(값)를 넣으면 정해진 순서대로 일하고 결과를 돌려줘요.',
  '변수': '값을 담아 두는, 이름표 붙은 상자예요.',
  '목록': '값 여러 개를 순서대로 담은 것이에요. 파이썬에선 [1, 2, 3] 처럼 써요 (리스트, 배열).',
  '조건': '"만약 ~라면"이에요. 맞으면(참) 안쪽 줄을 실행하고, 아니면(거짓) 건너뛰어요.',
  '반복': '같은 일을 여러 번 하는 거예요. 목록에서 하나씩 꺼내며 돌아요.',
  '돌려줘요': '함수가 일을 끝내고 결과를 자기를 부른 곳에 넘겨주는 것(return)이에요.',
  '호출': '함수에게 "이 재료로 일해 줘" 하고 부르는 것이에요. 예: fact(5)',
  '실행 중인 함수': '함수가 불릴 때마다 그 함수만의 작업 공간(상자)이 하나 생겨요. 일을 끝내면 사라져요. 여러 개면 함수가 다른 함수를 불러서 결과를 기다리는 중이에요.',
  '입력값': '함수에 넣는 값이에요 (인자). fact(5) 에서는 5 가 입력값이에요. 요리 레시피의 재료와 같아요.',
  '리스트': '값 여러 개를 순서대로 담은 것이에요. [1, 2, 3] 처럼 써요 (목록, 배열).',
  '오류': '컴퓨터가 더 이상 진행할 수 없을 때 멈추면서 알려주는 메시지예요. 고장 난 곳을 알려주는 힌트예요.',
  '개념': '코드에 쓰인 문법이나 생각하는 방법이에요. 예: 반복, 조건.',
  '복습': '잊어버릴 때쯤 다시 보면 오래 기억돼요. 이해한 정도에 따라 다음에 볼 날을 정해 줘요.',
};
export function errPlain(e: unknown): string {
  const s = String(e || '');
  if (/not iterable/.test(s)) {return '하나씩 꺼낼 수 있는 목록이 와야 하는데, 꺼낼 수 없는 값(예: None, 숫자)이 들어왔어요.';}
  if (/ZeroDivision|division by zero/.test(s)) {return '0으로 나누려고 했어요. 0으로는 나눌 수 없어요.';}
  if (/RecursionError|maximum recursion|call stack/.test(s)) {return '자기 자신을 끝없이 다시 불러서 멈췄어요. 멈추는 조건이 필요해요.';}
  if (/TooLong|2만 줄|2초|멈췄어요/.test(s)) {return '너무 오래 돌아서 멈췄어요. 끝나지 않는 반복일 수 있어요.';}
  if (/NoneType/.test(s)) {return '값이 비어 있는(None) 상태에서 무언가를 하려고 했어요.';}
  if (/IndexError|out of range/.test(s)) {return '목록에 없는 자리(번호)를 꺼내려고 했어요.';}
  if (/KeyError/.test(s)) {return '사전에 없는 이름표로 값을 찾으려고 했어요.';}
  if (/NameError|is not defined/.test(s)) {return '아직 만들지 않은 이름을 썼어요. 철자를 확인해 보세요.';}
  if (/not all arguments converted|unsupported operand|can't multiply|can only concatenate|must be str|not supported between|can't convert/.test(s)) {return '서로 섞을 수 없는 종류(예: 글자와 숫자)를 같이 계산하려고 했어요.';}
  if (/missing \d+ required|positional argument|takes \d+ positional/.test(s)) {return '함수에 넣어야 할 입력값이 모자라거나 너무 많아요.';}
  if (/SyntaxError|Unexpected|invalid syntax/.test(s)) {return '코드 문법이 틀렸어요. 괄호나 콜론(:), 따옴표를 확인해 보세요.';}
  if (/AttributeError|is not a function|Cannot read prop/.test(s)) {return '그 값에는 없는 기능을 쓰려고 했어요.';}
  if (/TypeError/.test(s)) {return '값의 종류가 맞지 않아요. 예를 들어 목록이 와야 할 자리에 숫자가 왔어요.';}
  return '';
}
export function kindOf(raw: unknown): string {
  const v = String(raw || '').trim();
  if (/^\[/.test(v)) {return '목록';}
  if (/^['"`]/.test(v)) {return '글자';}
  if (/^-?\d/.test(v)) {return '숫자';}
  if (/^\{/.test(v)) {return '사전';}
  if (/lambda|=>/.test(v)) {return '함수';}
  if (/^(None|null|undefined)$/.test(v)) {return '없음';}
  if (/^(True|False|true|false)$/.test(v)) {return '참/거짓';}
  return '값';
}
export function varsIn(expr: string, vars: Record<string, string> | null | undefined): string {
  const ks = Object.keys(vars || {}).filter((k) => new RegExp('(^|[^\\w.])' + k.replace(/\$/g, '\\$') + '(?![\\w(])').test(expr));
  return ks.slice(0, 3).map((k) => k + ' 은(는) ' + (vars as Record<string, string>)[k]).join(', ');
}
export function explainLine(raw: string, ctx: LineCtx | null): string {
  const code = String(raw || '').trim().replace(/;$/, '');
  const v = ctx ? ctx.vars : null;
  let m: RegExpMatchArray | null;
  if (!code) {return '빈 줄이에요.';}
  if (/^(#|\/\/)/.test(code)) {return '설명을 적어 둔 메모(주석)예요. 컴퓨터는 이 줄을 무시해요.';}
  if ((m = code.match(/^(?:async\s+)?def\s+(\w+)\s*\((.*)\)/)) || (m = code.match(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\((.*)\)/)) || (m = code.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\((.*)\)\s*=>/))) {
    const ps = paramNames(m[2]);
    return m[1] + ' 라는 함수(레시피)를 만들어요. ' + (ps.length ? '입력값으로 ' + ps.join(', ') + ' 을(를) 받아요.' : '입력값 없이 일해요.');
  }
  if ((m = code.match(/^(?:if|elif)\s+(.+?):$/)) || (m = code.match(/^(?:\}\s*else\s+)?if\s*\((.+)\)\s*\{?$/))) {
    if (!ctx) {return '조건 「' + m[1] + '」 이 맞으면 안쪽 줄을 실행하고, 아니면 건너뛰어요.';}
    const vi = peek(m[1], v) || varsIn(m[1], v);
    return '조건 「' + m[1] + '」 이 맞는지 확인해요' + (vi ? ' (지금 ' + vi + ')' : '') + (ctx.next ? (ctx.inside ? ' → 맞아요. 안쪽 줄로 들어가요.' : ' → 아니에요. 안쪽 줄은 건너뛰어요.') : '.');
  }
  if (/^(\}\s*)?else\b/.test(code)) {return '앞의 조건이 맞지 않을 때 오는 곳(else)이에요.';}
  if ((m = code.match(/^for\s+(.+?)\s+in\s+(.+?):$/))) {
    if (!ctx) {return m[2] + ' 에서 값을 하나씩 꺼내 ' + m[1] + ' 에 넣으면서 안쪽 줄을 되풀이해요.';}
    if (ctx.inside) { const nv = ctx.nextVars && ctx.nextVars[m[1]]; return m[2] + ' 에서 다음 값을 꺼내 ' + m[1] + ' 에 넣어요' + (nv !== null && nv !== undefined ? '. 이번 값은 ' + nv + ' 예요.' : '.'); }
    return m[2] + ' 에서 더 꺼낼 값이 없어서 되풀이를 끝내요.';
  }
  if ((m = code.match(/^for\s*\((.+)\)\s*\{?$/))) {
    if (!ctx) {return '조건이 맞는 동안 안쪽 줄을 되풀이해요 (' + m[1] + ').';}
    return ctx.inside ? '되풀이 조건이 아직 맞아서 한 번 더 돌아요.' : '되풀이 조건이 끝나서 멈춰요.';
  }
  if ((m = code.match(/^while\s*\(?(.+?)\)?\s*[:{]?$/))) {
    if (!ctx) {return '조건 「' + m[1] + '」 이 맞는 동안 안쪽 줄을 계속 되풀이해요.';}
    return '조건 「' + m[1] + '」 확인' + (varsIn(m[1], v) ? ' (지금 ' + varsIn(m[1], v) + ')' : '') + '. ' + (ctx.inside ? '아직 맞아서 한 번 더 돌아요.' : '이제 아니라서 되풀이를 멈춰요.');
  }
  if ((m = code.match(/^return\s+\[(.+?)\s+for\s+(\w+)\s+in\s+(.+?)(?:\s+if\s+(.+))?\]$/))) {
    return m[3] + ' 에서 ' + m[2] + ' 를 하나씩 꺼내' + (m[4] ? ' 조건 「' + m[4] + '」 에 맞는 것만' : '') + ' 새 목록에 모아서 돌려줄 거예요. (체로 거르는 것처럼)';
  }
  if ((m = code.match(/^return\s+(-?\d+(?:\.\d+)?|True|False|None|true|false|null|\[\]|\{\}|'[^']*'|"[^"]*")$/))) {return m[1] + ' 을(를) 결과로 돌려줘요.';}
  if ((m = code.match(/^return\b\s*(.*)$/))) {return m[1] ? '「' + m[1] + '」 를 계산해서 결과로 돌려줄 거예요.' + (varsIn(m[1], v) ? ' (지금 ' + varsIn(m[1], v) + ')' : '') : '아무 값 없이 일을 끝내요.';}
  if ((m = code.match(/^([\w.[\]'"]+)\s*([+\-*/])=\s*(.+)$/))) {
    const verb = ({ '+': '더해요', '-': '빼요', '*': '곱해요', '/': '나눠요' } as Record<string, string>)[m[2]];
    const pk = peek(m[3], v) || varsIn(m[3], v);
    return m[1] + ' 에 ' + m[3] + ' 을(를) ' + verb + '.' + (pk ? ' (지금 ' + pk + ')' : '');
  }
  if ((m = code.match(/\.(append|push)\((.+)\)$/))) {return '목록 끝에 ' + m[2] + ' 을(를) 하나 붙여요.';}
  if ((m = code.match(/^(?:const|let|var)?\s*([\w.[\]'"]+)\s*=\s*([^=].*)$/))) {
    if (m[2] === '[]') {return m[1] + ' 라는 빈 목록(상자)을 만들어요.';}
    if (m[2] === '{}') {return m[1] + ' 라는 빈 사전(이름표 묶음)을 만들어요.';}
    if (/^-?\d+$/.test(m[2])) {return m[1] + ' 라는 상자를 만들고 ' + m[2] + ' 을(를) 넣어요.';}
    return m[1] + ' 에 「' + m[2] + '」 의 값을 넣어요.';
  }
  if (/^(print|console\.log)\(/.test(code)) {return '화면에 글자를 보여줘요(출력).';}
  if (/^(import|from)\s/.test(code)) {return '다른 곳에 있는 도구를 가져와요.';}
  if (/^\}/.test(code)) {return '안쪽 묶음이 끝나는 곳이에요.';}
  return '「' + code + '」 을(를) 실행해요.';
}
// 실행 중인 함수들 — "부른 곳"은 빼고, Python 3.11 이하의 <listcomp> 같은 안쪽 칸은 바깥 함수에 합친다(3.12 이상과 같은 모양)
const INNER = /^<(listcomp|genexpr|setcomp|dictcomp)>$/;
export function fnFrames(fr: TraceFrame[] | null | undefined): TraceFrame[] {
  const out: TraceFrame[] = [];
  (fr || []).forEach((f) => {
    if (f.name === '부른 곳') { return; }
    if (INNER.test(f.name) && out.length) {
      const last = out[out.length - 1];
      const vars = { ...last.vars };
      Object.keys(f.vars || {}).forEach((k) => { if (!k.startsWith('.')) { vars[k] = f.vars[k]; } });
      out[out.length - 1] = { name: last.name, vars };
      return;
    }
    out.push(f);
  });
  return out;
}
// 간단한 조건이면 직접 판정 — 「n % 2 == 0」 에 n = -4 → 참 (파이썬 나머지 규칙)
export function judge(cond: string, name: string, value: string): boolean | null {
  const x = Number(value);
  if (!/^-?\d+(\.\d+)?$/.test(String(value).trim()) || !Number.isFinite(x)) { return null; }
  const esc = name.replace(/[$]/g, '\\$');
  const cmp = (a: number, op: string, b: number): boolean | null => (op === '==' ? a === b : op === '!=' ? a !== b : op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : op === '<=' ? a <= b : null);
  let m = cond.trim().match(new RegExp('^' + esc + '\\s*%\\s*(\\d+)\\s*(==|!=|>=|<=|>|<)\\s*(-?\\d+)$'));
  if (m) { const k = Number(m[1]); return k ? cmp(((x % k) + k) % k, m[2], Number(m[3])) : null; }
  m = cond.trim().match(new RegExp('^' + esc + '\\s*(==|!=|>=|<=|>|<)\\s*(-?\\d+(?:\\.\\d+)?)$'));
  if (m) { return cmp(x, m[1], Number(m[2])); }
  m = cond.trim().match(new RegExp('^(-?\\d+(?:\\.\\d+)?)\\s*(==|!=|>=|<=|>|<)\\s*' + esc + '$'));
  if (m) { return cmp(Number(m[1]), m[2], x); }
  return null;
}
// if ( … ) 뒤에 바로 몸통이 붙은 한 줄짜리 JS if — 괄호 짝을 맞춰 [조건, 몸통]
export function splitIf(code: string): [string, string] | null {
  const m = code.match(/^(?:\}\s*else\s+)?if\s*\(/);
  if (!m) { return null; }
  let depth = 1, i = m[0].length;
  for (; i < code.length && depth; i++) { if (code[i] === '(') { depth++; } else if (code[i] === ')') { depth--; } }
  if (depth) { return null; }
  return [code.slice(m[0].length, i - 1).trim(), code.slice(i).trim()];
}
// 조건 안의 값 보여 주기 — arr[i] · arr.length 처럼 이름만으로는 안 보이는 것까지
function listItems(v: string | undefined): string[] | null {
  const t = String(v || '').trim();
  if (!/^\[.*\]$/.test(t) || /^\[.*\[/.test(t.slice(1))) { return null; }
  const body = t.slice(1, -1).trim();
  return body ? body.split(/\s*,\s*/) : [];
}
export function peek(expr: string, vars: Record<string, string> | null | undefined): string {
  const v = vars || {};
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(\w+)\[(\w+)\]|(\w+)\.length\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) && out.length < 3) {
    const key = m[0];
    if (seen.has(key)) { continue; }
    seen.add(key);
    const items = listItems(v[m[1] || m[3]]);
    if (!items) { continue; }
    if (m[3]) { out.push(key + ' 은(는) ' + items.length); continue; }
    const idx = /^\d+$/.test(m[2]) ? Number(m[2]) : Number(v[m[2]]);
    if (Number.isInteger(idx) && idx >= 0 && idx < items.length) { out.push(key + ' 은(는) ' + items[idx]); }
  }
  const plain = Object.keys(v).filter((k) => !listItems(v[k]) && new RegExp('(^|[^\\w.])' + k.replace(/\$/g, '\\$') + '(?![\\w(\\[])').test(expr));
  plain.forEach((k) => out.push(k + ' 은(는) ' + v[k]));
  const at = (x: string): number => expr.indexOf(x.split(' 은(는) ')[0]);
  return out.sort((a, b) => at(a) - at(b)).slice(0, 3).join(', ');
}
const JS_FOR = /^for\s*\(([^;]*);([^;]*);([^)]*)\)/;
const idsIn = (x: string): string[] => (x.match(/[A-Za-z_$][\w$]*/g) || []).filter((k) => !/^(let|const|var)$/.test(k));
export function narrate(steps: TraceStep[], i: number, lines: string[]): string {
  const s = steps[i], prev = steps[i - 1], next = steps[i + 1];
  const fr = fnFrames(s.frames), pfr = prev ? fnFrames(prev.frames) : [], nfr = next ? fnFrames(next.frames) : [];
  const top = fr[fr.length - 1] || { name: '', vars: {} };
  const code = (lines[s.line - 1] || '').trim();
  if (/^오류로 멈췄어요/.test(String(s.say || ''))) {return '여기서 문제가 생겨 멈췄어요. ' + (errPlain(s.ret) || s.ret || '');}
  if (s.ret && /^<(listcomp|genexpr|setcomp|dictcomp)>\(\)/.test(s.ret)) {
    return '새 목록 ' + String(s.ret).split(' = ').slice(1).join(' = ') + ' 을(를) 다 만들었어요.';
  }
  if (s.ret) {
    const val = String(s.ret).split(' = ').slice(1).join(' = ');
    return top.name + ' 함수가 일을 끝내고 결과 ' + val + ' 을(를) 돌려줘요.' + (fr.length > 1 ? ' 이 값은 자기를 불렀던 함수로 돌아가서 그 계산에 쓰여요.' : ' 이게 최종 결과예요!');
  }
  const out: string[] = [];
  if (i === 0 || fr.length > pfr.length) {
    const args = Object.keys(top.vars || {}).map((k) => k + ' = ' + top.vars[k]).join(', ');
    const same = fr.filter((f) => f.name === top.name).length;
    out.push((i === 0 ? '시작! ' : '') + top.name + ' 함수가 ' + (args ? '입력값 ' + args + ' 을(를) 받아서 ' : '') + '일을 시작해요.' + (same > 1 ? ' 자기 자신을 다시 부른 거예요(재귀). 같은 함수가 지금 ' + same + '개 실행 중이에요.' : ''));
  }
  const sameDepth = next && nfr.length === fr.length;
  // 한 줄짜리 목록 만들기 [x for x in xs if 조건] — 같은 줄이 값마다 되풀이된다
  const comp = code.match(/\[\s*(.+?)\s+for\s+(\w+)\s+in\s+(.+?)(?:\s+if\s+(.+?))?\s*\]/);
  if (comp) {
    const [, expr, v, src, cond] = comp;
    const nv = sameDepth && nfr.length ? nfr[nfr.length - 1].vars : null;
    const cur = nv && nv[v] !== undefined && (top.vars || {})[v] !== nv[v] ? nv[v] : undefined;
    const first = !prev || prev.line !== s.line || pfr.length !== fr.length;
    if (first) {
      out.push(src + ' 에서 ' + v + ' 를 하나씩 꺼내' + (cond ? ' 조건 「' + cond + '」 에 맞는 것만' : '') + (expr.trim() !== v ? ' 「' + expr.trim() + '」 로 바꿔서' : '') + ' 새 목록에 모아요. (체로 거르는 것처럼)');
    }
    if (cur !== undefined) {
      const ok = cond ? judge(cond, v, cur) : true;
      out.push((first ? '첫 값' : '다음 값') + ' ' + v + ' = ' + cur + ' 을(를) 꺼내' + (cond ? ' 조건 「' + cond + '」 에 넣어 봐요' : '요') +
        (ok === true ? (cond ? ' → 맞아요. 새 목록에 넣어요.' : '. 새 목록에 넣어요.') : ok === false ? ' → 아니에요. 버려요.' : '. 맞으면 새 목록에 넣고, 아니면 버려요.'));
    } else if (!first || !next || next.line !== s.line) {
      out.push(src + ' 의 값을 다 꺼내 봤어요. 모은 새 목록을 쓸 차례예요.');
    }
    return out.join(' ');
  }
  const inside = !!(sameDepth && next.line > s.line && indentOf(lines[next.line - 1] || '') > indentOf(lines[s.line - 1] || ''));
  const nextVars = sameDepth && nfr.length ? nfr[nfr.length - 1].vars : null;
  // JavaScript — 같은 줄의 어느 부분인지(col)까지 알 때
  const raw = lines[s.line - 1] || '';
  const seg = typeof s.col === 'number' ? raw.slice(s.col).trim() : code;
  const sameLineAfter = !!(sameDepth && next.line === s.line && typeof next.col === 'number' && typeof s.col === 'number' && next.col > s.col);
  const jf = typeof s.col === 'number' ? seg.match(JS_FOR) : null;
  if (jf) {
    const [, init, test, upd] = jf;
    const back = !!(prev && pfr.length === fr.length && prev.line > s.line);
    const cur = top.vars || {};
    if (back) {
      const pv = pfr.length ? pfr[pfr.length - 1].vars : {};
      const ch = idsIn(upd).filter((k) => cur[k] !== undefined && pv[k] !== cur[k]).map((k) => k + ' 이(가) ' + pv[k] + ' 에서 ' + cur[k] + ' (으)로 바뀌었어요');
      out.push('한 바퀴 끝났어요. 「' + upd.trim() + '」' + (ch.length ? ' 로 ' + ch.join(', ') + '.' : ' 을(를) 실행했어요.'));
    } else {
      const ids = idsIn(init.split('=')[0]);
      out.push('되풀이를 시작해요. 「' + init.trim() + '」' + (ids.length && cur[ids[0]] !== undefined ? ' 로 ' + ids[0] + ' 은(는) ' + cur[ids[0]] + ' 이에요.' : ' 을(를) 먼저 해요.'));
    }
    const go = !!(sameDepth && ((next.line > s.line && indentOf(lines[next.line - 1] || '') > indentOf(raw)) || sameLineAfter));
    const pk = peek(test, cur);
    out.push('조건 「' + test.trim() + '」 확인' + (pk ? ' (지금 ' + pk + ')' : '') + (next ? (go ? ' → 맞아요. 안쪽을 한 번 더 실행해요.' : ' → 아니에요. 되풀이를 끝내요.') : '.'));
    return out.join(' ');
  }
  const oneIf = typeof s.col === 'number' ? splitIf(seg.replace(/;$/, '')) : null;
  if (oneIf && oneIf[1] && !oneIf[1].startsWith('{')) {
    const pk = peek(oneIf[0], top.vars);
    out.push('조건 「' + oneIf[0] + '」 이 맞는지 확인해요' + (pk ? ' (지금 ' + pk + ')' : '') + '.' + (next ? (sameLineAfter ? ' → 맞아요. 바로 뒤 「' + oneIf[1].replace(/;$/, '') + '」 을(를) 실행해요.' : ' → 아니에요. 뒤쪽은 건너뛰어요.') : ''));
    return out.join(' ');
  }
  if (typeof s.col === 'number' && prev && prev.line === s.line && typeof prev.col === 'number' && prev.col < s.col && pfr.length === fr.length && splitIf(raw.slice(prev.col).trim())) {
    out.push('조건이 맞았으니 ' + explainLine(seg, { vars: top.vars || {}, next: !!next, nextVars, inside: false }));
  } else {
    out.push(explainLine(typeof s.col === 'number' ? seg : code, { vars: top.vars || {}, next: !!next, nextVars, inside }));
  }
  // 다음 단계가 for 머리로 되돌아가면 i++ 같은 바뀜은 그 줄에서 말한다
  const nraw = next ? (lines[next.line - 1] || '') : '';
  const njf = next && sameDepth && next.line < s.line && typeof next.col === 'number' ? nraw.slice(next.col).trim().match(JS_FOR) : null;
  const njf0 = next && sameDepth && typeof next.col === 'number' ? nraw.slice(next.col).trim().match(JS_FOR) : null;
  const skip = new Set(njf ? idsIn(njf[3]) : njf0 && next && next.line > s.line ? idsIn(njf0[1].split('=')[0]) : []);
  if (nextVars) {
    const ch = Object.keys(nextVars).filter((k) => !skip.has(k) && (top.vars || {})[k] !== nextVars[k])
      .map((k) => (top.vars || {})[k] === undefined ? k + ' 이(가) 새로 생겼어요 (' + nextVars[k] + ')' : k + ' 이(가) ' + top.vars[k] + ' 에서 ' + nextVars[k] + ' (으)로 바뀌어요');
    if (ch.length) {out.push('그 결과 ' + ch.slice(0, 3).join(', ') + '.');}
  } else if (next && nfr.length > fr.length) {out.push('여기서 함수를 새로 불러요. 실행 중인 함수가 하나 늘어요.');}
  return out.join(' ');
}
export function shuffle<T>(a: T[]): T[] { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
export function showOut(r: { output: string; error: string }): string { return r.error ? '오류: ' + r.error.split(':')[0] : r.output; }
export function mutate(out: string): string[] {
  const res: string[] = [];
  const m = String(out).match(/^\[(.*)\]$/);
  if (m) {
    const parts = m[1] ? m[1].split(', ') : [];
    if (parts.length > 1) { res.push('[' + parts.slice().reverse().join(', ') + ']'); res.push('[' + parts.slice(1).join(', ') + ']'); }
    if (parts.length === 1) {res.push('[]');}
    if (!parts.length) {res.push('None');}
  } else if (/^-?\d+(\.\d+)?$/.test(out)) { const n = Number(out); res.push(String(n + 1), String(n * 2), String(Math.max(0, n - 1))); }
  return res.filter((x) => x !== out);
}

// ── 섞은 해설: 화살표 · 값 표시는 매 단계, 문장은 중요한 순간에만 (Python Tutor + 강의 방식) ──
export interface KeyNarration { text: string; key: boolean }
interface LoopInfo { line: number; kind: 'pyfor' | 'jsfor' | 'while' | 'forof'; v: string; src: string; test: string; init: string; upd: string }
// 이 줄을 감싸는 가장 가까운 반복문 머리 (들여쓰기로 찾는다)
export function loopOf(lines: string[], lineNo: number): LoopInfo | null {
  const at = (n: number): LoopInfo | null => {
    const c = String(lines[n - 1] || '').trim();
    let m: RegExpMatchArray | null;
    if ((m = c.match(/^for\s+(.+?)\s+in\s+(.+?):$/))) { return { line: n, kind: 'pyfor', v: m[1], src: m[2], test: '', init: '', upd: '' }; }
    if ((m = c.match(JS_FOR))) { return { line: n, kind: 'jsfor', v: idsIn(m[1].split('=')[0])[0] || '', src: '', test: m[2].trim(), init: m[1].trim(), upd: m[3].trim() }; }
    if ((m = c.match(/^for\s*\(\s*(?:const|let|var)?\s*(\w+)\s+of\s+(.+?)\)\s*\{?$/))) { return { line: n, kind: 'forof', v: m[1], src: m[2], test: '', init: '', upd: '' }; }
    if ((m = c.match(/^while\s*\(?(.+?)\)?\s*[:{]?$/))) { return { line: n, kind: 'while', v: '', src: '', test: m[1], init: '', upd: '' }; }
    return null;
  };
  const self = at(lineNo);
  if (self) { return self; }
  let ind = indentOf(lines[lineNo - 1] || '');
  for (let n = lineNo - 1; n >= 1; n--) {
    const l = lines[n - 1] || '';
    if (!l.trim() || indentOf(l) >= ind) { continue; }
    ind = indentOf(l);
    if (/^\s*((async\s+)?def\s|(export\s+)?(async\s+)?function\b|class\s)/.test(l)) { return null; }
    const lp = at(n);
    if (lp) { return lp; }
  }
  return null;
}
const depthOf = (s: TraceStep | undefined): number => (s ? fnFrames(s.frames).length : -1);
// 이번 반복에서 머리 줄을 몇 번째로 지나는지 (1 부터) — 반복 밖에서 들어온 곳까지 거슬러 센다
function lapOf(steps: TraceStep[], i: number, head: number): { lap: number; start: number } {
  const d = depthOf(steps[i]);
  let lap = 0, start = i;
  for (let j = i; j >= 0; j--) {
    const sj = steps[j], dj = depthOf(sj);
    if (dj < d) { break; }
    if (dj > d) { continue; }
    if (sj.line < head) { break; }
    if (sj.line === head && !sj.ret) { lap++; start = j; }
  }
  return { lap, start };
}
const topVars = (s: TraceStep | undefined): Record<string, string> => { const f = s ? fnFrames(s.frames) : []; return f.length ? f[f.length - 1].vars || {} : {}; };
// 돌려주는 단계 — fact(2) = 2 × 1 = 2 처럼 계산을 보여 준다
function retText(steps: TraceStep[], i: number, lines: string[]): string {
  const s = steps[i], prev = steps[i - 1];
  if (/^<(listcomp|genexpr|setcomp|dictcomp)>\(\)/.test(s.ret)) { return narrate(steps, i, lines); }
  const fr = fnFrames(s.frames), d = fr.length, top = fr[d - 1] || { name: '', vars: {} };
  const val = String(s.ret).split(' = ').slice(1).join(' = ');
  const vars = top.vars || {};
  const label = top.name + '()';
  const params = paramNames((String(lines.find((l) => new RegExp('(def|function)\\s+' + top.name + '\\s*\\(').test(l)) || '').match(/\((.*)\)/) || ['', ''])[1]);
  const call = params.length && params.every((p) => vars[p] !== undefined) ? top.name + '(' + params.map((p) => vars[p]).join(', ') + ')' : label;
  const tail = d > 1 ? ' 이 값을 부른 쪽이 받아서 계산을 이어가요.' : ' 이게 최종 결과예요!';
  const m = String(lines[s.line - 1] || '').trim().replace(/;$/, '').match(/^return\s+(.+)$/);
  if (m && !/\sfor\s|=>|\blambda\b/.test(m[1])) {
    let ex = m[1];
    if (prev && prev.ret && depthOf(prev) === d + 1) {
      const pv = String(prev.ret).split(' = ').slice(1).join(' = ');
      ex = ex.replace(/\b(\w+)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/, (all, f) => (String(prev.ret).startsWith(f + '(') ? pv : all));
    }
    ex = ex.replace(/\b[A-Za-z_]\w*\b(?!\s*\()/g, (k) => (vars[k] !== undefined && vars[k].length <= 20 && !/^(and|or|not|in|is|True|False|None|true|false|null)$/.test(k) ? vars[k] : k));
    ex = ex.replace(/\s\*\s/g, ' × ');
    if (ex.trim() !== val && ex.trim() !== m[1].trim() && ex.length <= 80) { return call + ' = ' + ex.trim() + ' = ' + val + ' 을(를) 돌려줘요.' + tail; }
  }
  return call + ' 은(는) ' + val + ' 을(를) 돌려줘요.' + tail;
}
export function keyNarrate(steps: TraceStep[], i: number, lines: string[]): KeyNarration {
  const s = steps[i], prev = steps[i - 1], next = steps[i + 1];
  if (!s) { return { text: '', key: false }; }
  const fr = fnFrames(s.frames), d = fr.length, top = fr[d - 1] || { name: '', vars: {} };
  const raw = lines[s.line - 1] || '';
  const code = (typeof s.col === 'number' ? raw.slice(s.col) : raw).trim();
  const key = (text: string): KeyNarration => ({ text, key: true });
  const quiet = (text: string): KeyNarration => ({ text, key: false });
  if (/^오류로 멈췄어요/.test(String(s.say || ''))) { return key('여기서 문제가 생겨 멈췄어요. ' + (errPlain(s.ret) || s.ret || '')); }
  if (s.ret) { return key(retText(steps, i, lines)); }
  const out: string[] = [];
  // 함수 시작 · 다른 함수(또는 자기 자신) 부르기
  if (i === 0 || d > depthOf(prev)) {
    const args = Object.keys(top.vars || {}).map((k) => k + ' = ' + top.vars[k]).join(', ');
    const same = fr.filter((f) => f.name === top.name).length;
    if (i === 0) { out.push(top.name + ' 이(가) ' + (args ? args + ' 을(를) 받아 ' : '') + '시작해요.'); }
    else if (same > 1) { out.push(top.name + ' 이(가) 자기 자신을 다시 불러요' + (args ? ' (' + args + ')' : '') + '. 지금 ' + top.name + ' 이(가) ' + same + '개 줄 서 있고, 앞의 것들은 결과를 기다려요.'); }
    else { out.push((fr[d - 2] ? fr[d - 2].name + ' 이(가) ' : '') + top.name + ' 을(를) 불러요' + (args ? ' (' + args + ')' : '') + '. 부른 쪽은 결과를 기다려요.'); }
  }
  // 한 줄 목록 만들기 [x for x in xs if 조건]
  const comp = code.match(/\[\s*(.+?)\s+for\s+(\w+)\s+in\s+(.+?)(?:\s+if\s+(.+?))?\s*\]/);
  if (comp) {
    const [, expr, v, src, cond] = comp;
    const pd = depthOf(prev);
    const first = !prev || prev.line !== s.line || pd !== d;
    const items = listItems(top.vars[src]);
    const nv = next && depthOf(next) === d ? topVars(next)[v] : undefined;
    const cur = nv !== undefined && top.vars[v] !== nv ? nv : undefined;
    if (first) { out.push(src + ' 에서 ' + v + ' 를 하나씩 꺼내' + (cond ? ' 「' + cond + '」 에 맞는 것만' : '') + (expr.trim() !== v ? ' 「' + expr.trim() + '」 로 바꿔서' : '') + ' 새 목록에 모아요.'); }
    if (cur === undefined && (!next || next.ret || next.line !== s.line || depthOf(next) !== d)) {
      const res = next && next.ret ? String(next.ret).split(' = ').slice(1).join(' = ') : '';
      return key((out.length ? out.join(' ') + ' ' : '') + (items ? items.length + '개를 ' : '') + '다 봤어요.' + (res ? (cond ? ' 조건에 맞은 것만 모으면 ' : ' 새 목록은 ') + res + ' 이에요.' : ''));
    }
    const ok0 = cur !== undefined && cond ? judge(cond, v, cur) : null;
    if (out.length) { return key(out.join(' ') + (cur !== undefined ? ' 첫 값 ' + v + ' = ' + cur + (ok0 === true ? ' → 넣음.' : ok0 === false ? ' → 버림.' : '.') : '')); }
    let k = 0;
    for (let j = i; j >= 0 && steps[j].line === s.line && depthOf(steps[j]) === d; j--) { k++; }
    const ok = cur !== undefined && cond ? judge(cond, v, cur) : null;
    return quiet('꺼내 보는 중 · ' + k + (items ? '/' + items.length : '번째') + (cur !== undefined ? ' (' + v + ' = ' + cur + (ok === true ? ' → 넣음' : ok === false ? ' → 버림' : '') + ')' : ''));
  }
  const lp = loopOf(lines, s.line);
  if (lp && lp.line === s.line && (typeof s.col !== 'number' || raw.slice(s.col).trim().startsWith(raw.trim().slice(0, 3)))) {
    // 반복 머리: 처음 들어올 때 · 끝날 때만 말한다
    const { lap, start } = lapOf(steps, i, s.line);
    const goesIn = !!(next && depthOf(next) === d && ((next.line > s.line && indentOf(lines[next.line - 1] || '') > indentOf(raw)) || (next.line === s.line && typeof next.col === 'number' && typeof s.col === 'number' && next.col > s.col)));
    const deeper = !!(next && depthOf(next) > d);
    if (lap === 1 && (goesIn || deeper)) {
      if (lp.kind === 'pyfor' || lp.kind === 'forof') { out.push(lp.src + ' 에서 ' + lp.v + ' 를 하나씩 꺼내며 반복을 시작해요.'); }
      else if (lp.kind === 'jsfor') { out.push(lp.v ? lp.v + ' 를 ' + (top.vars[lp.v] !== undefined ? top.vars[lp.v] + ' 부터, ' : '') + '「' + lp.test + '」 인 동안 반복을 시작해요.' : '「' + lp.test + '」 인 동안 반복을 시작해요.'); }
      else { out.push('「' + lp.test + '」 인 동안 반복을 시작해요.'); }
      return key(out.join(' '));
    }
    if (!goesIn && !deeper && next) {
      const laps = lap - 1;
      const before = topVars(steps[start]);
      const ch = Object.keys(top.vars).filter((k) => k !== lp.v && before[k] !== undefined && before[k] !== top.vars[k]).slice(0, 3)
        .map((k) => k + ' 은(는) ' + before[k] + ' → ' + top.vars[k]);
      out.push('반복 끝. ' + (laps > 0 ? laps + '번 돌았어요.' : '한 번도 안 돌았어요.') + (ch.length ? ' 그동안 ' + ch.join(', ') + ' 로 바뀌었어요.' : ''));
      return key(out.join(' '));
    }
    if (out.length) { return key(out.join(' ')); }
    if (lp.kind === 'pyfor' || lp.kind === 'forof') { return quiet('반복 중 · ' + lap + '번째로 넘어가요'); }
    return quiet('반복 중 · ' + lap + '번째' + (lp.v && top.vars[lp.v] !== undefined ? ' (' + lp.v + ' = ' + top.vars[lp.v] + ')' : ''));
  }
  if (out.length) { return key(out.join(' ')); }
  // 조건 줄이면 맞았는지만 짧게
  const sameD = !!(next && depthOf(next) === d);
  let cond = '';
  const one = typeof s.col === 'number' ? splitIf(code.replace(/;$/, '')) : null;
  const blk = code.match(/^(?:if|elif)\s+(.+?):$/) || code.match(/^(?:\}\s*else\s+)?if\s*\((.+)\)\s*\{?$/);
  if (one && one[1] && !one[1].startsWith('{')) { cond = one[0] + '」 → ' + (sameD && next.line === s.line && typeof next.col === 'number' && next.col > (s.col as number) ? '맞음' : '아님'); }
  else if (blk && next) { cond = blk[1] + '」 → ' + (sameD && next.line > s.line && indentOf(lines[next.line - 1] || '') > indentOf(raw) ? '맞음' : '아님'); }
  if (lp) {
    const { lap } = lapOf(steps, i, lp.line);
    return quiet('반복 중 · ' + Math.max(1, lap) + '번째' + (lp.v && top.vars[lp.v] !== undefined ? ' (' + lp.v + ' = ' + top.vars[lp.v] + ')' : '') + (cond ? ' · 「' + cond : ''));
  }
  if (cond) { return quiet('조건 「' + cond); }
  // 반복 밖의 보통 줄은 짧게 (바뀐 값은 아래 칸에 노랗게 보인다)
  return quiet(explainLine(code, { vars: top.vars || {}, next: !!next, nextVars: null, inside: false }));
}
