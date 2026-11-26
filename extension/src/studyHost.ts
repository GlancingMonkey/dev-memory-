import * as vscode from 'vscode';
import { clamp, LLM_KEY_HEADER, LLM_PROVIDER_HEADER, LlmProvider, errorDetailText } from './logic';
import {
  AiConcept, buildConceptGraph, detectConcepts, GraphCard, NoteCard, parseAiConcepts, parseStudyResult, STUDY_CONCEPTS, StudyMode,
  studyNotesMarkdown, TraceStep,
} from './study';

// ─────────────────────────────────────────────
// 공부 모드 — 확장 본체 쪽 (AI 개념 요청 · 캐시 · 내 전체 코드에서 개념 세기 · 공부 노트)
// ─────────────────────────────────────────────

export const STUDY_KEY = 'codeMemory.study';
const AI_CACHE_KEY = 'codeMemory.studyAiCache';
const AI_CACHE_MAX = 100;
export const COUNTS_KEY = 'codeMemory.conceptCounts';

export interface StudySnapshot {
  cards: Record<string, StudyCardData>;
  known: Record<string, 'new' | 'known'>;
  mastered: Record<string, string>;
}
export interface StudyCardData extends GraphCard, NoteCard {
  key: string;
  name: string;
  id?: number;
  function_name?: string | null;
  project_name?: string | null;
  start_line?: number;
  end_line?: number;
  due?: string;
  lastAt?: string;
  history?: { at: string; grade: string }[];
  ai?: (AiConcept & { level: 1 | 2 | 3 })[];
}
export function readStudy(raw: unknown): StudySnapshot {
  const o = raw && typeof raw === 'object' ? raw as Partial<StudySnapshot> : {};
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return {
    cards: obj(o.cards) as StudySnapshot['cards'],
    known: obj(o.known) as StudySnapshot['known'],
    mastered: obj(o.mastered) as StudySnapshot['mastered'],
  };
}

// 코드 내용으로 캐시 키 — 같은 코드면 AI 를 다시 부르지 않는다
function hashOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36) + ':' + text.length;
}

export class StudyAiError extends Error {
  constructor(public readonly kind: 'missing' | 'key' | 'timeout' | 'connect' | 'server' | 'format', message: string) {
    super(message);
  }
}

export interface AiConceptRequest {
  code: string;
  language: string;
  function_name: string | null;
}

// mock — 패턴으로 찾은 개념에 "이 코드에서는"을 붙이고, 돌려주기만 하는 함수면 "순수 함수"를 하나 더
export function mockAiConcepts(req: AiConceptRequest): AiConcept[] {
  const hits = detectConcepts(req.code, req.language, req.function_name, STUDY_CONCEPTS);
  const name = req.function_name || '이 코드';
  const out: AiConcept[] = hits.slice(0, 4).map((h) => {
    const c = STUDY_CONCEPTS.find((x) => x.id === h.id);
    return {
      id: h.id, name: c ? c.name : h.id, level: c ? c.level : 2, summary: c ? c.summary : '',
      in_this_code: `(mock) ${name} 의 ${h.lines.map((l) => l + 1).join(', ')}번째 줄에서 ${c ? c.name : h.id} 을(를) 써요.`,
      lines: h.lines.map((l) => l + 1), prereq: [], misconception: '', contrast: '',
    };
  });
  if (/\breturn\b/.test(req.code) && !/\b(global|print|console\.log|append|push)\b/.test(req.code)) {
    out.push({
      id: null, name: '순수 함수', level: 2,
      summary: '같은 입력엔 늘 같은 결과를 내고 바깥 값을 바꾸지 않는 함수. 테스트·재사용이 쉬워요.',
      in_this_code: `(mock) ${name} 은(는) 받은 값을 바꾸지 않고 결과만 돌려줘요.`,
      lines: [], prereq: [], misconception: '반환값이 같아도 안에서 파일·전역 변수를 바꾸면 순수 함수가 아니에요.',
      contrast: '순수 함수는 결과만, 부작용 있는 함수는 바깥 상태도 바꿔요.',
    });
  }
  return out;
}

// POST /study/concepts — /ask 와 같은 개인 키 헤더. 404·405 는 "서버에 아직 없음"
export async function fetchAiConcepts(req: AiConceptRequest, key: { provider: LlmProvider; value: string } | undefined): Promise<AiConcept[]> {
  const config = vscode.workspace.getConfiguration('codeMemory');
  const knownIds = STUDY_CONCEPTS.map((c) => c.id);
  if (config.get<boolean>('mock', true)) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return mockAiConcepts(req);
  }
  const baseUrl = config.get<string>('apiUrl', 'http://localhost:8000').replace(/\/+$/, '');
  const timeoutSec = clamp(config.get<number>('askTimeoutSeconds'), 1, 300, 45);
  const known = detectConcepts(req.code, req.language, req.function_name, STUDY_CONCEPTS).map((h) => h.id);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/study/concepts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { [LLM_KEY_HEADER]: key.value, [LLM_PROVIDER_HEADER]: key.provider } : {}),
      },
      body: JSON.stringify({ code: req.code.slice(0, 8000), language: req.language, function_name: req.function_name, known_ids: known, concept_ids: knownIds }),
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new StudyAiError('timeout', `AI 응답 시간 초과 (${timeoutSec}초)`);
    }
    throw new StudyAiError('connect', `서버에 연결할 수 없습니다 (${baseUrl})`);
  }
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = undefined; }
  if (res.status === 404 || res.status === 405) {
    throw new StudyAiError('missing', '서버에 아직 AI 개념 기능이 없어요 (POST /study/concepts)');
  }
  if (res.status === 401 || res.status === 403) {
    throw new StudyAiError('key', `AI 키를 확인하세요 (HTTP ${res.status}) ${errorDetailText(data)}`.trim());
  }
  if (!res.ok) {
    throw new StudyAiError('server', `AI 개념을 받지 못했어요 (HTTP ${res.status}) ${errorDetailText(data)}`.trim());
  }
  try {
    return parseAiConcepts(data, knownIds);
  } catch (err) {
    throw new StudyAiError('format', err instanceof Error ? err.message : String(err));
  }
}

export class AiConceptCache {
  constructor(private readonly global: vscode.Memento) {}
  private keyOf(req: AiConceptRequest, mock: boolean): string {
    return (mock ? 'mock|' : '') + hashOf(`${req.language}\n${req.function_name ?? ''}\n${req.code}`);
  }
  get(req: AiConceptRequest, mock: boolean): AiConcept[] | undefined {
    const k = this.keyOf(req, mock);
    return this.global.get<{ k: string; concepts: AiConcept[] }[]>(AI_CACHE_KEY, []).find((c) => c.k === k)?.concepts;
  }
  async put(req: AiConceptRequest, mock: boolean, concepts: AiConcept[]): Promise<void> {
    const k = this.keyOf(req, mock);
    const items = [{ k, concepts, time: new Date().toISOString() },
      ...this.global.get<{ k: string; concepts: AiConcept[] }[]>(AI_CACHE_KEY, []).filter((c) => c.k !== k)].slice(0, AI_CACHE_MAX);
    await this.global.update(AI_CACHE_KEY, items);
  }
}

// 내 전체 코드에서 개념 세기 — 개념 이름·예시로 검색하고, 받은 코드에 그 개념이 정말 쓰였는지 패턴으로 다시 확인
export async function countConceptsInDb(
  search: (q: string) => Promise<{ id: number; code: string; language: string; function_name: string | null }[]>,
  onProgress: (done: number, total: number) => void,
  token: { cancelled: boolean },
): Promise<Record<string, number>> {
  const targets = STUDY_CONCEPTS.filter((c) => c.pattern);
  const counts: Record<string, number> = {};
  let done = 0;
  for (const c of targets) {
    if (token.cancelled) { break; }
    const q = `${c.name} ${c.example.split('\n')[0]}`.slice(0, 200);
    try {
      const rows = await search(q);
      const ids = new Set<number>();
      rows.forEach((r) => {
        if (detectConcepts(r.code, r.language, r.function_name, [c]).length) { ids.add(r.id); }
      });
      counts[c.id] = ids.size;
    } catch {
      // 한 개념이 실패해도 나머지는 계속
    }
    done += 1;
    onProgress(done, targets.length);
  }
  return counts;
}

// 공부 노트 — 마크다운 새 문서로 연다 (저장은 사용자가)
export async function openStudyNotes(snapshot: StudySnapshot): Promise<void> {
  const cards = Object.keys(snapshot.cards).map((k) => snapshot.cards[k]);
  if (!cards.length) {
    vscode.window.showInformationMessage('아직 공부한 코드가 없어요.');
    return;
  }
  const nodes = buildConceptGraph(cards, snapshot.known, STUDY_CONCEPTS);
  const md = studyNotesMarkdown(cards, nodes, STUDY_CONCEPTS, new Date());
  const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: false });
}


// ─────────────────────────────────────────────
// 공부 모드 — 문제 · 다른 언어로 · 내 말로 설명 · 왜 이렇게 · 리뷰 · 바꿔 보기 · 버그 찾기 (AI)
//            실행 따라가기 · 깨뜨려 보기 · 바꿔 보기 채점 (서버의 격리 실행)
//   모두 POST /study/{mode} (Backend 협의안). AI 쪽은 /ask 와 같은 개인 키 헤더
// ─────────────────────────────────────────────
export interface StudyRequest {
  code: string;
  language: string;
  function_name: string | null;
  [extra: string]: unknown;      // target(다른 언어), answer(내 말로), call(실행), calls·tests(채점)
}
const AI_MODES: StudyMode[] = ['quiz', 'translate', 'explain', 'why', 'review', 'task', 'bug'];

export async function fetchStudy(mode: StudyMode, req: StudyRequest, key: { provider: LlmProvider; value: string } | undefined): Promise<unknown> {
  const config = vscode.workspace.getConfiguration('codeMemory');
  if (config.get<boolean>('mock', true)) {
    await new Promise((resolve) => setTimeout(resolve, mode === 'run' || mode === 'trace' ? 400 : 700));
    return parseStudyResult(mode, mockStudy(mode, req));
  }
  const baseUrl = config.get<string>('apiUrl', 'http://localhost:8000').replace(/\/+$/, '');
  const timeoutSec = clamp(config.get<number>('askTimeoutSeconds'), 1, 300, 45);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/study/${mode}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key && AI_MODES.includes(mode) ? { [LLM_KEY_HEADER]: key.value, [LLM_PROVIDER_HEADER]: key.provider } : {}),
      },
      body: JSON.stringify({ ...req, code: req.code.slice(0, 8000) }),
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new StudyAiError('timeout', `응답 시간 초과 (${timeoutSec}초)`);
    }
    throw new StudyAiError('connect', `서버에 연결할 수 없습니다 (${baseUrl})`);
  }
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = undefined; }
  if (res.status === 404 || res.status === 405) {
    throw new StudyAiError('missing', mode === 'run' || mode === 'trace'
      ? '서버에 아직 코드 실행 기능이 없어요 (POST /study/' + mode + ')'
      : '서버에 아직 이 기능이 없어요 (POST /study/' + mode + ')');
  }
  if (res.status === 401 || res.status === 403) {
    throw new StudyAiError('key', `AI 키를 확인하세요 (HTTP ${res.status}) ${errorDetailText(data)}`.trim());
  }
  if (!res.ok) {
    throw new StudyAiError('server', `받지 못했어요 (HTTP ${res.status}) ${errorDetailText(data)}`.trim());
  }
  try {
    return parseStudyResult(mode, data);
  } catch (err) {
    throw new StudyAiError('format', '응답 형식 오류: ' + (err instanceof Error ? err.message : String(err)));
  }
}

// ── mock — 샘플 코드(even_numbers · add · fact · safe_divide · odd_squares)는 그럴듯하게, 나머지는 일반적인 예시
type MockFn = (...args: unknown[]) => unknown;
const MOCK_FNS: Record<string, MockFn> = {
  even_numbers: (v) => (v as number[]).filter((n) => n % 2 === 0),
  odd_squares: (v) => (v as number[]).filter((n) => ((n % 2) + 2) % 2 === 1).map((n) => n * n),
  add: (a, b) => (a as number) + (b as number),
  safe_divide: (a, b) => ((b as number) === 0 ? null : (a as number) / (b as number)),
  fact: (n) => { let r = 1; for (let i = 2; i <= (n as number); i++) { r *= i; } return r; },
};
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) { return 'None'; }
  if (v === true) { return 'True'; }
  if (v === false) { return 'False'; }
  if (Array.isArray(v)) { return '[' + v.map(pyRepr).join(', ') + ']'; }
  if (typeof v === 'number' && !Number.isInteger(v)) { return String(v); }
  return String(v);
}
function parseCall(call: string): { name: string; args: unknown[] } | null {
  const m = /^\s*([A-Za-z_]\w*)\s*\((.*)\)\s*$/s.exec(call);
  if (!m) { return null; }
  const json = '[' + m[2].replace(/\bNone\b/g, 'null').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/'/g, '"') + ']';
  try { return { name: m[1], args: JSON.parse(json) as unknown[] }; } catch { return { name: m[1], args: [] }; }
}
function mockRun(call: string, fnName: string | null): { output: string; error: string } {
  const p = parseCall(call);
  if (!p) { return { output: '', error: 'SyntaxError: 함수 호출 모양으로 적어 주세요. 예: ' + (fnName || 'f') + '(…)' }; }
  const fn = MOCK_FNS[p.name];
  if (!fn) { return { output: '', error: `(mock) ${p.name} 은 mock 에서 실행할 수 없어요` }; }
  try {
    if (p.name === 'even_numbers' || p.name === 'odd_squares') {
      if (!Array.isArray(p.args[0])) { return { output: '', error: `TypeError: '${p.args[0] === null ? 'NoneType' : typeof p.args[0]}' object is not iterable` }; }
    }
    if ((p.name === 'add' || p.name === 'safe_divide') && p.args.some((a) => typeof a !== 'number')) {
      return { output: '', error: 'TypeError: unsupported operand type(s)' };
    }
    return { output: pyRepr(fn(...p.args)), error: '' };
  } catch (e) {
    return { output: '', error: String(e) };
  }
}
function mockTrace(req: StudyRequest): unknown {
  const name = req.function_name || '';
  const call = String(req.call || (name === 'fact' ? 'fact(3)' : name === 'even_numbers' ? 'even_numbers([3, -4, 0, 7])' : ''));
  const p = parseCall(call);
  const lines = req.code.split('\n');
  const lineOf = (re: RegExp, fallback: number) => { const i = lines.findIndex((l) => re.test(l)); return i >= 0 ? i + 1 : fallback; };
  const steps: TraceStep[] = [];
  if (p && p.name === 'even_numbers' && Array.isArray(p.args[0])) {
    const list = (p.args[0] as number[]).slice(0, 20);
    const ret = lineOf(/return/, 2);
    const items = list.map(String);
    const caller = { name: '부른 곳', vars: { nums: '→ values' } };
    steps.push({ line: 1, say: `${call} 을(를) 불러요. 스택에 칸이 하나 쌓여요. nums 와 values 는 같은 리스트예요.`, frames: [caller, { name: 'even_numbers', vars: { values: pyRepr(list) } }], objects: [{ label: 'values', items, look: -1, marks: [] }], ret: '' });
    const res: number[] = [];
    const marks: string[] = [];
    list.forEach((n, i) => {
      const ok = n % 2 === 0;
      if (ok) { res.push(n); }
      marks.push(ok ? 'pass' : 'fail');
      steps.push({ line: ret, say: `n = ${n}. ${n} % 2 == 0 → ${ok ? 'True, 결과에 넣어요.' : 'False, 건너뛰어요.'}${n === 0 ? ' (0 도 짝수!)' : n < 0 && ok ? ' (음수도 % 2 는 0)' : ''}`,
        frames: [caller, { name: 'even_numbers', vars: { values: pyRepr(list) } }, { name: '<listcomp>', vars: { n: String(n) } }],
        objects: [{ label: 'values', items, look: i, marks: marks.slice() }, { label: '결과 (새 리스트)', items: res.map(String), look: ok ? res.length - 1 : -1, marks: res.map(() => 'new') }], ret: '' });
    });
    steps.push({ line: ret, say: `다 돌았어요. 새 리스트 ${pyRepr(res)} 를 돌려주고 칸이 빠져요. values(= nums) 는 그대로예요.`, frames: [{ name: '부른 곳', vars: { nums: '→ values', 결과: pyRepr(res) } }],
      objects: [{ label: 'values', items, look: -1, marks: [] }, { label: '결과 (새 리스트)', items: res.map(String), look: -1, marks: [] }], ret: pyRepr(res) });
  } else if (p && p.name === 'fact' && typeof p.args[0] === 'number') {
    const n0 = Math.max(0, Math.min(8, p.args[0] as number));
    const base = lineOf(/if\s/, 2), rec = lineOf(/fact\s*\(\s*n\s*-/, 4), one = lineOf(/return\s+1\b/, 3);
    const stack: number[] = [];
    const fr = () => stack.map((n) => ({ name: 'fact', vars: { n: String(n) } }));
    const walk = (n: number): number => {
      stack.push(n);
      steps.push({ line: 1, say: `fact(${n}) 을(를) 불러요. 칸이 쌓여요 (깊이 ${stack.length}).`, frames: fr(), objects: [], ret: '' });
      steps.push({ line: base, say: `n = ${n}. ${n} <= 1 ${n <= 1 ? '→ 바닥 조건! 여기서 멈춰요.' : '아니니까 아래로.'}`, frames: fr(), objects: [], ret: '' });
      let r: number;
      if (n <= 1) {
        r = 1;
        steps.push({ line: one, say: `fact(${n}) 은 1 을 돌려줘요.`, frames: fr(), objects: [], ret: '' });
      } else {
        steps.push({ line: rec, say: `${n} * fact(${n - 1}) — 답을 알려면 fact(${n - 1}) 을 먼저 불러야 해요.`, frames: fr(), objects: [], ret: '' });
        const sub = walk(n - 1);
        r = n * sub;
        steps.push({ line: rec, say: `돌아왔어요. ${n} * ${sub} = ${r}.`, frames: fr(), objects: [], ret: '' });
      }
      stack.pop();
      steps.push({ line: n <= 1 ? one : rec, say: `fact(${n}) = ${r}. 칸이 빠져요.`, frames: fr(), objects: [], ret: `fact(${n}) = ${r}` });
      return r;
    };
    walk(n0);
  } else {
    return { call, steps: [] };
  }
  return { call, steps };
}
export function mockStudy(mode: StudyMode, req: StudyRequest): unknown {
  const name = req.function_name || 'f';
  const lang = (req.language || '').toLowerCase();
  const py = lang === 'python';
  const nLines = req.code.split('\n').length;
  const isEven = name === 'even_numbers';
  switch (mode) {
    case 'quiz':
      return { questions: isEven ? [
        { kind: 'output', prompt: '이 결과는?', code: 'even_numbers([3, -4, 0, 7])', choices: ['[-4]', '[-4, 0]', '[3, 7]', '[]'], answer: 1, explain: '0 도 짝수예요. 0 % 2 는 0 이라 조건을 통과해요.' },
        { kind: 'blank', prompt: '빈칸에 들어갈 것은? return [n for n in values if ___]', code: '', choices: ['n % 2 == 0', 'n / 2 == 0', 'n % 2', 'n == 2'], answer: 0, explain: '나머지가 0 이면 짝수예요. n % 2 만 쓰면 홀수가 남아요.' },
        { kind: 'concept', prompt: 'even_numbers 를 부른 뒤 넘긴 리스트는?', code: '', choices: ['짝수만 남게 바뀐다', '그대로다', '비워진다', '정렬된다'], answer: 1, explain: '컴프리헨션은 새 리스트를 만들어요. 원본은 그대로예요.' },
      ] : [
        { kind: 'concept', prompt: `(mock) ${name} 은(는) 무엇을 돌려주나요?`, code: '', choices: ['입력을 바꾼 새 값', '항상 None', '입력 그대로', '오류'], answer: 0, explain: '(mock) 실제 서버에서는 이 코드에 맞춘 문제가 나와요.' },
        { kind: 'output', prompt: '(mock) 빈 입력을 넣으면?', code: '', choices: ['빈 결과', '오류', 'None', '무한 반복'], answer: 0, explain: '(mock) 경계값을 확인하는 문제예요.' },
      ] };
    case 'translate': {
      const t = String(req.target || 'typescript');
      const code = isEven
        ? (t === 'java' ? 'static List<Integer> evenNumbers(List<Integer> values) {\n    return values.stream().filter(n -> n % 2 == 0).toList();\n}'
          : t === 'go' ? 'func evenNumbers(values []int) []int {\n    out := []int{}\n    for _, n := range values {\n        if n%2 == 0 {\n            out = append(out, n)\n        }\n    }\n    return out\n}'
            : t === 'c' ? 'int even_numbers(const int *values, int n, int *out) {\n    int k = 0;\n    for (int i = 0; i < n; i++) {\n        if (values[i] % 2 == 0) out[k++] = values[i];\n    }\n    return k;\n}'
              : 'function evenNumbers(values: number[]): number[] {\n  return values.filter((n) => n % 2 === 0);\n}')
        : `// (mock) ${t} 로 바꾼 ${name}\n// 실제 서버에서는 이 코드를 ${t} 로 옮긴 결과가 나와요`;
      const notes = isEven ? (t === 'java' ? [{ from: '[… for … if …]', to: 'stream().filter()', why: '자바는 스트림으로 거르기' }, { from: 'values', to: 'List<Integer>', why: '타입을 꼭 적어요' }]
        : t === 'go' ? [{ from: '컴프리헨션', to: 'for + append', why: 'Go 에는 컴프리헨션이 없어요' }, { from: '새 리스트', to: 'out := []int{}', why: '빈 슬라이스로 시작' }]
          : t === 'c' ? [{ from: '새 리스트', to: '결과 배열 out + 개수 k', why: 'C 는 배열 길이를 직접 관리해요' }]
            : [{ from: '[… for … if …]', to: '.filter()', why: '배열 메서드로 거르기' }, { from: '==', to: '===', why: '타입까지 비교' }, { from: 'values', to: 'number[]', why: '타입 표시' }])
        : [{ from: '(mock)', to: '(mock)', why: '실제 서버에서 달라지는 부분을 짚어줘요' }];
      return { language: t, code, notes };
    }
    case 'explain': {
      const a = String(req.answer || '');
      const pts = [];
      pts.push({ verdict: /짝수|2\s*로\s*나|filter|거르|골라/.test(a) || !isEven ? 'ok' : 'wrong', text: isEven ? '짝수만 고른다는 핵심' : '(mock) 함수가 하는 일의 핵심', lines: [nLines > 1 ? 2 : 1] });
      if (isEven) {
        pts.push({ verdict: /새\s*리스트|새로|원본|그대로/.test(a) ? 'ok' : 'partial', text: '원래 리스트를 바꾸지 않고 새 리스트를 만든다', lines: [2] });
        pts.push({ verdict: /순서/.test(a) ? 'ok' : 'partial', text: '순서가 그대로 유지된다', lines: [2] });
        pts.push({ verdict: /0|음수/.test(a) ? 'ok' : 'partial', text: '0 과 음수 짝수도 들어간다', lines: [2] });
      } else {
        pts.push({ verdict: 'partial', text: '(mock) 입력이 비었을 때 어떻게 되는지', lines: [] });
      }
      return { points: pts };
    }
    case 'why':
      return isEven ? {
        alternatives: [
          { label: '리스트 컴프리헨션 (지금)', code: '[n for n in values if n % 2 == 0]', speed: '빠름', memory: '리스트', readability: '좋음', note: '파이썬다운 방법' },
          { label: 'for + append', code: 'out = []\nfor n in values:\n    if n % 2 == 0:\n        out.append(n)', speed: '보통', memory: '리스트', readability: '길다', note: '처음 배울 때 읽기 쉬움' },
          { label: 'filter', code: 'list(filter(lambda n: n % 2 == 0, values))', speed: '빠름', memory: '리스트', readability: '보통', note: 'lambda 가 끼면 덜 읽혀요' },
          { label: '제너레이터', code: '(n for n in values if n % 2 == 0)', speed: '빠름', memory: '거의 0', readability: '좋음', note: '한 번만 훑을 때 메모리 절약' },
        ],
        complexity: { time: 'O(n)', space: 'O(k) — 결과 개수만큼', note: '모든 값을 한 번씩 봐요.' },
        deeper: [
          { title: '컴프리헨션은 자기만의 범위', text: '컴프리헨션 안의 n 은 밖의 n 과 다른 변수예요. 파이썬 3 부터 밖으로 새지 않아요.', doc: 'https://docs.python.org/ko/3/reference/expressions.html#displays-for-lists-sets-and-dictionaries' },
          { title: '인터프리터가 보는 모습', text: 'FOR_ITER(하나 꺼내기) → BINARY_OP %(나머지) → COMPARE_OP ==(비교) → POP_JUMP_IF_FALSE(아니면 건너뛰기) → LIST_APPEND(결과에 넣기) 를 반복해요. dis 모듈로 직접 볼 수 있어요.', doc: 'https://docs.python.org/ko/3/library/dis.html' },
          { title: '실제 비용', text: '입력 n 개면 반복 n 번, 나머지·비교 n 번, 새 리스트 1개. 결과가 크면 그만큼 메모리를 써요.', doc: '' },
        ],
      } : {
        alternatives: [{ label: '(mock) 지금 방법', code: req.code.split('\n').slice(0, 3).join('\n'), speed: '-', memory: '-', readability: '-', note: '실제 서버에서는 다른 방법들과 비교해줘요' }],
        complexity: { time: '(mock)', space: '(mock)', note: '' }, deeper: [],
      };
    case 'review':
      return isEven ? {
        items: [
          { kind: 'fix', title: '이름', text: 'values 보다 numbers 가 뜻이 분명해요.', lines: [1] },
          { kind: 'warn', title: '입력 확인', text: 'None 이나 실수가 들어오면 어떻게 할지 정해져 있지 않아요.', lines: [1] },
          { kind: 'fix', title: '타입 표시', text: 'def even_numbers(values: list[int]) -> list[int]:', lines: [1] },
          { kind: 'good', title: '잘한 점', text: '원본을 바꾸지 않고 새 리스트를 돌려줘요.', lines: [2] },
        ],
        improved_code: 'def even_numbers(numbers: list[int]) -> list[int]:\n    """짝수만 골라 새 리스트로 돌려준다."""\n    if numbers is None:\n        return []\n    return [n for n in numbers if n % 2 == 0]',
      } : { items: [{ kind: 'good', title: '(mock) 잘한 점', text: '실제 서버에서는 이 코드에 맞춘 리뷰가 나와요.', lines: [] }], improved_code: '' };
    case 'task':
      return isEven ? {
        task: '홀수만 제곱해서 돌려주세요.',
        starter: py ? 'def odd_squares(values):\n    return [n * 2 for n in values if n % 2 == 1]' : req.code,
        tests: [{ call: 'odd_squares([])', expected: '[]' }, { call: 'odd_squares([2, 4])', expected: '[]' }, { call: 'odd_squares([1, 2, 3])', expected: '[1, 9]' }, { call: 'odd_squares([-3])', expected: '[9]' }],
      } : { task: `(mock) ${name} 을(를) 빈 입력에도 동작하게 바꿔 보세요.`, starter: req.code, tests: [{ call: `${name}()`, expected: '(mock)' }] };
    case 'bug': {
      const ls = req.code.split('\n');
      let at = ls.findIndex((l) => /==\s*0|<=|>=|\+|-|%/.test(l) && !/^\s*def\b/.test(l));
      if (at < 0) { at = Math.min(ls.length - 1, 1); }
      const orig = ls[at];
      const broken = orig.replace('== 0', '== 1').replace('<=', '<').replace('>=', '>');
      ls[at] = broken === orig ? orig + '  # (mock) 여기를 바꿨다고 쳐요' : broken;
      return { code: ls.join('\n'), line: at + 1, explain: isEven ? '== 0 이 == 1 로 바뀌어서 홀수를 고르게 됐어요.' : '(mock) 비교 연산자가 바뀌었어요.', fixed_line: orig.trim() };
    }
    case 'trace':
      return mockTrace(req);
    case 'run': {
      const calls = Array.isArray(req.calls) ? req.calls as string[] : [];
      const tests = Array.isArray(req.tests) ? req.tests as { call: string; expected: string }[] : [];
      const code = req.code;
      const userFn = /def\s+(\w+)/.exec(code)?.[1] ?? name;
      // 바꿔 보기 채점: mock 은 고친 코드가 n * n (또는 n ** 2) 이고 % 2 == 1 (또는 != 0) 인지로 흉내
      const okSquare = /n\s*\*\s*n|n\s*\*\*\s*2/.test(code) && /%\s*2\s*(==\s*1|!=\s*0)/.test(code);
      const cases = tests.length
        ? tests.map((t) => {
          const r = mockRun(t.call.replace(/^\w+/, 'odd_squares'), userFn);
          const out = okSquare ? r.output : pyRepr((parseCall(t.call)?.args[0] as number[] | undefined ?? []).filter((n) => ((n % 2) + 2) % 2 === 1).map((n) => n * 2));
          return { call: t.call, output: out, error: r.error, expected: t.expected, ok: !r.error && out === t.expected };
        })
        : calls.map((c) => { const r = mockRun(c, userFn); return { call: c, output: r.output, error: r.error, expected: '', ok: null }; });
      return { cases };
    }
  }
  return {};
}

// AI 결과 캐시 — 같은 코드·같은 모드(다른 언어로는 대상 언어까지)면 다시 부르지 않는다. 내 말로 설명·실행·채점은 저장 안 함
const STUDY_CACHE_KEY = 'codeMemory.studyCache';
const STUDY_CACHE_MAX = 150;
const CACHED_MODES: StudyMode[] = ['quiz', 'translate', 'why', 'review', 'task', 'bug', 'trace'];
export class StudyCache {
  constructor(private readonly global: vscode.Memento) {}
  private keyOf(mode: StudyMode, req: StudyRequest, mock: boolean): string | null {
    if (!CACHED_MODES.includes(mode)) { return null; }
    return (mock ? 'mock|' : '') + mode + '|' + String(req.target ?? '') + '|' + String(req.call ?? '') + '|' + hashOf(`${req.language}\n${req.function_name ?? ''}\n${req.code}`);
  }
  get(mode: StudyMode, req: StudyRequest, mock: boolean): unknown {
    const k = this.keyOf(mode, req, mock);
    return k ? this.global.get<{ k: string; v: unknown }[]>(STUDY_CACHE_KEY, []).find((c) => c.k === k)?.v : undefined;
  }
  async put(mode: StudyMode, req: StudyRequest, mock: boolean, v: unknown): Promise<void> {
    const k = this.keyOf(mode, req, mock);
    if (!k) { return; }
    const items = [{ k, v }, ...this.global.get<{ k: string; v: unknown }[]>(STUDY_CACHE_KEY, []).filter((c) => c.k !== k)].slice(0, STUDY_CACHE_MAX);
    await this.global.update(STUDY_CACHE_KEY, items);
  }
}
