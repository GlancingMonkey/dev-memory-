// Copied from extension/src/web/jstrace.js at ac30c7a; original frontend code is unchanged.
// JavaScript 실행 과정 — 코드에 "지금 이 줄" 기록을 끼워 넣고(acorn 으로 문법 나무를 읽어서) Worker 에서 진짜로 실행한다
//   결과 모양은 Python 따라가기(src/follow.ts TRACER)와 같다: { call, steps[{line, say, frames, objects, ret}], truncated, value, stdout }
//   이름 있는 함수(선언 · 변수에 담은 함수)만 따라가고, 안에 넣은 콜백은 그 줄 안에서 실행된 것으로 본다
import { parse } from 'acorn';

const MAX_STEPS = 400;

function collectIds(pattern, out) {
  if (!pattern) { return; }
  if (pattern.type === 'Identifier') { out.add(pattern.name); }
  else if (pattern.type === 'AssignmentPattern') { collectIds(pattern.left, out); }
  else if (pattern.type === 'RestElement') { collectIds(pattern.argument, out); }
  else if (pattern.type === 'ArrayPattern') { pattern.elements.forEach((e) => collectIds(e, out)); }
  else if (pattern.type === 'ObjectPattern') { pattern.properties.forEach((p) => collectIds(p.type === 'RestElement' ? p.argument : p.value, out)); }
}
const isFn = (n) => n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');

// 함수 안 (안쪽 함수는 빼고) 노드를 하나씩
function walk(node, visit, parent) {
  if (!node || typeof node.type !== 'string') { return; }
  if (visit(node, parent) === false) { return; }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') { continue; }
    const v = node[key];
    if (Array.isArray(v)) { v.forEach((c) => { if (c && typeof c.type === 'string') { walk(c, visit, node); } }); }
    else if (v && typeof v.type === 'string') { walk(v, visit, node); }
  }
}

export function instrument(code) {
  const src = code.replace(/^(\s*)export\s+(default\s+)?/gm, (m, sp) => sp + ' '.repeat(m.length - sp.length));
  const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowReturnOutsideFunction: true });
  const ins = [];   // [위치, 넣을 글자, 순서]
  const add = (pos, text, order) => ins.push([pos, text, order || 0]);
  let fnCount = 0;
  // 이름 있는 함수 찾기
  walk(ast, (node, parent) => {
    if (!isFn(node)) { return; }
    let name = node.id && node.id.name;
    if (!name && parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') { name = parent.id.name; }
    if (!name && parent && (parent.type === 'Property' || parent.type === 'MethodDefinition') && parent.key && parent.key.type === 'Identifier') { name = parent.key.name; }
    if (!name) { return; }
    fnCount++;
    const fid = '__v' + fnCount;
    const names = new Set();
    node.params.forEach((p) => collectIds(p, names));
    const stmts = [];
    const tests = [];
    walk(node.body, (n, par) => {
      if (n !== node.body && isFn(n)) { return false; }
      if (n.type === 'VariableDeclarator') { collectIds(n.id, names); }
      const inHeader = par && /^For/.test(par.type) && (par.init === n || par.left === n);
      if (/Statement$|Declaration$/.test(n.type) && n.type !== 'BlockStatement' && n.type !== 'FunctionDeclaration' && !inHeader && !(par && par.type === 'LabeledStatement')) {
        // for (…; 조건; …) 은 조건을 볼 때마다 한 단계 — 한 바퀴 돌고 i++ 한 뒤 다시 이 줄로 오는 게 보이게
        if (n.type === 'ForStatement' && n.test) { tests.push(n); } else { stmts.push([n, par]); }
      }
      if (n.type === 'ReturnStatement') {
        if (n.argument) { add(n.argument.start, '__ret(' + JSON.stringify(name) + ', ' + n.loc.start.line + ', ', 1); add(n.argument.end, ')', -1); }
        else { add(n.start + 6, ' __ret(' + JSON.stringify(name) + ', ' + n.loc.start.line + ', void 0)', 1); }
      }
      return true;
    });
    const getters = '{' + [...names].map((k) => JSON.stringify(k) + ': __g(() => ' + k + ')').join(', ') + '}';
    const head = 'const ' + fid + ' = () => (' + getters + '); __enter(' + JSON.stringify(name) + ', ' + fid + '); try {';
    const tail = '} finally { __leave(); }';
    stmts.forEach(([st, par]) => {
      // 블록 없이 한 줄만 있는 if · for · while 몸통은 { } 로 감싼다
      const bare = par && par.type !== 'BlockStatement' && par.type !== 'Program' && par.type !== 'SwitchCase' && par.type !== 'LabeledStatement';
      if (bare) { add(st.start, '{', 3); add(st.end, '}', -3); }
      // 그 자리에서 값을 읽는 함수 — for (let i …) 안의 i 처럼 블록 안 이름도 보이게
      add(st.start, '__step(' + st.loc.start.line + ', () => (' + getters + '), ' + st.loc.start.column + ');', 2);
    });
    tests.forEach((st) => {
      add(st.test.start, '(__step(' + st.loc.start.line + ', () => (' + getters + '), ' + st.loc.start.column + '), (', 2);
      add(st.test.end, '))', -2);
    });
    if (node.body.type === 'BlockStatement') {
      add(node.body.start + 1, head, 5);
      add(node.body.end - 1, tail, -5);
    } else {
      // (a, b) => a - b 처럼 몸통이 식이면 { } 로 바꾼다
      const arrow = src.lastIndexOf('=>', node.body.start);
      const from = arrow + 2;
      add(from, ' { ' + head + ' __step(' + node.body.loc.start.line + ', ' + fid + '); return __ret(' + JSON.stringify(name) + ', ' + node.body.loc.start.line + ', ', 5);
      add(node.end, '); ' + tail + ' }', -5);
    }
  });
  // 뒤에서부터 넣어야 앞쪽 위치가 안 밀린다. 같은 자리는 order 큰 것이 바깥(먼저 나오게)
  ins.sort((a, b) => b[0] - a[0] || a[2] - b[2]);
  let out = src;
  ins.forEach(([pos, text]) => { out = out.slice(0, pos) + text + out.slice(pos); });
  return { code: out, functions: fnCount };
}

// Worker 안에서 돌 기록 장치
export const RUNTIME = String.raw`
const __steps = []; const __stack = []; let __last = 0; let __out = '';
class __Stop extends Error {}
const __g = (f) => { try { return f(); } catch (e) { return undefined; } };
function __show(v, d) {
  d = d || 0;
  try {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (typeof v === 'string') return d ? "'" + v.slice(0, 40) + "'" : "'" + v.slice(0, 60) + "'";
    if (typeof v === 'function') return '[함수]';
    if (typeof v !== 'object') return String(v);
    if (d > 2) return Array.isArray(v) ? '[…]' : '{…}';
    if (Array.isArray(v)) { const a = v.slice(0, 12).map((x) => __show(x, d + 1)); return '[' + a.join(', ') + (v.length > 12 ? ', …' : '') + ']'; }
    if (v instanceof Map) return 'Map(' + v.size + ')';
    if (v instanceof Set) return 'Set(' + __show([...v], d + 1) + ')';
    const ks = Object.keys(v).slice(0, 8);
    return '{' + ks.map((k) => k + ': ' + __show(v[k], d + 1)).join(', ') + (Object.keys(v).length > 8 ? ', …' : '') + '}';
  } catch (e) { return '?'; }
}
function __vars(f) { const o = {}; if (!f.get) return o; const raw = f.get(); for (const k in raw) { if (raw[k] !== undefined && typeof raw[k] !== 'function') o[k] = __show(raw[k]).slice(0, 120); } return o; }
function __snap(line, ret, col) {
  if (__steps.length >= ${MAX_STEPS}) throw new __Stop();
  const frames = [{ name: '부른 곳', vars: {} }].concat(__stack.map((f) => ({ name: f.name, vars: __vars(f) })));
  const objects = [];
  const top = __stack[__stack.length - 1];
  if (top && top.get) { const raw = top.get(); for (const k in raw) { if (Array.isArray(raw[k]) && objects.length < 4) objects.push({ label: k, items: raw[k].slice(0, 40).map((x) => __show(x, 1)), look: -1, marks: [] }); } }
  __steps.push(col === undefined ? { line, say: '', frames, objects, ret: ret || '' } : { line, say: '', frames, objects, ret: ret || '', col });
}
function __enter(name, get) { __stack.push({ name, get }); }
function __leave() { __stack.pop(); }
function __step(line, get, col) { __last = line; const top = __stack[__stack.length - 1]; if (top) top.get = get; __snap(line, '', col); }
function __ret(name, line, v) { __snap(line, name + '() = ' + __show(v)); return v; }
const console = { log: (...a) => { __out += a.map((x) => typeof x === 'string' ? x : __show(x)).join(' ') + '\n'; }, error: (...a) => console.log(...a), warn: (...a) => console.log(...a), info: (...a) => console.log(...a) };
`;
