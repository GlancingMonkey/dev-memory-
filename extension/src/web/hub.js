// Code Memory 탭 화면 (웹뷰). esbuild 가 dist/hub.js 로 묶는다. 확장 본체는 src/hub.ts
//   개념 찾기 · 복습 간격 · 개념 지도 계산은 src/study.ts 를 그대로 쓴다
import { STUDY_CONCEPTS, detectConcepts, scheduleNext, dueCards, buildConceptGraph, learningPath } from '../study';

const nil = (v) => v === null || v === undefined;

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) {for (const k in attrs) {
    const v = attrs[k];
    if (nil(v) || v === false) {continue;}
    if (k === 'class') {e.className = v;}
    else if (k === 'html') {e.innerHTML = v;}
    else if (k === 'text') {e.textContent = v;}
    else if (k.startsWith('on')) {e.addEventListener(k.slice(2), v);}
    else if (k === 'style') {e.style.cssText = v;}
    else {e.setAttribute(k, v === true ? '' : v);}
  }}
  kids.flat(9).forEach((k) => { if (nil(k) || k === false) {return;} e.append(k.nodeType ? k : document.createTextNode(String(k))); });
  return e;
}
function indentOf(s) { return s.match(/^\s*/)[0].length; }
function paramNames(params) {
  return String(params || '').split(',').map((p) => p.trim()).filter(Boolean)
    .map((p) => p.replace(/^\.\.\./, '').replace(/[:=].*$/, '').trim())
    .filter((p) => p && p !== 'self' && p !== 'cls' && !p.startsWith('*'));
}
function argFor(name, lang, variant) {
  const n = name.toLowerCase();
  const js = lang !== 'python';
  const pick = (a, b, c) => (variant === 1 ? b : variant === 2 ? c : a);
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
const EASY = {
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
const TERMS = {
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
function term(w, label) { return h('span', { class: 'term', tabindex: '0', 'data-term': w }, label || w); }
function errPlain(e) {
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
function kindOf(v) {
  v = String(v || '').trim();
  if (/^\[/.test(v)) {return '목록';}
  if (/^['"`]/.test(v)) {return '글자';}
  if (/^-?\d/.test(v)) {return '숫자';}
  if (/^\{/.test(v)) {return '사전';}
  if (/lambda|=>/.test(v)) {return '함수';}
  if (/^(None|null|undefined)$/.test(v)) {return '없음';}
  if (/^(True|False|true|false)$/.test(v)) {return '참/거짓';}
  return '값';
}
function varsIn(expr, vars) {
  const ks = Object.keys(vars || {}).filter((k) => new RegExp('(^|[^\\w.])' + k.replace(/\$/g, '\\$') + '(?![\\w(])').test(expr));
  return ks.slice(0, 3).map((k) => k + ' 은(는) ' + vars[k]).join(', ');
}
function explainLine(code, ctx, lang) {
  code = String(code || '').trim().replace(/;$/, '');
  const v = ctx ? ctx.vars : null;
  let m;
  if (!code) {return '빈 줄이에요.';}
  if (/^(#|\/\/)/.test(code)) {return '설명을 적어 둔 메모(주석)예요. 컴퓨터는 이 줄을 무시해요.';}
  if ((m = code.match(/^(?:async\s+)?def\s+(\w+)\s*\((.*)\)/)) || (m = code.match(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\((.*)\)/)) || (m = code.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\((.*)\)\s*=>/))) {
    const ps = paramNames(m[2]);
    return m[1] + ' 라는 함수(레시피)를 만들어요. ' + (ps.length ? '입력값으로 ' + ps.join(', ') + ' 을(를) 받아요.' : '입력값 없이 일해요.');
  }
  if ((m = code.match(/^(?:if|elif)\s+(.+?):$/)) || (m = code.match(/^(?:\}\s*else\s+)?if\s*\((.+)\)\s*\{?$/))) {
    if (!ctx) {return '조건 「' + m[1] + '」 이 맞으면 안쪽 줄을 실행하고, 아니면 건너뛰어요.';}
    const vi = varsIn(m[1], v);
    return '조건 「' + m[1] + '」 이 맞는지 확인해요' + (vi ? ' (지금 ' + vi + ')' : '') + '. ' + (ctx.next ? (ctx.inside ? '맞아요! 그래서 안쪽 줄로 들어가요.' : '아니에요. 그래서 안쪽 줄은 건너뛰어요.') : '');
  }
  if (/^(\}\s*)?else\b/.test(code)) {return '앞의 조건이 맞지 않을 때 오는 곳(else)이에요.';}
  if ((m = code.match(/^for\s+(.+?)\s+in\s+(.+?):$/))) {
    if (!ctx) {return m[2] + ' 에서 값을 하나씩 꺼내 ' + m[1] + ' 에 넣으면서 안쪽 줄을 되풀이해요.';}
    if (ctx.inside) { const nv = ctx.nextVars && ctx.nextVars[m[1]]; return m[2] + ' 에서 다음 값을 꺼내 ' + m[1] + ' 에 넣어요' + (!nil(nv) ? '. 이번 값은 ' + nv + ' 예요.' : '.'); }
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
  if ((m = code.match(/^return\b\s*(.*)$/))) {return m[1] ? '「' + m[1] + '」 를 계산해서 결과로 돌려줄 거예요.' + (varsIn(m[1], v) ? ' (지금 ' + varsIn(m[1], v) + ')' : '') : '아무 값 없이 일을 끝내요.';}
  if ((m = code.match(/^([\w.[\]'"]+)\s*([+\-*/])=\s*(.+)$/))) {
    const verb = { '+': '더해요', '-': '빼요', '*': '곱해요', '/': '나눠요' }[m[2]];
    return m[1] + ' 에 ' + m[3] + ' 을(를) ' + verb + '.' + (varsIn(m[3], v) ? ' (지금 ' + varsIn(m[3], v) + ')' : '');
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
function fnFrames(fr) { return (fr || []).filter((f) => f.name !== '부른 곳'); }
function narrate(T, i, lines) {
  const steps = T.data.steps, s = steps[i], prev = steps[i - 1], next = steps[i + 1];
  const fr = fnFrames(s.frames), pfr = prev ? fnFrames(prev.frames) : [], nfr = next ? fnFrames(next.frames) : [];
  const top = fr[fr.length - 1] || { name: '', vars: {} };
  const code = (lines[s.line - 1] || '').trim();
  if (/^오류로 멈췄어요/.test(String(s.say || ''))) {return '여기서 문제가 생겨 멈췄어요. ' + (errPlain(s.ret) || s.ret || '');}
  if (s.ret) {
    const val = String(s.ret).split(' = ').slice(1).join(' = ');
    return top.name + ' 함수가 일을 끝내고 결과 ' + val + ' 을(를) 돌려줘요.' + (fr.length > 1 ? ' 이 값은 자기를 불렀던 함수로 돌아가서 그 계산에 쓰여요.' : ' 이게 최종 결과예요!');
  }
  const out = [];
  if (i === 0 || fr.length > pfr.length) {
    const args = Object.keys(top.vars || {}).map((k) => k + ' = ' + top.vars[k]).join(', ');
    const same = fr.filter((f) => f.name === top.name).length;
    out.push((i === 0 ? '시작! ' : '') + top.name + ' 함수가 ' + (args ? '입력값 ' + args + ' 을(를) 받아서 ' : '') + '일을 시작해요.' + (same > 1 ? ' 자기 자신을 다시 부른 거예요(재귀). 같은 함수가 지금 ' + same + '개 실행 중이에요.' : ''));
  }
  const sameDepth = next && nfr.length === fr.length;
  const inside = !!(sameDepth && next.line > s.line && indentOf(lines[next.line - 1] || '') > indentOf(lines[s.line - 1] || ''));
  const nextVars = sameDepth && nfr.length ? nfr[nfr.length - 1].vars : null;
  out.push(explainLine(code, { vars: top.vars || {}, next, nextVars, inside }, null));
  if (nextVars) {
    const ch = Object.keys(nextVars).filter((k) => (top.vars || {})[k] !== nextVars[k])
      .map((k) => (top.vars || {})[k] === undefined ? k + ' 이(가) 새로 생겼어요 (' + nextVars[k] + ')' : k + ' 이(가) ' + top.vars[k] + ' 에서 ' + nextVars[k] + ' (으)로 바뀌어요');
    if (ch.length) {out.push('그 결과 ' + ch.slice(0, 3).join(', ') + '.');}
  } else if (next && nfr.length > fr.length) {out.push('여기서 함수를 새로 불러요. 실행 중인 함수가 하나 늘어요.');}
  return out.join(' ');
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function showOut(r) { return r.error ? '오류: ' + r.error.split(':')[0] : r.output; }
function mutate(out) {
  const res = [];
  const m = String(out).match(/^\[(.*)\]$/);
  if (m) {
    const parts = m[1] ? m[1].split(', ') : [];
    if (parts.length > 1) { res.push('[' + parts.slice().reverse().join(', ') + ']'); res.push('[' + parts.slice(1).join(', ') + ']'); }
    if (parts.length === 1) {res.push('[]');}
    if (!parts.length) {res.push('None');}
  } else if (/^-?\d+(\.\d+)?$/.test(out)) { const n = Number(out); res.push(String(n + 1), String(n * 2), String(Math.max(0, n - 1))); }
  return res.filter((x) => x !== out);
}
(function termTips() {
  let tip = null;
  const show = (el) => {
    hide();
    const txt = TERMS[el.getAttribute('data-term')];
    if (!txt) {return;}
    tip = h('div', { class: 'tip', role: 'tooltip' }, h('b', null, el.getAttribute('data-term')), h('div', { style: 'margin-top:3px' }, txt));
    document.body.append(tip);
    const r = el.getBoundingClientRect(), tr = tip.getBoundingClientRect();
    let top = r.bottom + 6; if (top + tr.height > window.innerHeight - 8) {top = r.top - tr.height - 6;}
    tip.style.top = Math.max(6, top) + 'px';
    tip.style.left = Math.max(6, Math.min(r.left, window.innerWidth - tr.width - 8)) + 'px';
  };
  const hide = () => { if (tip) { tip.remove(); tip = null; } };
  document.addEventListener('mouseover', (e) => { const t = e.target.closest && e.target.closest('.term'); if (t) {show(t);} });
  document.addEventListener('mouseout', (e) => { const t = e.target.closest && e.target.closest('.term'); if (t) {hide();} });
  document.addEventListener('focusin', (e) => { if (e.target.classList && e.target.classList.contains('term')) {show(e.target);} });
  document.addEventListener('focusout', (e) => { if (e.target.classList && e.target.classList.contains('term')) {hide();} });
  document.addEventListener('click', (e) => { const t = e.target.closest && e.target.closest('.term'); if (t) { e.preventDefault(); show(t); } });
})();

// ─────────────────────────────────────────────
// 상태 · 확장 본체와 주고받기
// ─────────────────────────────────────────────
const vscode = acquireVsCodeApi();
const CMAP = {};
STUDY_CONCEPTS.forEach((c) => { CMAP[c.id] = c; });
const S = {
  env: { mock: true, localRun: true, win: false, canPopout: false },
  study: { cards: {}, known: {}, mastered: {} },
  tab: 'study',
  fn: null,                 // 지금 보는 코드
  sv: {},                   // 코드별 화면 기록 (AI 답 · 퀴즈 · 입력)
  group: 'u', sub: 'lines',
  trace: { id: 0, data: null, code: '', i: 0, timer: null, call: '', busy: false, err: '', args: {}, argsFor: null, raw: false, variant: 0, speed: 3000, ai: null, aiOn: false },
  chat: { chat: null, list: [], ctx: { file: null, selection: 0 }, useFile: true, useSel: true, useFn: true, draft: '' },
  mapSel: null, mapAll: false,
  welcomeOpen: null,
};
const saved = vscode.getState() || {};
S.welcomeDone = !!saved.welcomeDone;
S.welcomeSeen = !!saved.welcomeSeen;
S.trace.speed = saved.speed || 3000;
S.zoom = saved.zoom || 1;
// 탭을 창으로 떼거나 붙이면 화면이 다시 그려진다 — 보던 것 그대로 되살리기
function snapshot() {
  const T = S.trace;
  return S.fn ? { item: S.fn.item, tab: S.tab, group: S.group, sub: S.sub,
    trace: T.data && T.fnKey === S.fn.key ? { id: T.id, data: T.data, code: T.code, i: T.i, call: T.call, args: T.args, raw: T.raw, variant: T.variant, fnKey: T.fnKey, ai: T.ai && T.ai.steps ? T.ai : null, aiOn: T.aiOn } : null } : { tab: S.tab };
}
function persist() { vscode.setState({ welcomeDone: S.welcomeDone, welcomeSeen: S.welcomeSeen, speed: S.trace.speed, zoom: S.zoom, snap: snapshot() }); }
function restore(snap) {
  if (!snap || !snap.item) { if (snap && snap.tab) { S.tab = snap.tab; } return false; }
  const fn = fnFromItem(snap.item);
  S.fn = fn; S.tab = snap.tab || 'study'; S.group = snap.group || 'u'; S.sub = snap.sub || 'lines';
  if (snap.trace) {
    const t = snap.trace;
    Object.assign(S.trace, { id: t.id, data: t.data, code: t.code, i: t.i, call: t.call, args: t.args || {}, raw: !!t.raw, variant: t.variant || 0, fnKey: t.fnKey, ai: t.ai, aiOn: !!t.aiOn, argsFor: fn.key + ':' + fn.params + ':' + (t.variant || 0), busy: false, err: '' });
  }
  return true;
}
function applyZoom() { document.body.style.zoom = String(S.zoom); }
applyZoom();

let seq = 0;
const waiting = new Map();
function call(type, payload) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    vscode.postMessage(Object.assign({ type, id }, payload));
  });
}
function post(type, payload) { vscode.postMessage(Object.assign({ type }, payload || {})); }
function toast(t) {
  let x = document.getElementById('toast');
  if (!x) { x = h('div', { id: 'toast', class: 'toast', role: 'status' }); document.body.append(x); }
  x.textContent = t; x.classList.add('in');
  clearTimeout(toast.t); toast.t = setTimeout(() => x.classList.remove('in'), 2200);
}
function errText(e) {
  if (!e) {return '알 수 없는 오류';}
  const k = e.kind;
  if (k === 'missing') {return e.message + ' — 설정에서 mock 을 켜면 예시로 볼 수 있어요.';}
  if (k === 'key') {return e.message + ' — 사이드바의 🔑 내 키에서 AI 키를 확인해 주세요.';}
  if (k === 'connect') {return e.message + ' — Backend 서버가 켜져 있는지 확인해 주세요.';}
  if (k === 'declined') {return '실행을 취소했어요.';}
  if (k === 'nopython') {return e.message;}
  return e.message || String(e);
}

// ── 코드 → 함수 정보 (이름 · 입력값 · 언어)
function langShort(lang) { const l = String(lang || '').toLowerCase(); return l === 'python' ? 'py' : /typescript/.test(l) ? 'ts' : /javascript/.test(l) ? 'js' : l; }
function headOf(code, lang) {
  const lines = String(code || '').replace(/\r\n?/g, '\n').split('\n');
  for (const t of lines) {
    const m = t.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\((.*?)\)\s*(?:->[^:]*)?:/) ||
      t.match(/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/) ||
      t.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/);
    if (m) {return { name: m[1], params: m[2] };}
    if (t.trim() && !/^\s*(#|\/\/|@)/.test(t)) {break;}
  }
  return null;
}
function studyKey(r) { return [r.project_name || '', r.file_path || '', r.function_name || '', r.language || ''].join('|'); }
function fnFromItem(it) {
  const code = String(it.code || '').replace(/\r\n?/g, '\n');
  const head = headOf(code, it.language);
  const start = Math.max(0, (it.start_line || 1) - 1);
  return {
    item: it, key: studyKey(it), code, lang: String(it.language || ''),
    name: it.function_name || (head && head.name) || '선택한 코드',
    params: head ? head.params : null, callable: !!head,
    file: it.file_path || '', start, end: Math.max(start, (it.end_line || start + code.split('\n').length) - 1),
  };
}
function svOf(fn) { const k = fn.key + '#' + fn.code.length + ':' + fn.code.slice(0, 60); if (!S.sv[k]) {S.sv[k] = {};} return S.sv[k]; }
function suggestCall(fn, variant) { return fn.name + '(' + paramNames(fn.params).map((p) => argFor(p, fn.lang, variant || 0)).join(', ') + ')'; }
function ensureArgs(fn) {
  const T = S.trace;
  const key = fn.key + ':' + fn.params + ':' + T.variant;
  if (T.argsFor === key) {return;}
  T.args = {};
  paramNames(fn.params).forEach((p) => { T.args[p] = argFor(p, fn.lang, T.variant); });
  T.argsFor = key;
  if (!T.raw) {T.call = callFromArgs(fn);}
}
function callFromArgs(fn) { return fn.name + '(' + paramNames(fn.params).map((p) => S.trace.args[p] || '').join(', ') + ')'; }
function codeBlockReq(fn) { return { code: fn.code, language: fn.lang, function_name: fn.item.function_name || (fn.callable ? fn.name : null) }; }

// ── 실행: Python 은 확장 본체(내 PC · 서버), JavaScript 는 이 화면의 Worker (2초 제한)
function isJs(lang) { return /^javascript/.test(String(lang || '').toLowerCase()); }
function runJs(code, calls) {
  const src = 'self.onmessage = function (e) {\n' +
    '  const show = (v) => { try { if (v === undefined) return "undefined"; if (typeof v === "function") return "[Function]"; return JSON.stringify(v); } catch (err) { return String(v); } };\n' +
    '  const out = [];\n' +
    '  for (const c of e.data.calls) {\n' +
    '    try { const v = (new Function(e.data.code + "\\n;return (" + c + ");"))(); out.push({ call: c, output: show(v), error: "", expected: "", ok: null }); }\n' +
    '    catch (err) { out.push({ call: c, output: "", error: (err && err.name ? err.name + ": " : "") + (err && err.message ? err.message : String(err)), expected: "", ok: null }); }\n' +
    '  }\n' +
    '  self.postMessage(out);\n' +
    '};';
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); } catch (e) { reject(e); return; }
    const t = setTimeout(() => { w.terminate(); resolve(calls.map((c) => ({ call: c, output: '', error: '2초 넘게 걸려서 멈췄어요 (끝나지 않는 반복일 수 있어요)', expected: '', ok: null }))); }, 2000);
    w.onmessage = (e) => { clearTimeout(t); w.terminate(); resolve(e.data); };
    w.onerror = (e) => { clearTimeout(t); w.terminate(); reject(e); };
    w.postMessage({ code, calls });
  });
}
async function runCalls(fn, calls, tests) {
  if (isJs(fn.lang)) {
    try {
      const code = await call('source', { item: fn.item });
      const rows = await runJs(code, tests && tests.length ? tests.map((t) => t.call) : calls);
      if (tests && tests.length) {rows.forEach((r, i) => { r.expected = tests[i].expected; r.ok = !r.error && r.output.replace(/\s/g, '') === tests[i].expected.replace(/\s/g, ''); });}
      return rows;
    } catch (e) { /* Worker 를 못 쓰면 서버 실행으로 */ }
  }
  const r = await call('run', { item: fn.item, calls, tests: tests || [] });
  return r.cases;
}
function runCode(fn, code, tests) {
  if (isJs(fn.lang)) {
    return runJs(code, tests.map((t) => t.call)).then((rows) => rows.map((r, i) => Object.assign(r, { expected: tests[i].expected, ok: !r.error && r.output.replace(/\s/g, '') === tests[i].expected.replace(/\s/g, '') })));
  }
  return call('run', { item: fn.item, code, calls: [], tests }).then((r) => r.cases);
}

// ── AI (확장 본체 → POST /study/{mode} · mock)
function ai(sv, key, mode, extra, after) {
  sv[key] = { busy: true };
  render();
  call('ai', { mode, req: Object.assign(codeBlockReq(S.fn), extra || {}) })
    .then((d) => { sv[key] = { data: d }; if (after) {after(d);} }, (e) => { sv[key] = { err: errText(e) }; })
    .then(() => render());
}
function stateView(st, box) {
  if (!st) {return false;}
  if (st.busy) { box.append(h('div', { class: 'note' }, h('span', { class: 'spin' }), 'AI 가 만드는 중…')); return true; }
  if (st.err) {box.append(h('div', { class: 'err' }, st.err));}
  return false;
}

// ── 복습 기록 (사이드바와 같은 모양 · 같은 저장소)
const GRADE_KO = { again: '모름', hard: '헷갈림', good: '알겠음' };
function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function daysUntil(iso) { return Math.round((dayStart(new Date(iso)) - dayStart(new Date())) / 86400000); }
function untilText(iso) { const n = daysUntil(iso); return n <= 0 ? '오늘' : n === 1 ? '내일' : n + '일 뒤'; }
function agoText(iso) { const n = -daysUntil(iso); return n <= 0 ? '오늘' : n + '일 전'; }
function cards() { return Object.keys(S.study.cards).map((k) => S.study.cards[k]); }
function rate(fn, grade) {
  const r = fn.item;
  const prev = S.study.cards[fn.key];
  const now = new Date();
  const sch = scheduleNext(prev, grade, now);
  const sv = svOf(fn);
  const hits = detectConcepts(fn.code, fn.lang, fn.item.function_name, STUDY_CONCEPTS);
  S.study.cards[fn.key] = {
    key: fn.key, id: r.id, name: fn.name, function_name: r.function_name || null, file_path: r.file_path || '',
    project_name: r.project_name || null, language: r.language || '', start_line: r.start_line || 1, end_line: r.end_line || 1,
    code: fn.code.slice(0, 6000), concepts: hits.map((x) => x.id),
    interval: sch.interval, due: sch.due, reps: sch.reps, lapses: sch.lapses,
    last: grade, lastAt: now.toISOString(), firstAt: prev && prev.firstAt ? prev.firstAt : now.toISOString(), count: (prev && prev.count ? prev.count : 0) + 1,
    history: ((prev && Array.isArray(prev.history)) ? prev.history : []).concat([{ at: now.toISOString(), grade }]).slice(-20),
    ai: sv.ai && sv.ai.data ? sv.ai.data : (prev && prev.ai) || null,
  };
  post('study', { study: S.study });
  render();
  toast(grade === 'good' ? '다음 복습은 ' + untilText(sch.due) + '예요' : grade === 'hard' ? '헷갈린 것으로 기록했어요. ' + untilText(sch.due) + ' 다시 볼게요' : '내일 다시 볼게요');
}

// ─────────────────────────────────────────────
// 그리기
// ─────────────────────────────────────────────
const TABS = [['study', '📘', '공부'], ['trace', '▶', '실행 과정'], ['chat', '✦', 'AI 대화'], ['map', '🗺', '개념 지도']];
const app = document.getElementById('app');
function keepFocus(fn) {
  const a = document.activeElement;
  const k = a && a.getAttribute && a.getAttribute('data-k');
  const sel = k && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd, a.scrollTop] : null;
  const body = document.querySelector('.hbody');
  const sc = body ? body.scrollTop : 0;
  fn();
  const nb = document.querySelector('.hbody');
  if (nb) {nb.scrollTop = sc;}
  if (!k) {return;}
  const b = document.querySelector('[data-k="' + k + '"]');
  if (b && b !== a) { b.focus(); if (sel) { try { b.setSelectionRange(sel[0], sel[1]); b.scrollTop = sel[2]; } catch (e) { /* 무시 */ } } }
}
let lastTab = null;
function render() {
  keepFocus(() => {
    app.replaceChildren();
    const bar = h('div', { class: 'hubbar', role: 'tablist' });
    TABS.forEach(([k, ic, t]) => bar.append(h('button', { type: 'button', role: 'tab', title: t, 'aria-label': t, 'aria-selected': S.tab === k ? 'true' : 'false', class: 'ht' + (S.tab === k ? ' on' : ''), onclick: () => { S.tab = k; S.welcomeOpen = false; render(); } }, h('span', { class: 'ic' }, ic), h('span', { class: 'tx' }, ' ' + t))));
    bar.append(h('span', { class: 'sp' }));
    bar.append(h('button', { type: 'button', title: '글자 작게', 'aria-label': '글자 작게', class: 'tbtn tool', onclick: () => { S.zoom = Math.max(0.8, Math.round((S.zoom - 0.1) * 10) / 10); applyZoom(); render(); } }, '가−'),
      h('button', { type: 'button', title: '글자 크게', 'aria-label': '글자 크게', class: 'tbtn tool', onclick: () => { S.zoom = Math.min(1.6, Math.round((S.zoom + 0.1) * 10) / 10); applyZoom(); render(); } }, '가+'));
    if (S.env.win) {bar.append(h('button', { type: 'button', class: 'tbtn', title: '코드 옆 탭으로 다시 붙이기', 'aria-label': 'VS Code에 붙이기', onclick: () => post('dock', { snap: snapshot() }) }, h('span', { class: 'ic' }, '📌'), h('span', { class: 'tx' }, ' VS Code에 붙이기')));}
    else if (S.env.canPopout) {bar.append(h('button', { type: 'button', class: 'tbtn', title: '이 탭을 떼어 따로 뜬 창으로 (모니터가 두 개면 옆 화면에)', 'aria-label': '창으로 떼기', onclick: () => post('popout') }, h('span', { class: 'ic' }, '⧉'), h('span', { class: 'tx' }, ' 창으로 떼기')));}
    const body = h('div', { class: 'hbody' + (S.tab === 'chat' ? ' chatbody' : '') });
    if (S.tab === 'study') {body.append(studyPane());}
    else if (S.tab === 'trace') {body.append(tracePane());}
    else if (S.tab === 'chat') {body.append(chatPane());}
    else {body.append(mapPane());}
    app.append(bar, body);
    if (S.tab === 'map') {requestAnimationFrame(drawMapEdges);}
    if (S.tab === 'chat' && lastTab !== 'chat') {requestAnimationFrame(() => { const m = document.querySelector('.msgs'); if (m) {m.scrollTop = m.scrollHeight;} });}
    lastTab = S.tab;
  });
  persist();
}

function welcomeCard() {
  if (S.welcomeDone) {return null;}
  if (nil(S.welcomeOpen)) {S.welcomeOpen = !S.welcomeSeen;}
  if (window.innerWidth < 720 && S.welcomeOpen && S.welcomeSeen) {S.welcomeOpen = false;}
  if (!S.welcomeSeen) { S.welcomeSeen = true; persist(); }
  const close = h('button', { type: 'button', class: 'tbtn', title: '다시 안 보기', 'aria-label': '안내 닫기', onclick: () => { S.welcomeDone = true; persist(); render(); } }, '✕');
  if (!S.welcomeOpen) {
    return h('div', { class: 'welcome mini' }, h('span', null, '처음이세요? 코드 위 ', h('b', null, '📘 공부'), ' → ', h('b', null, '▶ 실행 과정 보기'), ' → ', h('b', null, '✦ AI 대화'), ' 순서로 써 보세요.'),
      h('button', { type: 'button', class: 'lk', onclick: () => { S.welcomeOpen = true; render(); } }, '자세히'), close);
  }
  return h('div', { class: 'welcome' },
    h('div', { class: 'wt' }, h('span', null, '처음이세요? 코드를 몰라도 괜찮아요'), close),
    h('ol', null,
      h('li', null, '코드의 함수 이름 위에 있는 ', h('b', null, '📘 공부'), '를 누르면 그 코드가 무슨 일을 하는지 쉬운 말로 알려줘요.'),
      h('li', null, h('b', null, '▶ 실행 과정 보기'), '를 누르면 컴퓨터가 한 줄씩 일하는 모습을 해설과 함께 볼 수 있어요. 코드에도 지금 줄이 표시돼요.'),
      h('li', null, '모르는 건 ', h('b', null, '✦ AI 대화'), '에 그냥 물어보세요. 점선 밑줄 친 ', term('함수'), ' 같은 말에 마우스를 올리면 뜻이 나와요.')),
    h('button', { type: 'button', class: 'btn', onclick: () => { S.welcomeOpen = false; render(); } }, '접기'));
}
function noTarget(what) {
  const box = h('div', { class: 'empty' }, h('div', null, what + ' 코드를 골라 주세요.'),
    h('div', { class: 'muted' }, '편집기에서 함수 위의 📘 공부 · ▶ 실행 과정 보기를 누르거나, 사이드바 검색 결과에서 고를 수 있어요.'));
  const due = dueCards(cards(), new Date());
  if (due.length) {
    box.append(h('div', { class: 'lbl', style: 'margin-top:16px' }, '📘 오늘 복습할 코드'));
    due.slice(0, 6).forEach((c) => box.append(h('button', { type: 'button', class: 'rv', onclick: () => openItem({ id: c.id, function_name: c.function_name, file_path: c.file_path, project_name: c.project_name, language: c.language, start_line: c.start_line, end_line: c.end_line, code: c.code }, 'study') },
      h('span', null, c.name), h('span', { class: 'm' }, GRADE_KO[c.last] + ' · ' + agoText(c.lastAt)))));
  }
  return box;
}
function targetHead(fn) {
  const card = S.study.cards[fn.key];
  const hits = detectConcepts(fn.code, fn.lang, fn.item.function_name, STUDY_CONCEPTS);
  return h('div', { class: 'tgt' }, h('b', null, fn.name),
    fn.file ? h('button', { type: 'button', class: 'lk', title: '원본 열기', onclick: () => post('open', { item: fn.item }) }, fn.file + ' : ' + (fn.start + 1) + '–' + (fn.end + 1)) : null,
    h('span', { class: 'pill' }, langShort(fn.lang) + ' · 개념 ' + hits.length + (card ? ' · 복습 ' + untilText(card.due) : '')));
}

// ─────────────────────────────────────────────
// 공부
// ─────────────────────────────────────────────
const GROUPS = [
  ['u', '이해하기', [['lines', '줄별 설명'], ['concepts', '개념'], ['mine', '내가 설명해 보기'], ['why', '다른 방법과 비교']]],
  ['p', '연습하기', [['quiz', '퀴즈'], ['break', '이상한 값 넣어 보기'], ['task', '직접 고쳐 보기'], ['bug', '틀린 곳 찾기']]],
  ['t', '다른 언어로', [['translate', '번역']]],
  ['r', '코드 리뷰', [['review', '코드 리뷰']]],
];
function studyPane() {
  const pane = h('div', { class: 'pane' });
  const wc = welcomeCard(); if (wc) {pane.append(wc);}
  const fn = S.fn;
  if (!fn) { pane.append(noTarget('공부할')); return pane; }
  pane.append(targetHead(fn));
  pane.append(plainCard(fn, svOf(fn)));
  const grps = h('div', { class: 'grps' });
  GROUPS.forEach(([k, t, subs]) => grps.append(h('button', { type: 'button', class: S.group === k ? 'on' : '', onclick: () => { S.group = k; S.sub = subs[0][0]; render(); } }, t)));
  pane.append(grps);
  const g = GROUPS.find((x) => x[0] === S.group);
  if (g[2].length > 1) {
    const subs = h('div', { class: 'subs' });
    g[2].forEach(([k, t]) => subs.append(h('button', { type: 'button', class: S.sub === k ? 'on' : '', onclick: () => { S.sub = k; render(); } }, t)));
    pane.append(subs);
  } else {pane.append(h('div', { style: 'height:8px' }));}
  const views = { lines: viewLines, concepts: viewConcepts, mine: viewMine, why: viewWhy, quiz: viewQuiz, break: viewBreak, task: viewTask, bug: viewBug, translate: viewTranslate, review: viewReview };
  pane.append(views[S.sub](fn, svOf(fn)));
  const card = S.study.cards[fn.key];
  const rb = h('div', { class: 'ratebox' }, h('div', { class: 'rt' }, '이 코드, 얼마나 이해했나요?'),
    h('div', { class: 'muted', style: 'font-size:12px' }, card ? '지난번: ' + GRADE_KO[card.last] + ' · ' + agoText(card.lastAt) + ' · 다음 ' + term('복습') + ' ' + untilText(card.due) : '고르면 다음 복습 날짜가 잡혀요. 모르면 내일, 알겠으면 3일 뒤, 계속 알면 점점 길어져요.'));
  const r = h('div', { class: 'rate' });
  [['again', '모름'], ['hard', '헷갈림'], ['good', '알겠음']].forEach(([gk, t]) => r.append(h('button', { type: 'button', class: card && card.last === gk ? 'on' : '', onclick: () => rate(fn, gk) }, t)));
  rb.append(r);
  pane.append(rb);
  return pane;
}
// 맨 위: 이 코드가 하는 일 (AI 쉬운 말 + 진짜로 돌려 본 예)
function plainCard(fn, sv) {
  const box = h('div', { class: 'plain' }, h('div', { class: 'pt' }, '🙂 이 코드가 하는 일'));
  if (!sv.plain) {
    sv.plain = { busy: true };
    call('ai', { mode: 'plain', req: codeBlockReq(fn) }).then((d) => { sv.plain = { data: d }; }, (e) => { sv.plain = { err: errText(e) }; }).then(() => { if (S.tab === 'study') {render();} });
  }
  const p = sv.plain;
  const ps = paramNames(fn.params);
  if (p.data) {
    box.append(h('div', { class: 'p1' }, p.data.one_line));
    if (p.data.analogy) {box.append(h('div', { class: 'easy' }, '비유하면 · ' + p.data.analogy));}
    if (p.data.use) {box.append(h('div', { class: 'muted', style: 'margin-top:4px' }, '어디에 쓰나요? ' + p.data.use));}
  } else {
    box.append(h('div', { class: 'p1' }, fn.callable ? [fn.name + ' 라는 ', term('함수'), '예요. ' + (ps.length ? '입력값으로 ' + ps.join(', ') + ' 을(를) 받아서 ' : '') + '정해진 순서대로 일하고 결과를 ', term('돌려줘요'), '.'] : '선택한 코드 조각이에요. 아래 "줄별 설명"에서 한 줄씩 볼 수 있어요.'));
    if (p.busy) {box.append(h('div', { class: 'muted' }, h('span', { class: 'spin' }), 'AI 가 쉬운 말로 풀어 쓰는 중…'));}
    if (p.err) {box.append(h('div', { class: 'muted', style: 'font-size:12px' }, 'AI 설명을 못 받았어요: ' + p.err));}
  }
  if (fn.callable) {
    const c = suggestCall(fn, 0);
    if (!sv.example || sv.example.call !== c) {
      sv.example = { call: c, busy: true };
      runCalls(fn, [c]).then((r) => { sv.example = { call: c, r: r[0] }; }, (e) => { sv.example = { call: c, err: errText(e) }; }).then(() => { if (S.tab === 'study') {render();} });
    }
    const ex = sv.example;
    const row = h('div', { class: 'exrow' }, h('span', { class: 'muted' }, '직접 돌려 본 예 · '), h('code', null, c), ' → ');
    if (ex.busy) {row.append(h('span', { class: 'spin' }));}
    else if (ex.r && !ex.r.error) {row.append(h('code', { class: 'okc' }, ex.r.output));}
    else if (ex.r) {row.append(h('span', { class: 'badc' }, '고장 (' + (errPlain(ex.r.error) || ex.r.error) + ')'));}
    else {row.append(h('span', { class: 'muted' }, ex.err || '실행 못 함'));}
    row.append(h('button', { type: 'button', class: 'lk', style: 'margin-left:10px', onclick: () => followFn(fn) }, '▶ 실행 과정 보기'));
    box.append(row);
  }
  return box;
}
function viewLines(fn, sv) {
  const box = h('div');
  box.append(h('div', { class: 'note' }, '코드를 위에서부터 한 줄씩, 무슨 뜻인지 풀어 읽어요.'));
  const st = sv.lines;
  const aiMap = {};
  if (st && st.data) {st.data.lines.forEach((x) => { aiMap[x.line] = x.plain; });}
  const t = h('div', { class: 'linesv' });
  fn.code.split('\n').forEach((line, i) => {
    if (!line.trim()) {return;}
    t.append(h('div', { class: 'lv-row' }, h('span', { class: 'g' }, fn.start + i + 1), h('code', null, line.replace(/^\s+/, (m) => ' '.repeat(m.length))),
      h('div', { class: 'lv-t' }, aiMap[i + 1] || explainLine(line, null, fn.lang))));
  });
  box.append(t);
  if (st && st.busy) {box.append(h('div', { class: 'note' }, h('span', { class: 'spin' }), 'AI 가 더 쉽게 풀어 쓰는 중…'));}
  else if (st && st.data) {box.append(h('div', { class: 'muted', style: 'margin-top:8px;font-size:12px' }, '✦ AI 가 풀어 쓴 설명이에요.'));}
  else {
    if (st && st.err) {box.append(h('div', { class: 'err' }, st.err));}
    if (!S.env.mock) {box.append(h('button', { type: 'button', class: 'btn', style: 'margin-top:10px', onclick: () => ai(sv, 'lines', 'lines') }, '✦ AI 로 더 쉽게 풀어 읽기'));}
  }
  if (fn.callable) {box.append(h('div', { style: 'margin-top:12px' }, h('button', { type: 'button', class: 'btn p', onclick: () => followFn(fn) }, '▶ 실제로 한 줄씩 실행해 보기')));}
  return box;
}
function viewConcepts(fn, sv) {
  const box = h('div');
  const hits = detectConcepts(fn.code, fn.lang, fn.item.function_name, STUDY_CONCEPTS);
  const lines = fn.code.split('\n');
  if (!hits.length) {box.append(h('div', { class: 'note' }, '정해 둔 개념 목록에서는 찾은 게 없어요. 아래 "✦ AI 로 개념 더 찾기"를 눌러 보세요.'));}
  const grid = h('div', { class: 'cards' });
  hits.forEach((hit) => {
    const c = CMAP[hit.id];
    grid.append(h('div', { class: 'card' }, h('span', { class: 'n' }, c.name), h('span', { class: 'lv lv' + c.level }, ['', '기초', '중급', '심화'][c.level]),
      EASY[c.id] ? h('div', { class: 'easy' }, '🙂 쉽게 말하면 · ' + EASY[c.id]) : null,
      h('div', { style: 'margin-top:4px' }, c.summary),
      h('div', { class: 'here' }, h('b', null, '이 코드에서는 '), hit.lines.map((l) => fn.start + l + 1).join(', ') + '번째 줄: ', h('code', null, lines[hit.lines[0]].trim().slice(0, 60))),
      c.misconception ? h('div', { class: 'mis' }, '흔한 오해 · ' + c.misconception) : null,
      c.contrast ? h('div', { class: 'alt' }, '비슷하지만 다른 것 · ' + c.contrast) : null,
      h('div', { class: 'links' },
        h('button', { type: 'button', class: 'lk', onclick: () => { S.mapSel = c.id; S.tab = 'map'; render(); } }, '🗺 지도에서 보기'),
        h('button', { type: 'button', class: 'lk', onclick: () => post('url', { url: c.doc }) }, '📄 공식 문서'),
        h('button', { type: 'button', class: 'lk', onclick: () => askAbout(c.name + ' 를 이 코드 기준으로 쉽게 설명해줘') }, '✦ 더 묻기'))));
  });
  const st = sv.ai;
  if (st && st.data) {st.data.filter((a) => !a.id || !hits.some((x) => x.id === a.id)).forEach((a) => grid.append(h('div', { class: 'card' }, h('span', { class: 'n' }, a.name), h('span', { class: 'lv lv' + a.level }, ['', '기초', '중급', '심화'][a.level]),
    h('span', { class: 'aitag' }, '✦ AI'), h('div', { style: 'margin-top:4px' }, a.summary),
    a.in_this_code ? h('div', { class: 'here' }, h('b', null, '이 코드에서는 '), a.in_this_code) : null,
    a.misconception ? h('div', { class: 'mis' }, '흔한 오해 · ' + a.misconception) : null)));}
  box.append(grid);
  const ab = h('div', { style: 'margin-top:12px' });
  if (st && st.busy) {ab.append(h('div', { class: 'note' }, h('span', { class: 'spin' }), 'AI 가 이 코드의 개념을 더 찾는 중…'));}
  else {
    if (st && st.err) {ab.append(h('div', { class: 'err' }, st.err));}
    ab.append(h('button', { type: 'button', class: 'btn', onclick: () => ai(sv, 'ai', 'concepts', {}) }, st && st.data ? '✦ AI 로 다시 찾기' : '✦ AI 로 개념 더 찾기'));
  }
  box.append(ab);
  return box;
}
function viewMine(fn, sv) {
  const box = h('div');
  box.append(h('div', { class: 'note' }, '이 코드가 무엇을 하는지 내 말로 설명해 보세요. AI 가 맞은 곳 · 부족한 곳 · 틀린 곳을 짚어 줘요.'));
  box.append(h('pre', { class: 'pre' }, fn.code));
  const ta = h('textarea', { class: 'ta', 'data-k': 'mine', placeholder: '예: values 에서 짝수만 골라서 새 목록으로 돌려준다', oninput: (e) => { sv.mineText = e.target.value; } });
  ta.value = sv.mineText || '';
  box.append(h('div', { style: 'margin-top:8px' }, ta));
  const st = sv.mine;
  box.append(h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { type: 'button', class: 'btn p', disabled: !!(st && st.busy), onclick: () => {
    const t = (sv.mineText || '').trim();
    if (t.length < 5) { toast('조금 더 써 주세요'); return; }
    ai(sv, 'mine', 'explain', { answer: t });
  } }, '✦ 채점 받기')));
  if (!stateView(st, box) && st && st.data) {
    st.data.points.forEach((p) => box.append(h('div', { class: p.verdict === 'ok' ? 'here' : p.verdict === 'wrong' ? 'mis' : 'alt' }, (p.verdict === 'ok' ? '✓ 맞아요 · ' : p.verdict === 'wrong' ? '✗ 틀렸어요 · ' : '△ 부족해요 · ') + p.text)));
  }
  return box;
}
function viewWhy(fn, sv) {
  const box = h('div');
  box.append(h('div', { class: 'note' }, '왜 이렇게 짰는지, 다른 방법으로 짜면 무엇이 달라지는지 비교해요.'));
  const st = sv.why;
  if (!st || (!st.busy && !st.data)) {
    if (st && st.err) {box.append(h('div', { class: 'err' }, st.err));}
    box.append(h('button', { type: 'button', class: 'btn p', onclick: () => ai(sv, 'why', 'why') }, '✦ 다른 방법과 비교해 보기'));
    return box;
  }
  if (stateView(st, box)) {return box;}
  const d = st.data;
  if (d.complexity && (d.complexity.time || d.complexity.note)) {box.append(h('div', { class: 'here' }, h('b', null, '얼마나 빠른가요? '), [d.complexity.time && '시간 ' + d.complexity.time, d.complexity.space && '메모리 ' + d.complexity.space].filter(Boolean).join(' · '), d.complexity.note ? ' — ' + d.complexity.note : ''));}
  d.alternatives.forEach((a) => box.append(h('div', { class: 'card', style: 'margin-top:10px' }, h('div', { class: 'n' }, a.label),
    a.code ? h('pre', null, a.code) : null,
    h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, [a.speed && '속도 ' + a.speed, a.memory && '메모리 ' + a.memory, a.readability && '읽기 ' + a.readability].filter(Boolean).join(' · ')),
    a.note ? h('div', { class: 'alt' }, a.note) : null)));
  d.deeper.forEach((x) => box.append(h('div', { class: 'card', style: 'margin-top:10px' }, h('div', { class: 'n' }, x.title), h('div', null, x.text),
    x.doc ? h('button', { type: 'button', class: 'lk', onclick: () => post('url', { url: x.doc }) }, '📄 더 읽기') : null)));
  box.append(h('button', { type: 'button', class: 'btn', style: 'margin-top:10px', onclick: () => { sv.why = null; ai(sv, 'why', 'why'); } }, '다시 만들기'));
  return box;
}
// 퀴즈: 정답은 진짜로 실행한 결과
function viewQuiz(fn, sv) {
  const box = h('div');
  if (!fn.callable) { box.append(h('div', { class: 'note' }, '함수가 아닌 코드 조각이라 실행 퀴즈를 만들 수 없어요. "줄별 설명"이나 "코드 리뷰"를 써 보세요.')); return box; }
  const q = sv.quiz;
  if (!q) {
    sv.quiz = { busy: true };
    buildQuiz(fn).then((qs) => { sv.quiz = { qs, picks: {}, hints: {} }; }, (e) => { sv.quiz = { err: errText(e) }; }).then(() => render());
    box.append(h('div', { class: 'note' }, h('span', { class: 'spin' }), '코드를 실제로 돌려서 퀴즈를 만드는 중…'));
    return box;
  }
  if (q.busy) { box.append(h('div', { class: 'note' }, h('span', { class: 'spin' }), '코드를 실제로 돌려서 퀴즈를 만드는 중…')); return box; }
  if (q.err) {
    box.append(h('div', { class: 'err' }, '퀴즈를 만들지 못했어요: ' + q.err));
    box.append(h('button', { type: 'button', class: 'btn', onclick: () => { sv.quiz = null; render(); } }, '다시 시도'));
    return box;
  }
  box.append(h('div', { class: 'note' }, '정답은 이 코드를 실제로 실행해서 얻은 결과예요. 모르면 💡 힌트를 눌러 보세요.'));
  q.qs.forEach((qq, qi) => {
    const pick = q.picks[qi];
    const el = h('div', { class: 'q' }, h('div', { class: 'qh' }, '퀴즈 ' + (qi + 1) + ' / ' + q.qs.length + ' · ' + qq.kind), h('div', { class: 'qt' }, qq.prompt));
    if (qq.code) {el.append(h('pre', { class: 'pre' }, qq.code));}
    qq.choices.forEach((c, ci) => {
      const done = !nil(pick);
      el.append(h('button', { type: 'button', class: 'opt' + (done && ci === qq.answer ? ' ok' : done && ci === pick ? ' bad' : ''), disabled: done, onclick: () => { q.picks[qi] = ci; render(); } },
        h('span', { class: 'ok-mark' }, done ? (ci === qq.answer ? '✓' : ci === pick ? '✗' : '') : String.fromCharCode(65 + ci)), c));
    });
    if (nil(pick)) {
      const hint = qq.hint || ('줄별로 읽어 보면: ' + fn.code.split('\n').slice(1, 3).map((l) => explainLine(l, null, fn.lang)).join(' '));
      el.append(q.hints[qi] ? h('div', { class: 'alt' }, '힌트 · ' + hint) : h('button', { type: 'button', class: 'lk', style: 'margin-top:6px', onclick: () => { q.hints[qi] = true; render(); } }, '💡 힌트 보기'));
    } else {
      el.append(h('div', { class: pick === qq.answer ? 'here' : 'mis' }, (pick === qq.answer ? '맞았어요! ' : '아쉬워요. ') + qq.explain));
      if (qq.call) {el.append(h('div', { style: 'margin-top:6px' }, h('button', { type: 'button', class: 'lk', onclick: () => followFn(fn, qq.call) }, '▶ 이 입력으로 실행 과정 보기')));}
    }
    box.append(el);
  });
  box.append(h('button', { type: 'button', class: 'btn', onclick: () => { sv.quiz = null; render(); } }, '다른 입력으로 다시 만들기'));
  return box;
}
function buildQuiz(fn) {
  const v = [0, 1, 2].map((k) => suggestCall(fn, k));
  const nul = fn.lang === 'python' ? 'None' : 'null';
  const extra = [fn.name + '(' + paramNames(fn.params).map(() => nul).join(', ') + ')'];
  return runCalls(fn, v.concat(extra)).then((rs) => {
    const qs = [];
    const outs = rs.map(showOut);
    const mk = (kind, prompt, c, right, pool, explain) => {
      const set = [right];
      pool.forEach((p) => { if (p && set.indexOf(p) < 0 && set.length < 4) {set.push(p);} });
      mutate(right).concat([nul, '[]', '0', '오류: TypeError', "''"]).forEach((p) => { if (set.indexOf(p) < 0 && set.length < 4) {set.push(p);} });
      const choices = shuffle(set.slice());
      qs.push({ kind, prompt, code: c, call: c, choices, answer: choices.indexOf(right), explain });
    };
    mk('결과 맞히기', '이 함수에 아래 입력값을 넣으면 무엇이 나올까요?', v[0], outs[0], [outs[1], outs[2]], '실제로 돌려 보면 ' + outs[0] + ' 이(가) 나와요. 왜 그런지 "실행 과정 보기"로 확인해 보세요.');
    if (outs[2] !== outs[0]) {mk('빈 값 넣기', '텅 빈 값(또는 0)을 넣으면 어떻게 될까요?', v[2], outs[2], [outs[0], outs[3]], '실제로 돌려 보면 ' + outs[2] + ' 이(가) 나와요. 이런 빈 값에서 실수가 자주 숨어 있어요.' + (rs[2].error ? ' 쉬운 말로: ' + errPlain(rs[2].error) : ''));}
    else {mk('빈 값 넣기', '아무것도 없는 값(' + nul + ')을 넣으면 어떻게 될까요?', extra[0], outs[3], [outs[0], outs[2]], '실제로 돌려 보면 ' + outs[3] + ' 이(가) 나와요.' + (rs[3].error ? ' 쉬운 말로: ' + errPlain(rs[3].error) : ''));}
    const hits = detectConcepts(fn.code, fn.lang, fn.item.function_name, STUDY_CONCEPTS);
    if (hits.length) {
      const hit = hits[Math.floor(Math.random() * hits.length)];
      const line = fn.code.split('\n')[hit.lines[0]].trim();
      const ls = langShort(fn.lang);
      const others = shuffle(STUDY_CONCEPTS.filter((c) => c.id !== hit.id && (c.langs.indexOf(ls) >= 0 || (ls === 'ts' && c.langs.indexOf('js') >= 0)) && !hits.some((x) => x.id === c.id))).slice(0, 3).map((c) => c.name);
      const choices = shuffle([CMAP[hit.id].name].concat(others));
      qs.push({ kind: '개념', prompt: '이 줄에 쓰인 생각하는 방법(개념)은 무엇일까요?', code: line, choices, answer: choices.indexOf(CMAP[hit.id].name), explain: CMAP[hit.id].summary + (EASY[hit.id] ? ' ' + EASY[hit.id] : ''), hint: EASY[hit.id] || CMAP[hit.id].summary });
    }
    return qs;
  });
}
function viewBreak(fn, sv) {
  const box = h('div');
  if (!fn.callable) { box.append(h('div', { class: 'note' }, '함수가 아닌 코드 조각이라 입력값을 넣어 볼 수 없어요.')); return box; }
  box.append(h('div', { class: 'note' }, '함수에 엉뚱한 입력값을 넣어 보면서 어디서 고장 나는지 찾아봐요. 한 줄에 하나씩 써요. 진짜로 실행돼요.'));
  const nul = fn.lang === 'python' ? 'None' : 'null';
  const ps = paramNames(fn.params);
  if (nil(sv.breakText)) {sv.breakText = [suggestCall(fn, 0), suggestCall(fn, 2), fn.name + '(' + ps.map(() => nul).join(', ') + ')', fn.name + '(' + ps.map(() => "'abc'").join(', ') + ')'].join('\n');}
  const addLine = (v) => { sv.breakText = (sv.breakText || '').replace(/\s*$/, '') + '\n' + fn.name + '(' + ps.map(() => v).join(', ') + ')'; render(); };
  box.append(h('div', { class: 'chips', style: 'margin-bottom:6px' }, h('span', { class: 'muted', style: 'font-size:12px' }, '빠르게 넣기:'),
    [['텅 빈 목록', '[]'], ['없음', nul], ['글자', "'abc'"], ['0', '0'], ['음수', '-5'], ['아주 큰 수', fn.lang === 'python' ? '10**6' : '1e6']].map(([t, v]) => h('button', { type: 'button', class: 'chip', onclick: () => addLine(v) }, t))));
  const ta = h('textarea', { class: 'ta codeta', 'data-k': 'break', spellcheck: 'false', oninput: (e) => { sv.breakText = e.target.value; } });
  ta.value = sv.breakText;
  box.append(ta);
  const st = sv.brk;
  box.append(h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { type: 'button', class: 'btn p', disabled: !!(st && st.busy), onclick: () => {
    const calls = sv.breakText.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 12);
    sv.brk = { busy: true }; render();
    runCalls(fn, calls).then((r) => { sv.brk = { rows: r }; }, (e) => { sv.brk = { err: errText(e) }; }).then(() => render());
  } }, '▶ 실행')));
  if (st && st.busy) {box.append(h('div', { class: 'note' }, h('span', { class: 'spin' }), '실행 중…'));}
  if (st && st.err) {box.append(h('div', { class: 'err' }, st.err));}
  if (st && st.rows) {
    const broke = st.rows.filter((r) => r.error).length;
    box.append(h('div', { class: broke ? 'mis' : 'here', style: 'margin-top:8px' }, broke ? broke + '개 입력에서 고장 났어요. 어떤 입력을 막아야 할지 생각해 보세요.' : '모든 입력을 잘 버텼어요. 더 이상한 입력을 넣어 보세요.'));
    box.append(h('table', { class: 'tbl' }, h('tr', null, h('th', null, '넣은 것'), h('th', null, '결과'), h('th', null, '쉬운 말로')),
      st.rows.map((r) => h('tr', null, h('td', null, h('code', null, r.call)), h('td', { class: r.error ? 'badc' : '' }, h('code', null, r.error || r.output)),
        h('td', null, r.error ? (errPlain(r.error) || '여기서 고장 났어요.') : '잘 돌아갔어요.')))));
    if (broke) {box.append(h('div', { style: 'margin-top:8px' }, h('button', { type: 'button', class: 'lk', onclick: () => askAbout('이 입력에서 왜 고장 나는지, 어떻게 막으면 좋을지 쉽게 알려줘: ' + st.rows.filter((r) => r.error).map((r) => r.call + ' → ' + r.error).join(' / ')) }, '✦ 왜 고장 나는지 묻기')));}
  }
  return box;
}
function viewTask(fn, sv) {
  const box = h('div');
  const st = sv.task;
  box.append(h('div', { class: 'note' }, 'AI 가 이 코드를 조금 바꾸는 과제를 내고, 내가 고친 코드를 테스트로 진짜 채점해요.'));
  if (!st || (!st.busy && !st.data)) {
    if (st && st.err) {box.append(h('div', { class: 'err' }, st.err));}
    box.append(h('button', { type: 'button', class: 'btn p', onclick: () => ai(sv, 'task', 'task', {}, (d) => { sv.taskCode = d.starter || fn.code; sv.taskRun = null; }) }, '✦ 과제 받기'));
    return box;
  }
  if (stateView(st, box)) {return box;}
  const d = st.data;
  box.append(h('div', { class: 'here' }, d.task));
  const ta = h('textarea', { class: 'ta codeta', 'data-k': 'task', spellcheck: 'false', style: 'margin-top:8px;min-height:180px', oninput: (e) => { sv.taskCode = e.target.value; } });
  ta.value = sv.taskCode || '';
  box.append(ta);
  const tr = sv.taskRun;
  box.append(h('div', { class: 'row', style: 'margin-top:6px' },
    h('button', { type: 'button', class: 'btn p', disabled: !!(tr && tr.busy), onclick: () => {
      sv.taskRun = { busy: true }; render();
      runCode(fn, sv.taskCode, d.tests).then((cases) => { sv.taskRun = { cases }; }, (e) => { sv.taskRun = { err: errText(e) }; }).then(() => render());
    } }, '▶ 테스트 실행'),
    h('button', { type: 'button', class: 'btn', onclick: () => { sv.task = null; sv.taskRun = null; render(); } }, '다른 과제')));
  if (tr && tr.busy) {box.append(h('div', { class: 'note' }, h('span', { class: 'spin' }), '테스트 실행 중…'));}
  if (tr && tr.err) {box.append(h('div', { class: 'err' }, tr.err));}
  const rows = tr && tr.cases ? tr.cases : d.tests.map((t) => ({ call: t.call, expected: t.expected, output: '', error: '', ok: null }));
  const pass = rows.filter((r) => r.ok).length;
  if (tr && tr.cases) {box.append(h('div', { class: pass === rows.length ? 'here' : 'mis', style: 'margin-top:8px' }, pass === rows.length ? '테스트 ' + pass + '개 모두 통과했어요!' : rows.length + '개 중 ' + pass + '개 통과했어요.'));}
  box.append(h('table', { class: 'tbl' }, h('tr', null, h('th', null, ''), h('th', null, '넣은 것'), h('th', null, '기대'), h('th', null, '실제')),
    rows.map((r) => h('tr', null, h('td', { class: r.ok ? 'okc' : r.ok === false ? 'badc' : 'muted' }, r.ok ? '✓' : r.ok === false ? '✗' : '·'),
      h('td', null, h('code', null, r.call)), h('td', null, h('code', null, r.expected)), h('td', { class: r.error ? 'badc' : '' }, h('code', null, r.error || r.output))))));
  return box;
}
function viewBug(fn, sv) {
  const box = h('div');
  const st = sv.bug;
  box.append(h('div', { class: 'note' }, 'AI 가 이 코드에 틀린 곳을 하나 몰래 넣어요. 틀린 줄을 눌러 찾아보세요.'));
  if (!st || (!st.busy && !st.data)) {
    if (st && st.err) {box.append(h('div', { class: 'err' }, st.err));}
    box.append(h('button', { type: 'button', class: 'btn p', onclick: () => ai(sv, 'bug', 'bug', {}, () => { sv.bugPick = null; }) }, '✦ 틀린 곳이 들어간 코드 받기'));
    return box;
  }
  if (stateView(st, box)) {return box;}
  const d = st.data;
  const pick = sv.bugPick;
  const cl = h('div', { class: 'codelines' });
  d.code.split('\n').forEach((t, i) => cl.append(h('button', { type: 'button', disabled: !nil(pick), class: !nil(pick) && i + 1 === d.line ? 'answer' : pick === i + 1 ? 'picked' : '', onclick: () => { sv.bugPick = i + 1; render(); } },
    h('span', { class: 'g' }, i + 1), t || ' ')));
  box.append(cl);
  if (!nil(pick)) {
    box.append(h('div', { class: pick === d.line ? 'here' : 'mis', style: 'margin-top:8px' }, (pick === d.line ? '찾았어요! ' : '아쉬워요. 틀린 곳은 ' + d.line + '번째 줄이에요. ') + d.explain));
    if (d.fixed_line) {box.append(h('pre', { class: 'pre' }, '고친 줄: ' + d.fixed_line));}
    box.append(h('button', { type: 'button', class: 'btn', style: 'margin-top:8px', onclick: () => { sv.bug = null; render(); } }, '다른 문제'));
  }
  return box;
}
function viewTranslate(fn, sv) {
  const box = h('div');
  const to = fn.lang === 'python' ? 'javascript' : 'python';
  const toName = to === 'python' ? 'Python' : 'JavaScript';
  box.append(h('div', { class: 'note' }, '같은 일을 ' + toName + ' 로 쓰면 어떻게 달라지는지 봐요. 왜 다른지도 같이 보여줘요.'));
  const st = sv.tr;
  if (!st || (!st.busy && !st.data)) {
    if (st && st.err) {box.append(h('div', { class: 'err' }, st.err));}
    box.append(h('button', { type: 'button', class: 'btn p', onclick: () => ai(sv, 'tr', 'translate', { target: to }) }, '✦ ' + toName + ' 로 보기'));
    return box;
  }
  if (stateView(st, box)) {return box;}
  const d = st.data;
  box.append(h('div', { class: 'cards' }, h('div', { class: 'card' }, h('div', { class: 'lbl' }, '원래'), h('pre', null, fn.code)),
    h('div', { class: 'card' }, h('div', { class: 'lbl' }, d.language || toName), h('pre', null, d.code),
      h('div', { class: 'links' }, h('button', { type: 'button', class: 'lk', onclick: () => post('copy', { text: d.code }) }, '복사')))));
  if (d.notes.length) {box.append(h('table', { class: 'tbl', style: 'margin-top:10px' }, h('tr', null, h('th', null, '원래'), h('th', null, '바꾼 것'), h('th', null, '왜')),
    d.notes.map((n) => h('tr', null, h('td', null, h('code', null, n.from)), h('td', null, h('code', null, n.to)), h('td', null, n.why)))));}
  return box;
}
function viewReview(fn, sv) {
  const box = h('div');
  box.append(h('div', { class: 'note' }, '선배 개발자처럼 이 코드를 리뷰해요. 고친 코드는 내 코드와 나란히 비교할 수 있어요.'));
  const st = sv.rev;
  if (!st || (!st.busy && !st.data)) {
    if (st && st.err) {box.append(h('div', { class: 'err' }, st.err));}
    box.append(h('button', { type: 'button', class: 'btn p', onclick: () => ai(sv, 'rev', 'review') }, '✦ 리뷰 받기'));
    return box;
  }
  if (stateView(st, box)) {return box;}
  const d = st.data;
  d.items.forEach((it) => box.append(h('div', { class: it.kind === 'good' ? 'here' : it.kind === 'fix' ? 'mis' : 'alt', style: 'margin-top:6px' },
    h('b', null, (it.kind === 'good' ? '👍 ' : it.kind === 'fix' ? '고칠 점 · ' : '주의 · ') + it.title), it.lines.length ? h('span', { class: 'muted' }, ' (' + it.lines.join(', ') + '줄)') : null,
    h('div', null, it.text))));
  box.append(h('div', { class: 'row', style: 'margin-top:10px' },
    d.improved_code ? h('button', { type: 'button', class: 'btn p', onclick: () => post('diff', { left: fn.code, right: d.improved_code, language: fn.lang, title: fn.name + ' ↔ 리뷰 반영' }) }, '내 코드와 비교') : null,
    h('button', { type: 'button', class: 'btn', onclick: () => { sv.rev = null; render(); } }, '다시 리뷰')));
  return box;
}

// ─────────────────────────────────────────────
// 실행 과정 보기
// ─────────────────────────────────────────────
function followFn(fn, c) {
  S.fn = fn;
  S.trace.raw = !!c;
  if (c) {S.trace.call = c;}
  S.tab = 'trace';
  S.welcomeOpen = false;
  startTrace();
}
function startTrace() {
  const fn = S.fn;
  const T = S.trace;
  stopPlay();
  if (!fn) {return;}
  if (!fn.callable) { T.err = '함수가 아닌 코드 조각이라 실행할 수 없어요. 함수 전체를 선택해 주세요.'; render(); return; }
  if (!T.raw) { ensureArgs(fn); T.call = callFromArgs(fn); }
  T.data = null; T.err = ''; T.i = 0; T.busy = true; T.ai = null; T.aiOn = false; T.fnKey = fn.key;
  post('followStop');
  render();
  const tid = seq + 1;
  call('trace', { item: fn.item, call: T.call }).then((d) => {
    T.id = tid; T.data = d; T.code = d.code || fn.code; T.busy = false;
    render();
    showStep();
    if (!S.env.mock) {fetchNarration(fn);}
  }, (e) => { T.busy = false; T.err = errText(e); render(); });
}
function traceLines() { return String(S.trace.code || '').replace(/\r\n?/g, '\n').split('\n'); }
function showStep() { if (S.trace.data) {post('step', { trace: S.trace.id, step: S.trace.i });} }
function play() {
  stopPlay();
  const T = S.trace;
  if (!T.data) {return;}
  if (T.i >= T.data.steps.length - 1) {T.i = 0;}
  T.timer = setInterval(() => { if (!stepNext()) { stopPlay(); render(); } }, T.speed);
  render();
}
function stopPlay() { if (S.trace.timer) { clearInterval(S.trace.timer); S.trace.timer = null; } }
function stepNext() { const T = S.trace; if (!T.data || T.i >= T.data.steps.length - 1) {return false;} T.i++; render(); showStep(); return true; }
function stepPrev() { const T = S.trace; if (T.data && T.i > 0) { T.i--; render(); showStep(); } }
function stopTrace() { stopPlay(); S.trace.data = null; post('followStop'); render(); }
function fetchNarration(fn) {
  const T = S.trace;
  const d = T.data;
  if (!d) {return;}
  const lines = traceLines();
  const steps = d.steps.slice(0, 80).map((s, i) => {
    const fr = fnFrames(s.frames);
    const top = fr.length ? fr[fr.length - 1].vars : {};
    return (i + 1) + '. ' + s.line + '번째 줄 `' + (lines[s.line - 1] || '').trim() + '` | 값: ' + Object.keys(top).map((k) => k + '=' + top[k]).join(', ') + (s.ret ? ' | 돌려줌: ' + s.ret : '') + ' | 실행 중인 함수 ' + fr.length + '개';
  });
  T.ai = { busy: true };
  call('ai', { mode: 'narrate', req: { code: T.code.slice(0, 8000), language: fn.lang, function_name: fn.item.function_name || fn.name, call: T.call, steps } })
    .then((r) => { if (T.data !== d) {return;} T.ai = r; T.aiOn = true; }, (e) => { if (T.data === d) {T.ai = { err: errText(e) };} })
    .then(() => { if (S.tab === 'trace') {render();} });
}
// 실행 중인 코드 — 창으로 떼어서 편집기가 안 보여도 여기서 지금 줄이 보이게
function codeBox(lines, steps, i) {
  const st = steps[i];
  const used = steps.map((x) => x.line);
  const fnFirst = S.fn ? S.fn.code.split('\n')[0].trim() : '';
  let from = Math.min.apply(null, used) - 1;
  let to = Math.max.apply(null, used);
  const def = lines.findIndex((l) => fnFirst && l.trim() === fnFirst);
  if (def >= 0) { from = Math.min(from, def + 1); to = Math.max(to, def + (S.fn ? S.fn.code.split('\n').length : 0)); }
  from = Math.max(1, from); to = Math.min(lines.length, to);
  const cnt = {};
  steps.slice(0, i + 1).forEach((x) => { cnt[x.line] = (cnt[x.line] || 0) + 1; });
  const fr = fnFrames(st.frames);
  const top = fr.length ? fr[fr.length - 1].vars : {};
  const val = st.ret || Object.keys(top).slice(0, 3).map((k) => k + ' = ' + top[k]).join(' · ');
  const box = h('div', { class: 'codebox', 'aria-label': '실행 중인 코드' });
  for (let n = from; n <= to; n++) {
    const cur = n === st.line;
    const row = h('div', { class: 'cl' + (cur ? ' cur' : '') }, h('span', { class: 'g' }, n), h('span', { class: 'tx' }, lines[n - 1] || ' '));
    if (cur && val) {row.append(h('span', { class: 'iv' }, (st.ret ? '↩ ' : '') + val));}
    else if (cnt[n]) {row.append(h('span', { class: 'hx' }, '×' + cnt[n]));}
    box.append(row);
  }
  requestAnimationFrame(() => { const c = box.querySelector('.cl.cur'); if (c && box.isConnected) { const r = c.offsetTop - box.clientHeight / 2; box.scrollTop = Math.max(0, r); } });
  return box;
}
function tracePane() {
  const pane = h('div', { class: 'pane' });
  const wc = welcomeCard(); if (wc) {pane.append(wc);}
  const fn = S.fn;
  if (!fn) { pane.append(noTarget('실행 과정을 볼')); return pane; }
  const T = S.trace;
  pane.append(targetHead(fn));
  if (!fn.callable) { pane.append(h('div', { class: 'note' }, '함수가 아닌 코드 조각이라 실행할 수 없어요. 편집기에서 함수 위의 ▶ 실행 과정 보기를 눌러 주세요.')); return pane; }
  pane.append(argsBox(fn));
  if (T.busy) { pane.append(h('div', { class: 'note' }, h('span', { class: 'spin' }), fn.lang === 'python' && S.env.localRun ? '내 PC 의 Python 으로 실행하는 중…' : '실행하는 중…')); return pane; }
  if (T.err) {
    pane.append(h('div', { class: 'err' }, '실행하다 멈췄어요: ' + T.err));
    if (errPlain(T.err)) {pane.append(h('div', { class: 'mis' }, '쉬운 말로: ' + errPlain(T.err)));}
  }
  if (!T.data || T.fnKey !== fn.key) {
    pane.append(h('div', { class: 'note' }, '"▶ 실행해 보기"를 누르면 컴퓨터가 이 코드를 한 줄씩 실행하는 모습을 해설과 함께 보여줘요. 왼쪽 코드에도 지금 줄이 표시돼요. 입력값을 바꿔 보면서 결과가 어떻게 달라지는지도 볼 수 있어요.'));
    return pane;
  }
  const steps = T.data.steps;
  const last = steps.length - 1;
  const st = steps[T.i];
  const lines = traceLines();
  const aiText = T.aiOn && T.ai && T.ai.steps && T.ai.steps[T.i];
  const card = h('div', { class: 'narr' });
  card.append(h('div', { class: 'narr-h' }, h('b', null, '지금 무슨 일이?'), h('span', { class: 'muted' }, (T.i + 1) + ' / ' + steps.length + '단계' + (T.data.truncated ? ' (400단계에서 멈춤)' : ''))));
  card.append(h('div', { class: 'narr-code' }, h('span', { class: 'g' }, st.line + '번째 줄'), h('code', null, (lines[st.line - 1] || '').trim() || ' ')));
  card.append(h('div', { class: 'narr-t' }, aiText || narrate(T, T.i, lines)));
  const sw = h('div', { class: 'narr-sw' });
  const a = T.ai;
  if (a && a.busy) {sw.append(h('span', { class: 'muted' }, h('span', { class: 'spin' }), 'AI 가 더 쉬운 해설을 쓰는 중이에요. 그동안 기본 해설로 보여드려요.'));}
  else if (a && a.steps) {sw.append(h('span', { class: 'muted' }, '해설:'),
    h('button', { type: 'button', class: 'seg' + (!T.aiOn ? ' on' : ''), onclick: () => { T.aiOn = false; render(); } }, '기본'),
    h('button', { type: 'button', class: 'seg' + (T.aiOn ? ' on' : ''), onclick: () => { T.aiOn = true; render(); } }, '✦ AI (더 쉽게)'));}
  else if (a && a.err) {sw.append(h('span', { class: 'muted' }, 'AI 해설을 못 받았어요 · '), h('button', { type: 'button', class: 'lk', onclick: () => fetchNarration(fn) }, '다시'));}
  card.append(sw);
  const right = h('div', { class: 'trace-right' });
  right.append(card);
  right.append(h('div', { class: 'row', style: 'margin-top:10px' },
    h('button', { type: 'button', class: 'btn', disabled: T.i === 0, onclick: () => { stopPlay(); stepPrev(); } }, '◀ 이전'),
    h('button', { type: 'button', class: 'btn p', onclick: () => { if (T.timer) { stopPlay(); render(); } else {play();} } }, T.timer ? '⏸ 멈춤' : '▶ 자동 재생'),
    h('button', { type: 'button', class: 'btn', disabled: T.i === last, onclick: () => { stopPlay(); stepNext(); } }, '다음 ▶'),
    h('button', { type: 'button', class: 'btn', onclick: () => { stopPlay(); T.i = 0; render(); showStep(); } }, '처음으로'),
    h('label', { class: 'muted speed' }, '속도', h('select', { class: 'sel', onchange: (e) => { T.speed = Number(e.target.value); persist(); if (T.timer) {play();} } },
      [[3000, '천천히'], [1800, '보통'], [900, '빠르게']].map(([v, t]) => h('option', { value: v, selected: T.speed === v }, t)))),
    h('button', { type: 'button', class: 'btn', onclick: stopTrace }, '멈추기')));
  right.append(h('input', { type: 'range', class: 'scrub', min: 0, max: last, value: T.i, 'aria-label': '단계 고르기', oninput: (e) => { stopPlay(); T.i = Number(e.target.value); render(); showStep(); } }));
  right.append(h('div', { class: 'muted', style: 'font-size:12px' }, '키보드: → 또는 F10 다음 · ← 이전 · Space 재생/멈춤 · Esc 끝내기'));
  if (T.i === last) {
    const done = h('div', { class: 'done' }, h('b', null, '다 끝났어요! '), '최종 결과: ', h('code', null, String(!nil(T.data.value) ? T.data.value : (steps[last].ret || ''))));
    if (a && a.summary) {done.append(h('div', { style: 'margin-top:6px' }, '✦ 한마디로: ' + a.summary));}
    done.append(h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { type: 'button', class: 'btn', onclick: () => { T.i = 0; render(); showStep(); } }, '처음부터 다시 보기'),
      h('button', { type: 'button', class: 'btn', onclick: () => { const x = document.querySelector('[data-k="arg0"]') || document.querySelector('[data-k="call"]'); if (x) { x.focus(); x.select(); } } }, '다른 값 넣어 보기'),
      h('button', { type: 'button', class: 'btn', onclick: () => askAbout(T.call + ' 의 결과가 왜 이렇게 나오는지 쉽게 설명해줘') }, '✦ 왜 이 결과인지 묻기')));
    right.append(done);
  }
  pane.append(h('div', { class: 'trace-main' }, codeBox(lines, steps, T.i), right));
  const grid = h('div', { class: 'tr-grid' });
  const prev = T.i > 0 ? steps[T.i - 1] : null;
  const frames = fnFrames(st.frames).slice().reverse();
  const pf = prev ? fnFrames(prev.frames) : [];
  const pvTop = prev && pf.length === fnFrames(st.frames).length && pf.length ? pf[pf.length - 1].vars : {};
  const c1 = h('div', null, h('div', { class: 'lbl' }, term('실행 중인 함수'), ' (위가 지금 실행 중)'));
  if (!frames.length) {c1.append(h('div', { class: 'muted' }, '—'));}
  frames.forEach((f, fi) => {
    const now = fi === 0;
    const el = h('div', { class: 'fr' + (now ? ' top' : '') }, h('span', { class: 'h' }, f.name + (now ? ' ← 지금 실행 중' : ' · 결과를 기다리는 중')));
    const ks = Object.keys(f.vars || {});
    if (!ks.length) {el.append(h('span', { class: 'v muted' }, '(아직 담은 값 없음)'));}
    ks.forEach((k) => el.append(h('span', { class: 'v' + (now && prev && pvTop[k] !== f.vars[k] ? ' chg' : '') }, k + ' = ' + f.vars[k] + (now && prev && pvTop[k] !== undefined && pvTop[k] !== f.vars[k] ? '   (방금 ' + pvTop[k] + ' 에서 바뀜)' : ''))));
    c1.append(el);
  });
  const c2 = h('div', null, h('div', { class: 'lbl' }, term('리스트'), ' 내용'));
  const objs = st.objects || [];
  if (!objs.length) {c2.append(h('div', { class: 'muted' }, '이 단계엔 리스트가 없어요'));}
  objs.forEach((o) => c2.append(h('div', { class: 'muted', style: 'font-size:11.5px' }, o.label + ' (' + o.items.length + '개)'), h('div', { class: 'cells' }, o.items.map((x) => h('span', null, x)))));
  const cnt = {}; let maxDepth = 0;
  steps.forEach((s) => { cnt[s.line] = (cnt[s.line] || 0) + 1; maxDepth = Math.max(maxDepth, fnFrames(s.frames).length); });
  const hot = Object.keys(cnt).sort((x, y) => cnt[y] - cnt[x])[0];
  const c3 = h('div', { class: 'cost' }, h('div', { class: 'lbl' }, '실행 통계'),
    h('div', null, h('span', null, '실행한 단계'), h('b', null, steps.length + '번')),
    h('div', null, h('span', null, '가장 많이 실행된 줄'), h('b', null, hot + '번째 줄 (' + cnt[hot] + '번)')),
    h('div', null, h('span', null, '동시에 실행 중이던 함수 최대'), h('b', null, maxDepth + '개')));
  if (maxDepth > 1) {c3.append(h('div', { class: 'muted', style: 'font-size:11.5px;margin-top:4px' }, '실행 중인 함수가 여러 개라는 건 함수가 또 다른 함수(또는 자기 자신)를 불렀다는 뜻이에요.'));}
  if (T.data.stdout) {c3.append(h('div', { class: 'lbl', style: 'margin-top:8px' }, '화면에 출력된 글자'), h('div', { class: 'stdout' }, T.data.stdout));}
  grid.append(c1, c2, c3);
  pane.append(grid);
  return pane;
}
function argsBox(fn) {
  const T = S.trace;
  ensureArgs(fn);
  const ps = paramNames(fn.params);
  const box = h('div', { class: 'argbox' });
  box.append(h('div', { class: 'lbl' }, term('입력값'), ' (바꿔 봐도 돼요)'));
  if (!T.raw && ps.length) {
    const grid = h('div', { class: 'args' });
    ps.forEach((p, i) => {
      const v = T.args[p];
      grid.append(h('label', { class: 'arg' }, h('span', { class: 'an' }, p), h('span', { class: 'at' }, kindOf(v)),
        h('input', { class: 'inp', 'data-k': 'arg' + i, value: v, spellcheck: 'false',
          oninput: (e) => { T.args[p] = e.target.value; T.call = callFromArgs(fn); const cp = document.getElementById('callprev'); if (cp) {cp.textContent = T.call;} const at = e.target.parentNode.querySelector('.at'); if (at) {at.textContent = kindOf(e.target.value);} },
          onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) {startTrace();} } })));
    });
    box.append(grid);
  } else if (!ps.length && !T.raw) {
    box.append(h('div', { class: 'muted' }, '이 함수는 입력값이 필요 없어요.'));
  } else {
    box.append(h('input', { class: 'inp wide', 'data-k': 'call', value: T.call, spellcheck: 'false', 'aria-label': '실행할 식', oninput: (e) => { T.call = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) {startTrace();} } }));
  }
  box.append(h('div', { class: 'row', style: 'margin-top:8px' },
    h('span', { class: 'muted', style: 'font-size:12px' }, '실행할 식: ', h('code', { id: 'callprev', class: 'cp' }, T.call)),
    h('span', { style: 'flex:1' }),
    h('button', { type: 'button', class: 'lk', onclick: () => { T.raw = !T.raw; if (!T.raw) { T.argsFor = null; ensureArgs(fn); } render(); } }, T.raw ? '칸으로 넣기' : '식 직접 쓰기'),
    h('button', { type: 'button', class: 'btn', onclick: () => { T.variant = (T.variant + 1) % 3; T.raw = false; ensureArgs(fn); render(); } }, '다른 예시 값'),
    h('button', { type: 'button', class: 'btn p', disabled: T.busy, onclick: () => startTrace() }, '▶ 실행해 보기')));
  return box;
}

// ─────────────────────────────────────────────
// AI 대화 (사이드바 AI 대화와 같은 대화 기록을 쓴다)
// ─────────────────────────────────────────────
function askAbout(q) { S.chat.draft = q; S.tab = 'chat'; render(); const t = document.querySelector('[data-k="chatin"]'); if (t) {t.focus();} }
function chatSend(text) {
  const q = String(text || '').trim();
  const c = S.chat.chat;
  if (!q || (c && c.turns.some((t) => t.pending))) {return;}
  const fn = S.fn;
  post('chat', { m: { type: 'send', text: q, useFile: S.chat.useFile, useSel: S.chat.useSel, fn: S.chat.useFn && fn ? { label: fn.name + (fn.file ? ' (' + fn.file + ')' : ''), language: fn.lang, code: fn.code } : null } });
  S.chat.draft = '';
  render();
}
function chatPane() {
  const wrap = h('div', { class: 'chat' });
  const fn = S.fn;
  const ctx = S.chat.ctx || {};
  const chip = (on, label, flip, title) => h('button', { type: 'button', class: 'cx' + (on ? '' : ' off'), 'aria-pressed': on ? 'true' : 'false', title, onclick: () => { flip(); render(); } }, label);
  wrap.append(h('div', { class: 'ctx' }, h('span', { class: 'muted', style: 'font-size:11.5px' }, '같이 보낼 것'),
    fn ? chip(S.chat.useFn, 'ƒ ' + fn.name, () => { S.chat.useFn = !S.chat.useFn; }, '지금 공부하는 코드') : null,
    ctx.selection ? chip(S.chat.useSel, '▭ 선택한 ' + ctx.selection + '줄', () => { S.chat.useSel = !S.chat.useSel; }, '편집기에서 선택한 부분') : null,
    ctx.file ? chip(S.chat.useFile, '📄 ' + ctx.file, () => { S.chat.useFile = !S.chat.useFile; }, '마지막으로 본 파일') : null,
    h('span', { class: 'cx static', title: '질문과 비슷한 저장 코드를 서버가 찾아 [S1] 로 붙여요' }, '🔍 저장한 코드 자동'),
    h('span', { style: 'flex:1' }),
    h('button', { type: 'button', class: 'tbtn', onclick: () => post('chat', { m: { type: 'new' } }) }, '＋ 새 대화')));
  const msgs = h('div', { class: 'msgs', role: 'log', 'aria-live': 'polite' });
  const c = S.chat.chat;
  if (!c || !c.turns.length) {msgs.append(h('div', { class: 'empty', style: 'padding:30px 10px' }, '코드에 대해 뭐든 물어보세요.', h('br'), h('span', { class: 'muted' }, '보고 있는 코드와 비슷한 저장 코드를 같이 보내요.')));}
  else {c.turns.forEach((t, ti) => {
    msgs.append(h('div', { class: 'me' }, t.q));
    const el = h('div', { class: 'ai' }, h('div', { class: 'w' }, '✦ AI' + (t.sources && t.sources.length ? ' · 저장한 코드 ' + t.sources.length + '개 참고' : '') + (t.ctx && t.ctx.length ? ' · ' + t.ctx.join(', ') : '')));
    const bd = h('div', { class: 'bd' });
    if (t.pending && !t.a) {bd.append(h('span', { class: 'spin' }), h('span', { class: 'muted' }, '생각하는 중…'));}
    else if (t.err) {bd.append(h('span', { class: 'err' }, t.err));}
    else {renderMd(bd, t.a, ti);}
    el.append(bd);
    msgs.append(el);
  });}
  wrap.append(msgs);
  const sg = h('div', { class: 'sugg' });
  const busy = c && c.turns.some((t) => t.pending);
  (fn ? ['코드를 하나도 모르는 사람한테 설명해줘', fn.name + ' 를 일상 예시로 설명해줘', '이 코드에서 제일 중요한 줄은?', '이걸 배우려면 뭐부터 알아야 해?', '테스트 코드 만들어줘'] : ['코딩이 처음인데 뭐부터 보면 돼?', '저장한 코드 중에 재귀 쓰는 거 있어?'])
    .forEach((q) => sg.append(h('button', { type: 'button', class: 'sg', disabled: busy, onclick: () => chatSend(q) }, q)));
  wrap.append(sg);
  const ta = h('textarea', { 'data-k': 'chatin', placeholder: 'AI 에게 물어보세요… (Enter 보내기, Shift+Enter 줄바꿈)', 'aria-label': 'AI 에게 질문',
    oninput: (e) => { S.chat.draft = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); chatSend(S.chat.draft); } } });
  ta.value = S.chat.draft;
  wrap.append(h('div', { class: 'cin' }, ta, busy ? h('button', { type: 'button', class: 'btn', onclick: () => post('chat', { m: { type: 'cancel' } }) }, '■ 멈춤') : h('button', { type: 'button', class: 'btn p', onclick: () => chatSend(S.chat.draft) }, '보내기')));
  return wrap;
}
// 답: ```코드``` 는 상자 + 복사 · 삽입 · 비교, `x` 는 인라인 코드, [S1] 은 원본으로
function renderMd(bd, text, turn) {
  String(text || '').split(/```[a-zA-Z]*\n?/).forEach((p, i) => {
    if (i % 2 === 1) {
      const code = p.replace(/\n$/, '');
      bd.append(h('pre', null, code));
      bd.append(h('div', { class: 'ca' }, h('button', { type: 'button', class: 'lk', onclick: () => post('copy', { text: code }) }, '복사'),
        h('button', { type: 'button', class: 'lk', onclick: () => post('insert', { text: code }) }, '편집기에 삽입'),
        S.fn ? h('button', { type: 'button', class: 'lk', onclick: () => post('diff', { left: S.fn.code, right: code, language: S.fn.lang, title: S.fn.name + ' ↔ AI 답' }) }, '내 코드와 비교') : null));
      return;
    }
    p.split(/(`[^`\n]+`|\[S\d+\])/).forEach((s) => {
      if (!s) {return;}
      if (/^`[^`]+`$/.test(s)) {bd.append(h('code', null, s.slice(1, -1)));}
      else if (/^\[S\d+\]$/.test(s)) {bd.append(h('button', { type: 'button', class: 'src', title: '근거 코드 열기', onclick: () => post('chat', { m: { type: 'source', turn, cite: s.slice(1, -1) } }) }, s.slice(1, -1)));}
      else {bd.append(document.createTextNode(s));}
    });
  });
}
function onChat(m) {
  const C = S.chat;
  if (m.type === 'state') { C.chat = m.chat; C.list = m.list || []; C.ctx = m.ctx || C.ctx; }
  else if (m.type === 'ctx') { C.ctx = m.ctx || C.ctx; }
  else if (m.type === 'delta' && C.chat && C.chat.id === m.chatId && C.chat.turns[m.turn]) {
    C.chat.turns[m.turn].a += m.text;
    if (S.tab === 'chat') {
      const msgs = document.querySelector('.msgs');
      const near = msgs && msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
      render();
      const m2 = document.querySelector('.msgs');
      if (m2 && near) {m2.scrollTop = m2.scrollHeight;}
    }
    return;
  } else if (m.type === 'sources' && C.chat && C.chat.id === m.chatId && C.chat.turns[m.turn]) { C.chat.turns[m.turn].sources = m.sources; }
  if (S.tab === 'chat') {
    render();
    if (m.type === 'state') { const m2 = document.querySelector('.msgs'); if (m2) {m2.scrollTop = m2.scrollHeight;} }
  }
}

// ─────────────────────────────────────────────
// 개념 지도
// ─────────────────────────────────────────────
function mapPane() {
  const pane = h('div', { class: 'pane' });
  const nodes = buildConceptGraph(cards(), S.study.known, STUDY_CONCEPTS);
  const learned = nodes.filter((n) => n.status !== 'todo');
  pane.append(h('div', { class: 'row' }, h('div', { class: 'note', style: 'flex:1;margin:0' }, '공부한 코드에 쓰인 개념이 쌓여요. 선은 "먼저 알면 좋은 개념" → 개념.'),
    h('label', { class: 'sopt' }, h('input', { type: 'checkbox', checked: S.mapAll, onchange: (e) => { S.mapAll = e.target.checked; render(); } }), '안 배운 개념도 보기')));
  pane.append(h('div', { class: 'legend' }, [['ok', '탄탄'], ['weak', '약함 (모름·헷갈림)'], ['new', '처음 봄'], ['next', '다음 추천'], ['todo', '아직']].map(([k, t]) => h('span', { class: k }, h('i', { class: 'dot' }), t))));
  if (!learned.length && !S.mapAll) {
    pane.append(h('div', { class: 'empty' }, '아직 공부한 개념이 없어요.', h('br'), h('span', { class: 'muted' }, '📘 공부에서 "얼마나 이해했나요?"에 답하면 여기에 쌓여요.'), h('br'),
      h('button', { type: 'button', class: 'btn', style: 'margin-top:10px', onclick: () => { S.mapAll = true; render(); } }, '전체 개념 목록 보기')));
    return pane;
  }
  let show = S.mapAll ? nodes : nodes.filter((n) => n.status !== 'todo' || nodes.some((m) => m.status !== 'todo' && m.prereq.indexOf(n.id) >= 0));
  const sel = S.mapSel && nodes.find((n) => n.id === S.mapSel);
  const path = sel ? learningPath(sel.id, nodes).map((n) => n.id) : [];
  if (sel && show.indexOf(sel) < 0) {show = show.concat([sel]);}
  path.forEach((id) => { const n = nodes.find((x) => x.id === id); if (n && show.indexOf(n) < 0) {show.push(n);} });
  const map = h('div', { class: 'map', id: 'cmap' });
  [1, 2, 3].forEach((lv) => {
    const col = h('div', { class: 'mcol' }, h('h4', null, ['', '기초', '중급', '심화'][lv]));
    show.filter((n) => n.level === lv).forEach((n) => col.append(h('button', { type: 'button', class: 'mn ' + n.status + (sel && sel.id === n.id ? ' sel' : '') + (path.indexOf(n.id) >= 0 && (!sel || sel.id !== n.id) ? ' inpath' : ''), 'data-id': n.id,
      onclick: () => { S.mapSel = n.id; render(); } }, h('i', { class: 'dot' }), n.name + (n.ai ? ' ✦' : ''), n.count ? h('span', { class: 'c' }, n.count) : null)));
    map.append(col);
  });
  pane.append(h('div', { class: 'scrollx' }, map));
  if (sel) {
    const c = CMAP[sel.id];
    const det = h('div', { class: 'card', style: 'margin-top:12px' }, h('span', { class: 'n' }, sel.name), h('span', { class: 'lv lv' + sel.level }, ['', '기초', '중급', '심화'][sel.level]),
      EASY[sel.id] ? h('div', { class: 'easy' }, '🙂 쉽게 말하면 · ' + EASY[sel.id]) : null,
      h('div', { style: 'margin-top:4px' }, sel.summary || ''), c && c.misconception ? h('div', { class: 'mis' }, '흔한 오해 · ' + c.misconception) : null);
    if (path.length > 1) {det.append(h('div', { class: 'here' }, h('b', null, '배우는 순서 '), path.map((id) => { const n = nodes.find((x) => x.id === id); return (n.status === 'ok' ? '✓ ' : '') + n.name; }).join(' → ')));}
    if (c && c.example) {det.append(h('pre', null, c.example));}
    const used = sel.cards.map((k) => S.study.cards[k]).filter(Boolean);
    if (used.length) {det.append(h('div', { style: 'margin-top:6px' }, h('span', { class: 'muted' }, '이 개념을 쓴 내 코드 · '), used.map((cd) => h('button', { type: 'button', class: 'chip', onclick: () => openItem({ id: cd.id, function_name: cd.function_name, file_path: cd.file_path, project_name: cd.project_name, language: cd.language, start_line: cd.start_line, end_line: cd.end_line, code: cd.code }, 'study') }, cd.name))));}
    det.append(h('div', { class: 'row', style: 'margin-top:8px' },
      c ? h('button', { type: 'button', class: 'lk', onclick: () => post('url', { url: c.doc }) }, '📄 공식 문서') : null,
      !sel.ai ? h('button', { type: 'button', class: 'btn', onclick: () => { if (S.study.known[sel.id] === 'known') {delete S.study.known[sel.id];} else {S.study.known[sel.id] = 'known';} post('study', { study: S.study }); render(); } }, S.study.known[sel.id] === 'known' ? '"아는 개념" 표시 지우기' : '이미 아는 개념이에요') : null,
      h('button', { type: 'button', class: 'btn', onclick: () => askAbout(sel.name + ' 를 예제와 함께 쉽게 설명하고, 연습 문제 하나 내줘') }, '✦ 이 개념 배우기')));
    pane.append(det);
  }
  return pane;
}
function drawMapEdges() {
  const map = document.getElementById('cmap');
  if (!map) {return;}
  const nodes = buildConceptGraph(cards(), S.study.known, STUDY_CONCEPTS);
  const pos = {};
  const mb = map.getBoundingClientRect();
  map.querySelectorAll('.mn').forEach((b) => { const r = b.getBoundingClientRect(); pos[b.getAttribute('data-id')] = { l: r.left - mb.left, r: r.right - mb.left, y: r.top - mb.top + r.height / 2 }; });
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const path = S.mapSel ? learningPath(S.mapSel, nodes).map((n) => n.id) : [];
  nodes.forEach((n) => n.prereq.forEach((p) => {
    const a = pos[p], b = pos[n.id];
    if (!a || !b) {return;}
    const on = path.indexOf(n.id) >= 0 && path.indexOf(p) >= 0;
    const e = document.createElementNS(ns, 'path');
    const mx = (a.r + b.l) / 2;
    e.setAttribute('d', b.l > a.r ? 'M' + a.r + ',' + a.y + ' C' + mx + ',' + a.y + ' ' + mx + ',' + b.y + ' ' + b.l + ',' + b.y : 'M' + a.l + ',' + a.y + ' C' + (a.l - 30) + ',' + a.y + ' ' + (b.l - 30) + ',' + b.y + ' ' + b.l + ',' + b.y);
    e.setAttribute('class', on ? 'edge on' : 'edge');
    svg.append(e);
  }));
  map.prepend(svg);
}

// ─────────────────────────────────────────────
// 확장 본체에서 오는 것
// ─────────────────────────────────────────────
function openItem(item, tab, follow) {
  const fn = fnFromItem(item);
  const same = S.fn && S.fn.key === fn.key && S.fn.code === fn.code;
  S.fn = fn;
  if (!same) { S.trace.raw = false; S.trace.argsFor = null; S.trace.variant = 0; }
  S.welcomeOpen = S.welcomeOpen === true && !S.welcomeSeen ? true : false;
  if (tab === 'study' && !same) { S.group = 'u'; S.sub = 'lines'; }
  S.tab = tab;
  if (tab === 'trace') {
    if (follow && follow.call) { S.trace.raw = true; S.trace.call = follow.call; }
    if (fn.callable && (!same || !S.trace.data)) { startTrace(); return; }
  }
  render();
}
let restored = false;
window.addEventListener('message', (e) => {
  const m = e.data || {};
  switch (m.type) {
    case 'init':
      S.env = Object.assign(S.env, m.env || {});
      if (m.study) {S.study = m.study;}
      restored = restore(m.snap || saved.snap);
      if (restored && S.trace.data) {showStep();}
      render();
      break;
    case 'env':
      S.env = Object.assign(S.env, m.env || {});
      render();
      break;
    case 'study':
      if (m.study) { S.study = m.study; render(); }
      break;
    case 'open':
      // 다시 그려진 직후 같은 코드를 또 열라는 것이면 되살린 화면을 그대로 둔다
      if (restored && !m.follow && (!m.item || (S.fn && S.fn.key === studyKey(m.item)))) { restored = false; break; }
      restored = false;
      if (m.item) {openItem(m.item, m.tab || 'study', m.follow);}
      else { S.tab = m.tab || S.tab; render(); }
      break;
    case 'reply': {
      const w = waiting.get(m.id);
      if (!w) {break;}
      waiting.delete(m.id);
      if (m.error !== undefined) {w.reject({ message: m.error, kind: m.kind });} else {w.resolve(m.data);}
      break;
    }
    case 'traceCmd':
      if (m.cmd === 'next') { stopPlay(); stepNext(); } else if (m.cmd === 'prev') { stopPlay(); stepPrev(); } else { stopPlay(); S.trace.data = null; render(); }
      break;
    case 'followFail':
      toast('편집기에서 이 코드를 찾지 못해서 여기서만 보여드려요');
      break;
    case 'chat':
      if (m.m) {onChat(m.m);}
      break;
  }
});
document.addEventListener('keydown', (e) => {
  const tag = e.target && e.target.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') {return;}
  if (!S.trace.data || S.tab !== 'trace') {return;}
  if (e.key === 'F10' || e.key === 'ArrowRight') { e.preventDefault(); stopPlay(); stepNext(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); stopPlay(); stepPrev(); }
  else if (e.key === ' ' && e.target === document.body) { e.preventDefault(); if (S.trace.timer) { stopPlay(); render(); } else { play(); } }
  else if (e.key === 'Escape') {stopTrace();}
});
render();
post('ready');
post('chat', { m: { type: 'ready' } });
