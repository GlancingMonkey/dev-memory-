import * as vscode from 'vscode';
import { ProjectLocations, relativeSourceParts } from './projectLocations';
import {
  addUsage, answerToMarkdown, askCacheKey, AskError, askErrorFor, AskResponse, AskSource, AskTurn, buildAskRequest, buildSearchUrl,
  canSendKey, checkAppliedFilter, clamp, compareSource, guessProvider, LLM_KEY_HEADER, LLM_PROVIDER_HEADER, LLM_PROVIDERS,
  LlmProvider, maskKey, validateKey, pickSymbol, SimpleSymbol, SourceState, EmbeddingStatus, endsWithQuestionMark, errorDetailText, FILTER_MAX_LENGTH, FilterCheck, filterLocally,
  FilterOptions, hasFilter, isVagueQuestion, localDateKey, looksLikeQuestion, normalizeFilter, parseAskResponse, parseFilterOptions,
  parseSse, reindent, SearchFilter, todayUsage, UsageDay,
} from './logic';

// ─────────────────────────────────────────────
// 검색 결과 한 건 — 저장 때 보낸 스니펫 + 서버가 붙여주는 id, score
// ─────────────────────────────────────────────
export interface SearchResult {
  id: number;
  project_name: string | null;
  file_path: string;
  absolute_path?: string;
  language: string;
  function_name: string | null;
  start_line: number;
  end_line: number;
  code: string;
  score: number;   // 코사인 유사도 = 1 - cosine_distance, -1~1; 클수록 유사함
}

// mock 결과 — docs/DEVELOPMENT.md의 로컬 테스트 코드 3개; 원본 열기에는 실제 파일이 필요
// absolute_path 를 일부러 안 넣었다: 실제 API 결과처럼 "열린 폴더 이름 + 상대 경로"로 찾는 길을 그대로 테스트
const MOCK_SAMPLES: SearchResult[] = [
  {
    id: 1,
    project_name: 'mvp-save-test',
    file_path: 'sample.py',
    language: 'python',
    function_name: 'add',
    start_line: 1,
    end_line: 2,
    code: 'def add(a, b):\n    return a + b',
    score: 0.91,
  },
  {
    id: 2,
    project_name: 'mvp-save-test',
    file_path: 'even_numbers.py',
    language: 'python',
    function_name: 'even_numbers',
    start_line: 1,
    end_line: 2,
    code: 'def even_numbers(values):\n    return [n for n in values if n % 2 == 0]',
    score: 0.84,
  },
  {
    id: 3,
    project_name: 'mvp-save-test',
    file_path: 'sort_users.py',
    language: 'python',
    function_name: 'sort_users',
    start_line: 1,
    end_line: 2,
    code: 'def sort_users(users):\n    return sorted(users, key=lambda user: user["age"])',
    score: 0.77,
  },
  // 아래 둘은 필터 시험용 예시 (mock 에서만 나온다)
  {
    id: 4,
    project_name: 'demo-project',
    file_path: 'src/sort.ts',
    language: 'typescript',
    function_name: 'sortByDate',
    start_line: 1,
    end_line: 3,
    code: 'export function sortByDate(items: { date: number }[]) {\n  return [...items].sort((a, b) => a.date - b.date);\n}',
    score: 0.72,
  },
  {
    id: 5,
    project_name: 'demo-project',
    file_path: 'utils/math.py',
    language: 'python',
    function_name: 'safe_divide',
    start_line: 1,
    end_line: 4,
    code: 'def safe_divide(a, b):\n    if b == 0:\n        return None\n    return a / b',
    score: 0.66,
  },
];

// mock 샘플은 원본 열기·원본 비교를 시험할 수 있게, 열린 폴더가 있으면 기본 샘플(mvp-save-test)을 그 폴더 이름으로 바꿔서 쓴다
//   (예: 열린 폴더에 sample.py 가 있으면 add 샘플의 원본으로 잡힌다). 실제 서버 모드와는 상관없다
function mockResults(): SearchResult[] {
  const folder = vscode.workspace.workspaceFolders?.[0]?.name;
  return MOCK_SAMPLES.map((r) => (folder && r.project_name === 'mvp-save-test' ? { ...r, project_name: folder } : r));
}

// ─────────────────────────────────────────────
// 검색 — GET /search (mock 이면 샘플 반환)
// ─────────────────────────────────────────────
// 검색 오류 — 사이드바에 "제목 + 설명"으로 나눠 보여주기 위해
//   kind: timeout(기다리면 될 수 있음) / connect(서버·주소 문제) / server(서버 오류) / format(응답 모양 문제)
type SearchErrorKind = 'timeout' | 'connect' | 'server' | 'format';
export class SearchError extends Error {
  constructor(
    public readonly title: string,
    public readonly detail: string,
    public readonly kind: SearchErrorKind = 'server',
  ) {
    super(`${title}: ${detail}`);
  }
}

// 검색 결과 + 서버가 필터를 진짜 적용했는지 (applied / none / ignored)
export interface SearchOutcome {
  results: SearchResult[];
  check: FilterCheck;
}

export async function searchSnippets(query: string, filter: SearchFilter): Promise<SearchOutcome> {
  const config = vscode.workspace.getConfiguration('codeMemory');

  if (config.get<boolean>('mock', true)) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    // mock 은 검색어와 상관없이 샘플. 필터는 서버처럼 먼저 걸러서 돌려준다
    return { results: filterLocally(mockResults(), filter), check: hasFilter(filter) ? 'applied' : 'none' };
  }

  // API_CONTRACT.md: GET /search?q=...&limit=N[&project=..&language=..] → { results: [...], filters?: {...} }
  const baseUrl = config.get<string>('apiUrl', 'http://localhost:8000').replace(/\/+$/, '');
  const limit = Math.min(20, Math.max(1, Math.round(config.get<number>('searchLimit', 10))));
  const url = buildSearchUrl(baseUrl, query, limit, filter);
  const timeoutSec = clamp(config.get<number>('searchTimeoutSeconds'), 1, 300, 10);

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutSec * 1000) });
  } catch (err) {
    // 시간 초과: 첫 검색은 모델 준비로 오래 걸릴 수 있다 → "고장"이 아니라 대기 안내
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new SearchError(`응답 시간 초과 (${timeoutSec}초)`, '첫 검색은 모델 준비로 오래 걸릴 수 있어요. 잠시 후 다시 검색하세요.', 'timeout');
    }
    // 서버 꺼짐 / 주소 틀림
    const reason = err instanceof Error ? err.message : String(err);
    throw new SearchError('서버에 연결할 수 없습니다', `${baseUrl} · 서버가 켜져 있는지, 주소 설정을 확인하세요. (${reason})`, 'connect');
  }

  const text = await res.text();
  // 응답이 예상한 모양이 아니면 빈 결과로 넘기지 말고 오류로 보여준다
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const detail = errorDetailText(data) || text.slice(0, 300);
    if (res.status === 422) {
      throw new SearchError('검색 조건을 확인하세요 (HTTP 422)', detail, 'server');
    }
    throw new SearchError(`서버 오류 (HTTP ${res.status})`, detail, 'server');
  }
  if (data === undefined) {
    throw new SearchError('응답 형식 오류', `JSON 이 아닙니다: ${text.slice(0, 200)}`, 'format');
  }
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    throw new SearchError('응답 형식 오류', `results 배열이 없습니다: ${text.slice(0, 200)}`, 'format');
  }
  const check = checkAppliedFilter(filter, (data as { filters?: unknown }).filters);
  // 옛 서버가 조건을 무시했으면 화면에서라도 거른다 (웹페이지가 "화면에서만 거름"으로 표시)
  const rows = results as SearchResult[];
  return { results: check === 'ignored' ? filterLocally(rows, filter) : rows, check };
}

// 저장 직전 중복 확인 — 그 코드로 검색 한 번 (LLM 0회). 가장 비슷한 게 기준 이상이면 돌려준다
//   mock 이면 샘플 중 코드가 똑같은 게 있는지만 본다. 검색이 실패하면 null (저장은 그대로 진행)
export async function findDuplicate(code: string, threshold: number): Promise<{ result: SearchResult; score: number } | null> {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const config = vscode.workspace.getConfiguration('codeMemory');
  if (config.get<boolean>('mock', true)) {
    const hit = mockResults().find((r) => norm(r.code) === norm(code));
    return hit ? { result: hit, score: 1 } : null;
  }
  const q = norm(code).slice(0, 1000);
  if (!q) {
    return null;
  }
  const { results } = await searchSnippets(q, normalizeFilter({}));
  const top = results[0];
  return top && top.score >= threshold ? { result: top, score: top.score } : null;
}

// 필터 목록 — GET /filters (DB 에 있는 프로젝트·언어). mock 이면 샘플에서 센다
async function loadFilterOptions(): Promise<FilterOptions> {
  const config = vscode.workspace.getConfiguration('codeMemory');
  if (config.get<boolean>('mock', true)) {
    const count = (key: 'project_name' | 'language') => {
      const m = new Map<string, number>();
      mockResults().forEach((r) => { const k = r[key] ?? ''; if (k) { m.set(k, (m.get(k) ?? 0) + 1); } });
      return [...m].map(([name, n]) => ({ name, count: n }));
    };
    return { projects: count('project_name'), languages: count('language') };
  }
  const baseUrl = config.get<string>('apiUrl', 'http://localhost:8000').replace(/\/+$/, '');
  const timeoutSec = clamp(config.get<number>('searchTimeoutSeconds'), 1, 300, 10);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/filters`, { signal: AbortSignal.timeout(timeoutSec * 1000) });
  } catch {
    throw new Error('서버에 연결할 수 없어요');
  }
  if (res.status === 404) {
    throw new Error('필터 목록 API(GET /filters)가 아직 없어요');
  }
  if (!res.ok) {
    throw new Error(`필터 목록을 못 받았어요 (HTTP ${res.status})`);
  }
  return parseFilterOptions(await res.text());
}

// ─────────────────────────────────────────────
// AI 질문 — POST /ask (이슈 #42 제안안 + 팀 합의한 stream·history. 응답 읽기는 logic.ts 의 parseAskResponse 한 곳)
//   사용자가 버튼을 눌렀을 때만 보낸다. 자동 재전송 없음. 제한 시간은 codeMemory.askTimeoutSeconds
//   stream: true 로 보내고, 서버가 text/event-stream 으로 주면 한 글자씩, 일반 JSON 으로 주면 한 번에 (예전 서버 그대로 동작)
//   mock 이면 서버 없이 샘플 답변. 질문에 #근거부족 / #오류 를 넣으면 그 화면을 시험할 수 있다.
// ─────────────────────────────────────────────
export interface AskOptions {
  history: AskTurn[];
  signal: AbortSignal;                                 // 사용자가 "취소"를 누르면 abort
  onSources: (sources: AskSource[]) => void;           // 참고 코드를 먼저 받았을 때
  onDelta: (text: string) => void;                     // 답변 조각
  key?: { provider: LlmProvider; value: string };      // 사용자 AI 키 — 있으면 헤더로 (없으면 서버 기본 키)
}

const cancelledError = () => new AskError('cancelled', '취소했어요', '기다리기를 그만뒀어요. 서버에서는 답변이 계속 만들어졌을 수 있어요.');

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelledError());
      return;
    }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(cancelledError()); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function askMock(q: string, opts: AskOptions): Promise<AskResponse> {
  await sleep(500, opts.signal);   // 참고 코드 찾는 시간 흉내
  if (q.includes('#오류')) {
    throw new AskError('unavailable', 'AI 답변을 준비할 수 없습니다', '[mock] 모델·DB·LLM 연결 실패를 흉내 냈습니다.');
  }
  if (q.includes('#근거부족')) {
    return parseAskResponse(JSON.stringify({ status: 'insufficient_context', answer: '', sources: [], model: null, usage: null }));
  }
  const [add, even, sortUsers] = mockResults();
  const follow = opts.history.length > 0;
  const sources = follow
    ? [{ citation_id: 'S1', ...add }]
    : [{ citation_id: 'S1', ...add }, { citation_id: 'S2', ...even }, { citation_id: 'S3', ...sortUsers }];
  const answer = follow
    ? '앞 질문에 이어서 답하면, `add`는 타입 검사를 하지 않아서 음수도 그대로 더합니다 [S1]. `add(-2, 5)`는 3을 반환합니다 [S1].'
    : '두 숫자를 더하는 함수는 `add`입니다 [S1]. 인자 `a`와 `b`를 받아 `a + b`를 그대로 반환합니다 [S1].\n'
      + '숫자 목록을 다루는 비슷한 코드로는 짝수만 골라내는 `even_numbers`가 있습니다 [S2].';
  opts.onSources(sources);
  for (let i = 0; i < answer.length; i += 3) {   // 한 글자씩 받기 흉내
    await sleep(28, opts.signal);
    opts.onDelta(answer.slice(i, i + 3));
  }
  return parseAskResponse(JSON.stringify({
    status: 'answered', answer, sources, model: 'mock', usage: null, history_used: opts.history.length,
  }));
}

export async function askBackend(q: string, opts: AskOptions): Promise<AskResponse> {
  const config = vscode.workspace.getConfiguration('codeMemory');
  const limit = clamp(config.get<number>('searchLimit'), 1, 20, 10);

  if (config.get<boolean>('mock', true)) {
    return askMock(q, opts);
  }

  const baseUrl = config.get<string>('apiUrl', 'http://localhost:8000').replace(/\/+$/, '');
  const timeoutSec = clamp(config.get<number>('askTimeoutSeconds'), 1, 300, 45);
  // 제한 시간과 사용자 취소를 한 신호로 — 어느 쪽으로 끊겼는지는 timedOut 으로 구분
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutSec * 1000);
  const onCancel = () => ctrl.abort();
  opts.signal.addEventListener('abort', onCancel, { once: true });

  try {
    const res = await fetch(`${baseUrl}/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
        ...(opts.key ? { [LLM_KEY_HEADER]: opts.key.value, [LLM_PROVIDER_HEADER]: opts.key.provider } : {}),
      },
      body: JSON.stringify(buildAskRequest(q, limit, opts.history, true)),
      signal: ctrl.signal,
    });
    if (res.status === 404) {
      throw new AskError('server', 'AI 질문 API가 아직 없습니다 (HTTP 404)', '서버에 POST /ask 가 등록됐는지 Backend 담당과 확인하세요.');
    }
    const type = res.headers.get('content-type') ?? '';
    if (res.ok && type.includes('text/event-stream') && res.body) {
      return await readAskStream(res.body, opts);
    }
    return parseAskResponse(await res.text(), res.status);   // 한 번에 받는 서버 (stream 미지원)
  } catch (err) {
    if (err instanceof AskError) {
      throw err;
    }
    if (timedOut) {
      throw new AskError('timeout', `응답 시간 초과 (${timeoutSec}초)`,
        '서버에서는 답변이 만들어졌을 수 있습니다. 자동으로 다시 보내지 않습니다. 다시 물으려면 직접 누르세요.');
    }
    if (opts.signal.aborted) {
      throw cancelledError();
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new AskError('connect', '서버에 연결할 수 없습니다', `${baseUrl} · 서버가 켜져 있는지, 주소 설정을 확인하세요. (${reason})`);
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', onCancel);
  }
}

// SSE: sources → delta… → done(일반 응답과 같은 JSON) / error({status, detail})
async function readAskStream(body: ReadableStream<Uint8Array>, opts: AskOptions): Promise<AskResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const json = (data: string): Record<string, unknown> => {
    try {
      const v: unknown = JSON.parse(data);
      return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
    } catch {
      return {};
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const parsed = parseSse(done ? buffer + '\n\n' : buffer);
    buffer = parsed.rest;
    for (const ev of parsed.events) {
      if (ev.event === 'sources') {
        // 미리 보기용. 최종 확인은 done 에서 parseAskResponse 가 한다
        const list = json(ev.data).sources;
        if (Array.isArray(list)) {
          opts.onSources(list as AskSource[]);
        }
      } else if (ev.event === 'delta') {
        const text = json(ev.data).text;
        if (typeof text === 'string') {
          opts.onDelta(text);
        }
      } else if (ev.event === 'done') {
        void reader.cancel().catch(() => undefined);
        return parseAskResponse(ev.data);
      } else if (ev.event === 'error') {
        const d = json(ev.data);
        throw askErrorFor(typeof d.status === 'number' ? d.status : 500, typeof d.detail === 'string' ? d.detail : '');
      }
    }
    if (done) {
      throw new AskError('bad_answer', '답변이 중간에 끊겼습니다', '서버가 done 이벤트 없이 연결을 닫았습니다. 다시 물으려면 직접 누르세요.');
    }
  }
}

// ─────────────────────────────────────────────
// 웹페이지가 부탁할 수 있는 일들
// ─────────────────────────────────────────────
let projectLocations: ProjectLocations | undefined;
export function useProjectLocations(locations: ProjectLocations): void {
  projectLocations = locations;
}

function resolveUri(r: SearchResult): vscode.Uri | null {
  if (r.absolute_path) {
    return vscode.Uri.file(r.absolute_path);
  }
  const parts = relativeSourceParts(r.file_path);
  if (!parts?.length) { return null; }
  const remembered = projectLocations?.rootFor(r.project_name);
  if (remembered) { return vscode.Uri.joinPath(vscode.Uri.parse(remembered), ...parts); }
  // 확장 초기화 전에는 현재 워크스페이스만 확인한다.
  const folder = vscode.workspace.workspaceFolders?.find((f) => f.name === r.project_name);
  return folder && !projectLocations ? vscode.Uri.joinPath(folder.uri, ...parts) : null;
}

async function openSource(r: SearchResult): Promise<void> {
  const uri = resolveUri(r);
  if (!uri) {
    // 다른 PC·다른 프로젝트에서 저장한 코드 → 엉뚱한 파일을 열지 않고 안내만
    vscode.window.showWarningMessage(
      `'${r.project_name ?? '(프로젝트 없음)'}' 프로젝트 폴더가 지금 열려 있지 않습니다. 그 폴더를 열고 다시 시도하세요.`
    );
    return;
  }

  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    vscode.window.showWarningMessage(`원본 파일을 찾을 수 없습니다: ${r.file_path}`);
    return;
  }

  // 저장 뒤 파일이 짧아졌으면 줄 번호가 안 맞는다 → 열기는 하되 알려준다
  if (r.end_line > doc.lineCount) {
    vscode.window.showWarningMessage(
      `파일이 저장 때보다 짧습니다 (${r.end_line}줄 → 지금 ${doc.lineCount}줄). 위치가 다를 수 있습니다.`
    );
  }
  const start = Math.min(Math.max(0, r.start_line - 1), doc.lineCount - 1);   // 1부터 → 0부터로
  const end = Math.min(Math.max(start, r.end_line - 1), doc.lineCount - 1);
  const range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
  await vscode.window.showTextDocument(doc, { selection: range, preview: false });
}

async function insertCode(code: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('코드를 넣을 편집기를 먼저 여세요.');
    return;
  }
  // 커서 위치 들여쓰기에 맞춘다:
  //   커서 앞이 공백뿐이면(빈 줄·들여쓴 자리) 그 공백을, 아니면 그 줄의 들여쓰기를 둘째 줄부터 붙인다
  const pos = editor.selection.start;
  const lineText = editor.document.lineAt(pos.line).text;
  const before = lineText.slice(0, pos.character);
  const prefix = before.trim().length === 0 ? before : (/^\s*/.exec(lineText)?.[0] ?? '');
  const eol = editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const text = reindent(code, prefix, eol);
  // insertSnippet 대신 edit 을 쓰는 이유: 코드에 $ 가 있으면 스니펫 문법으로 해석돼서 깨짐
  await editor.edit((builder) => builder.replace(editor.selection, text));
}

// ─────────────────────────────────────────────
// 비교 화면 — 내 코드 ↔ 저장된 코드를 VS Code 비교(diff) 화면으로
//   읽기 전용 가상 문서로 띄워서, 닫을 때 "저장할까요?"가 안 뜨게 한다
// ─────────────────────────────────────────────
export const COMPARE_SCHEME = 'code-memory-compare';

class CompareDocs implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private seq = 0;

  put(name: string, content: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: COMPARE_SCHEME, path: '/' + name, query: String(++this.seq) });
    this.docs.set(uri.toString(), content);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? '';
  }
}
export const compareDocs = new CompareDocs();

type FromWebview =
  | { type: 'search'; query: string; reqId?: number; filter?: Partial<SearchFilter> }
  | { type: 'loadFilters' }
  | { type: 'open'; result: SearchResult }
  | { type: 'connectSource'; result: SearchResult }
  | { type: 'refreshLocal'; results: SearchResult[] }
  | { type: 'insert'; code: string }
  | { type: 'copy'; code: string }
  | { type: 'ready' }
  | { type: 'clearRecent' }
  | { type: 'clearLast' }
  | { type: 'clearHistory' }
  | { type: 'copyText'; text: string }
  | { type: 'prefs'; prefs: UiPrefs }
  | { type: 'switchMode' }
  | { type: 'compare'; result: SearchResult }
  | { type: 'compareSource'; result: SearchResult }
  | { type: 'resave'; result: SearchResult }
  | { type: 'walkthrough' }
  | { type: 'ask'; q: string; reqId: number; history?: AskTurn[]; fresh?: boolean; useServerKey?: boolean }
  | { type: 'askCancel'; reqId: number }
  | { type: 'feedback'; fb: FeedbackRecord }
  | { type: 'exportFeedback' }
  | { type: 'openKeyPanel' }
  | { type: 'saveKey'; provider: LlmProvider; key: string }
  | { type: 'clearKey' }
  | { type: 'setUseOwn'; useOwn: boolean };

// AI 답변 피드백 한 건 — 아직 서버 API 가 없어서 이 PC 에만 저장. "AI 피드백 내보내기"로 JSON 공유
interface FeedbackRecord {
  id: string;
  time: string;
  q: string;
  answer: string;
  status: string;
  model: string | null;
  mock: boolean;
  source_ids: number[];
  rating: 'up' | 'down' | null;   // null = 평가 취소 → 기록에서 뺀다
  reasons: string[];
  memo: string;
}
const FEEDBACK_KEY = 'codeMemory.aiFeedback';
const FEEDBACK_MAX = 200;

// 저장된 답변 — 같은 질문(새 대화)이면 AI 를 다시 부르지 않고 이걸 보여준다. 모드(mock/서버 주소)별로 따로
interface CachedAnswer {
  key: string;
  q: string;
  mode: string;
  time: string;
  result: AskResponse;
}
const ANSWER_CACHE_KEY = 'codeMemory.answerCache';

// 사용자 AI 키 — 키 값은 비밀 저장소(SecretStorage)에만. 무엇을 쓸지·마지막 결과는 globalState (키 값 없음)
const SECRET_KEY = 'codeMemory.llmKey';
const KEY_PREFS_KEY = 'codeMemory.llmKeyPrefs';
interface StoredKey {
  provider: LlmProvider;
  key: string;
  savedAt: string;
}
interface KeyPrefs {
  useOwn: boolean;
  last?: { ok: boolean; time: string; msg?: string };
}
export interface KeyState {
  hasKey: boolean;
  provider: LlmProvider | null;
  providerLabel: string | null;
  masked: string | null;
  savedAt: string | null;
  useOwn: boolean;
  last: KeyPrefs['last'] | null;
  mock: boolean;
  canSend: boolean;
  apiUrl: string;
}
const ANSWER_CACHE_MAX = 10;
const USAGE_KEY = 'codeMemory.aiUsage';

// 저장 시도 한 건 — extension.ts 가 저장할 때마다 넘겨준다
export interface SaveRecord {
  time: string;                    // ISO 시각
  status: 'ok' | 'mock' | 'fail' | 'unconfirmed';
  id?: number;
  function_name: string | null;
  file_path: string;
  start_line: number;
  end_line: number;
  error?: string;
  elapsedMs?: number;              // 요청~응답 걸린 시간
  embedding?: EmbeddingStatus | null;  // null이면 원문은 저장됐지만 검색 준비 상태는 미확정
  masked?: number;                 // 저장 전에 가린 비밀값 수
}
const HISTORY_KEY = 'codeMemory.saveHistory';
const HISTORY_MAX = 20;

// 화면 설정 — 자세히/간단히, 저장 기록 펼침
interface UiPrefs {
  view: 'full' | 'compact';
  historyOpen: boolean;
  filter?: SearchFilter;   // 검색 범위 (프로젝트·언어) — 다시 열어도 유지
  reviewSeen?: Record<string, string>;   // 다시 볼 만한 코드: 파일|함수 → 마지막으로 본 시각
  reviewHidden?: boolean;
  demo?: { on: boolean; done: string[] };   // 시연 모드
  askHintSeen?: boolean;   // "끝에 ? 를 붙이면 AI" 첫 안내를 닫았는지
}
const PREFS_KEY = 'codeMemory.uiPrefs';
const DEFAULT_PREFS: UiPrefs = { view: 'full', historyOpen: false };

// 마지막 검색 — 다시 열었을 때 복원용
interface SavedSearch {
  query: string;
  results: SearchResult[];
  filter?: SearchFilter;
  check?: FilterCheck;
}
const STATE_KEY = 'codeMemory.lastSearch';
const RECENT_KEY = 'codeMemory.recentQueries';   // 최근 검색어 (최대 5개)
const RECENT_MAX = 5;

// 최근 검색어 한 건 — ai: AI 질문으로 보냈던 것 (예전 기록은 문자열이라 검색으로 본다)
interface RecentItem {
  q: string;
  ai: boolean;
}
function toRecent(v: unknown): RecentItem | null {
  if (typeof v === 'string') {
    return { q: v, ai: false };
  }
  if (v && typeof v === 'object' && typeof (v as RecentItem).q === 'string') {
    return { q: (v as RecentItem).q, ai: !!(v as RecentItem).ai };
  }
  return null;
}

// 결과마다 "이 PC 에서 원본을 열 수 있는지" 미리 확인해서 붙인다
//   ok: 열 수 있음 / no_folder: 그 프로젝트 폴더가 안 열려 있음 / missing: 폴더는 있는데 파일이 없음
type LocalStatus = 'ok' | 'no_folder' | 'missing';

// 원본을 열 수 있으면 저장한 코드와 지금 파일도 비교한다
//   source: same(그대로) / moved(위치만 바뀜 → moved_start~moved_end) / changed(내용이 바뀜)
type WithLocal<T> = T & { local: LocalStatus; source?: SourceState; moved_start?: number; moved_end?: number };
const SOURCE_READ_MAX = 2 * 1024 * 1024;   // 이보다 큰 파일은 비교하지 않는다

async function withLocalStatus<T extends SearchResult>(results: T[]): Promise<WithLocal<T>[]> {
  const files = new Map<string, Promise<string | null>>();   // 같은 파일은 한 번만 읽는다
  const read = (uri: vscode.Uri) => {
    const key = uri.toString();
    if (!files.has(key)) {
      files.set(key, (async () => {
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.size > SOURCE_READ_MAX) {
            return '';
          }
          return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
        } catch {
          return null;
        }
      })());
    }
    return files.get(key)!;
  };
  return Promise.all(results.map(async (r): Promise<WithLocal<T>> => {
    const uri = resolveUri(r);
    if (!uri) {
      return { ...r, local: 'no_folder' };
    }
    const text = await read(uri);
    if (text === null) {
      return { ...r, local: 'missing' };
    }
    if (!text) {
      return { ...r, local: 'ok' };   // 너무 큰 파일 — 비교 생략
    }
    const check = compareSource(r.code, text, r.start_line, r.end_line);
    return { ...r, local: 'ok', source: check.state, moved_start: check.start, moved_end: check.end };
  }));
}

// 지금 파일에서 그 함수가 있는 범위 — 코드 구조(기호)로 찾고, 없으면 저장 때 줄 범위
const FN_KINDS = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);
function toSimple(s: vscode.DocumentSymbol | vscode.SymbolInformation): SimpleSymbol {
  const range = 'children' in s ? s.range : s.location.range;
  return {
    name: s.name,
    kind: FN_KINDS.has(s.kind) ? 'function' : s.kind === vscode.SymbolKind.Class ? 'class' : 'other',
    startLine: range.start.line, endLine: range.end.line,
    children: 'children' in s ? s.children.map(toSimple) : [],
  };
}
async function currentRange(doc: vscode.TextDocument, r: SearchResult): Promise<vscode.Range> {
  const line = Math.min(Math.max(0, r.start_line - 1), doc.lineCount - 1);
  let start = line;
  let end = Math.min(Math.max(line, r.end_line - 1), doc.lineCount - 1);
  try {
    const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>(
      'vscode.executeDocumentSymbolProvider', doc.uri);
    const { fn } = pickSymbol((symbols ?? []).map(toSimple), line);
    if (fn) {
      start = fn.startLine;
      end = Math.min(fn.endLine, doc.lineCount - 1);
    }
  } catch {
    // 기호를 못 받으면 저장 때 줄 범위
  }
  return new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
}

// ─────────────────────────────────────────────
// 사이드바 패널 — VS Code 가 패널을 처음 보여줄 때 resolveWebviewView 를 부른다
// ─────────────────────────────────────────────
export class SearchViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'codeMemory.searchView';

  private view: vscode.WebviewView | undefined;
  private ready = false;                       // 웹페이지 스크립트가 메시지를 받을 준비가 됐는지
  private pendingQuery: string | undefined;    // 패널이 열리기 전에 들어온 "이걸로 검색해줘"
  private pendingFocus = false;                // 패널이 열리기 전에 들어온 "검색창에 커서"

  private pendingPrefill: { text: string; selStart: number; selEnd: number } | undefined;   // "이 코드에 대해 묻기"
  private readonly askCtrls = new Map<number, AbortController>();   // 생성 중인 질문 → 취소용
  private readonly usageEmitter = new vscode.EventEmitter<UsageDay>();
  public readonly onDidChangeUsage = this.usageEmitter.event;

  // state: 마지막 검색·최근 검색어·저장 기록·화면 설정·저장된 답변을 워크스페이스별로 저장 (다시 열어도 남는다)
  // global: 이 PC 전체 — 오늘 AI 사용량, AI 피드백
  constructor(
    private readonly state: vscode.Memento,
    private readonly global: vscode.Memento,
    private readonly secrets: vscode.SecretStorage,
  ) {}

  public sourceLocationsChanged(): void {
    if (this.view && this.ready) { this.view.webview.postMessage({ type: 'sourceLocationsChanged' }); }
  }

  public async connectSourceProject(result?: SearchResult): Promise<void> {
    if (!projectLocations) { return; }
    const name = result?.project_name ?? await vscode.window.showInputBox({
      title: '원본 프로젝트 위치 연결',
      prompt: '검색 결과에 표시된 프로젝트 이름',
      value: vscode.workspace.workspaceFolders?.[0]?.name,
      validateInput: (value) => value.trim() ? undefined : '프로젝트 이름을 입력하세요.',
    });
    if (!name) { return; }
    const parts = result ? relativeSourceParts(result.file_path) : undefined;
    if (result && !parts?.length) {
      vscode.window.showWarningMessage('올바른 상대 파일 경로가 아닙니다.');
      return;
    }
    const selected = await vscode.window.showOpenDialog({
      title: `${name} 원본 프로젝트 폴더를 선택하세요`,
      openLabel: '이 위치 기억하기', canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
    });
    const root = selected?.[0];
    if (!root) { return; }
    let target = result;
    if (result && parts) {
      try {
        const uri = vscode.Uri.joinPath(root, ...parts);
        const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
        const check = compareSource(result.code, text, result.start_line, result.end_line);
        if (check.state === 'moved' && check.start !== undefined && check.end !== undefined) {
          target = { ...result, start_line: check.start, end_line: check.end };
        }
        if (check.state === 'changed') {
          const choice = await vscode.window.showWarningMessage(
            '선택한 파일의 코드가 저장본과 다릅니다.',
            { modal: true, detail: `${uri.fsPath}\n이 프로젝트 위치로 연결할까요?` }, '이 위치로 연결',
          );
          if (choice !== '이 위치로 연결') { return; }
        }
      } catch {
        vscode.window.showWarningMessage(`이 폴더에서 ${result.file_path} 파일을 찾거나 읽을 수 없습니다.`);
        return;
      }
    }
    await projectLocations.connect(name, root.toString());
    this.sourceLocationsChanged();
    if (target) { await openSource(target); }
    else { vscode.window.showInformationMessage(`${name}의 원본 위치를 기억했습니다. 프로젝트를 닫아도 원본을 열 수 있습니다.`); }
  }

  // ── 사용자 AI 키
  private readonly keyEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeKey = this.keyEmitter.event;
  private async readKey(): Promise<StoredKey | undefined> {
    try {
      const raw = await this.secrets.get(SECRET_KEY);
      return raw ? JSON.parse(raw) as StoredKey : undefined;
    } catch {
      return undefined;
    }
  }
  private keyPrefs(): KeyPrefs {
    return this.global.get<KeyPrefs>(KEY_PREFS_KEY, { useOwn: true });
  }
  public async keyState(): Promise<KeyState> {
    const k = await this.readKey();
    const prefs = this.keyPrefs();
    const config = vscode.workspace.getConfiguration('codeMemory');
    const apiUrl = config.get<string>('apiUrl', 'http://localhost:8000');
    return {
      hasKey: !!k,
      provider: k?.provider ?? null,
      providerLabel: k ? LLM_PROVIDERS.find((p) => p.id === k.provider)?.label ?? k.provider : null,
      masked: k ? maskKey(k.key) : null,
      savedAt: k?.savedAt ?? null,
      useOwn: prefs.useOwn,
      last: prefs.last ?? null,
      mock: config.get<boolean>('mock', true),
      canSend: canSendKey(apiUrl),
      apiUrl,
    };
  }
  private async setKeyPrefs(p: Partial<KeyPrefs>): Promise<void> {
    await this.global.update(KEY_PREFS_KEY, { ...this.keyPrefs(), ...p });
    this.keyEmitter.fire();
  }
  private async postKeyState(show = false): Promise<void> {
    if (this.view && this.ready) {
      this.view.webview.postMessage({ type: 'keyState', state: await this.keyState(), show });
    }
  }
  // 일반 AI 질문과 팀 평가가 같은 개인 키 선택·전송 규칙을 사용한다.
  public async keyForRequest(useServerKey = false): Promise<{
    key: { provider: LlmProvider; value: string } | undefined;
    keyUsed: string | null;
    keyBlocked: boolean;
  }> {
    const config = vscode.workspace.getConfiguration('codeMemory');
    const stored = config.get<boolean>('mock', true) || useServerKey || !this.keyPrefs().useOwn
      ? undefined : await this.readKey();
    const keyBlocked = !!stored && !canSendKey(config.get<string>('apiUrl', 'http://localhost:8000'));
    const key = stored && !keyBlocked ? { provider: stored.provider, value: stored.key } : undefined;
    return {
      key,
      keyUsed: key ? LLM_PROVIDERS.find((p) => p.id === key.provider)?.label ?? key.provider : null,
      keyBlocked,
    };
  }

  // 시연 모드 켜기/끄기 (명령 팔레트·상태 표시줄 메뉴)
  public async toggleDemo(): Promise<void> {
    this.pendingDemo = true;
    await vscode.commands.executeCommand(`${SearchViewProvider.viewId}.focus`);
    this.flush();
  }
  private pendingDemo = false;

  // 제목줄 🔑 / 상태 표시줄 메뉴 → 패널을 열고 키 화면
  public async openKeySettings(): Promise<void> {
    this.pendingKeyPanel = true;
    await vscode.commands.executeCommand(`${SearchViewProvider.viewId}.focus`);
    this.flush();
  }
  private pendingKeyPanel = false;

  // ── 오늘 AI 사용량 (실제 서버 질문만. mock·저장된 답변은 안 셈)
  public usageToday(): UsageDay {
    return todayUsage(this.global.get<UsageDay>(USAGE_KEY), localDateKey(new Date()));
  }
  private async addUsage(tokens: number): Promise<UsageDay> {
    const next = addUsage(this.global.get<UsageDay>(USAGE_KEY), localDateKey(new Date()), tokens);
    await this.global.update(USAGE_KEY, next);
    this.usageEmitter.fire(next);
    return next;
  }

  // ── 저장된 답변
  private modeKey(): string {
    const config = vscode.workspace.getConfiguration('codeMemory');
    return config.get<boolean>('mock', true) ? 'mock' : config.get<string>('apiUrl', 'http://localhost:8000').replace(/\/+$/, '');
  }
  private findCache(q: string): CachedAnswer | undefined {
    const key = askCacheKey(q);
    const mode = this.modeKey();
    return this.state.get<CachedAnswer[]>(ANSWER_CACHE_KEY, []).find((c) => c.key === key && c.mode === mode);
  }
  private async putCache(q: string, result: AskResponse): Promise<void> {
    const key = askCacheKey(q);
    const mode = this.modeKey();
    const items = [{ key, q, mode, time: new Date().toISOString(), result },
      ...this.state.get<CachedAnswer[]>(ANSWER_CACHE_KEY, []).filter((c) => !(c.key === key && c.mode === mode))].slice(0, ANSWER_CACHE_MAX);
    await this.state.update(ANSWER_CACHE_KEY, items);
  }

  // ── AI 피드백
  private async saveFeedback(fb: FeedbackRecord): Promise<void> {
    const rest = this.global.get<FeedbackRecord[]>(FEEDBACK_KEY, []).filter((x) => x.id !== fb.id);
    const items = fb.rating ? [fb, ...rest].slice(0, FEEDBACK_MAX) : rest;
    await this.global.update(FEEDBACK_KEY, items);
  }
  public feedbackCounts(): { up: number; down: number } {
    const items = this.global.get<FeedbackRecord[]>(FEEDBACK_KEY, []);
    return { up: items.filter((x) => x.rating === 'up').length, down: items.filter((x) => x.rating === 'down').length };
  }
  public async exportFeedback(): Promise<void> {
    const items = this.global.get<FeedbackRecord[]>(FEEDBACK_KEY, []);
    if (!items.length) {
      vscode.window.showInformationMessage('아직 남긴 AI 피드백이 없습니다. 답변 아래 👍 / 👎 로 남길 수 있어요.');
      return;
    }
    const content = JSON.stringify({
      exported_at: new Date().toISOString(),
      count: items.length,
      up: items.filter((x) => x.rating === 'up').length,
      down: items.filter((x) => x.rating === 'down').length,
      items,
    }, null, 2);
    const doc = await vscode.workspace.openTextDocument({ language: 'json', content });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  // "이 코드에 대해 묻기" → 패널을 열고 검색창에 질문을 채운다 (보내지는 않음)
  public async prefillAsk(text: string, selStart: number, selEnd: number): Promise<void> {
    this.pendingPrefill = { text, selStart, selEnd };
    await vscode.commands.executeCommand(`${SearchViewProvider.viewId}.focus`);
    this.flush();
  }

  // 저장 알림의 "검색에서 확인" → 패널을 열고 그 검색어로 바로 검색
  public async searchFor(query: string): Promise<void> {
    this.pendingQuery = query;
    await vscode.commands.executeCommand(`${SearchViewProvider.viewId}.focus`);
    this.flush();
  }

  // 단축키 → 패널을 열고 검색창에 커서
  public async focusSearch(): Promise<void> {
    this.pendingFocus = true;
    await vscode.commands.executeCommand(`${SearchViewProvider.viewId}.focus`);
    this.flush();
  }

  // "비슷한 코드 찾기"에 쓴 원래 코드 — 결과 카드의 "비교"에서 선택이 없을 때 왼쪽에 쓴다
  private compareSource: { code: string; languageId: string } | undefined;
  public setCompareSource(code: string, languageId: string): void {
    this.compareSource = { code, languageId };
  }

  // 결과 카드 "비교": 왼쪽 = 지금 선택한 코드(없으면 비슷한 코드 찾기에 쓴 코드), 오른쪽 = 저장된 코드
  private async compare(r: SearchResult): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    let left: { code: string; label: string } | undefined;
    if (editor && !editor.selection.isEmpty) {
      left = { code: editor.document.getText(editor.selection), label: '선택한 코드' };
    } else if (this.compareSource) {
      left = { code: this.compareSource.code, label: '비슷한 코드 찾기에 쓴 코드' };
    }
    if (!left) {
      vscode.window.showWarningMessage('비교할 코드를 에디터에서 먼저 선택하세요.');
      return;
    }
    const name = r.function_name ?? r.file_path.split('/').pop() ?? 'snippet';
    const ext = r.file_path.includes('.') ? r.file_path.slice(r.file_path.lastIndexOf('.')) : '';   // 확장자로 문법 색
    const leftUri = compareDocs.put(`${left.label}${ext}`, left.code);
    const rightUri = compareDocs.put(`${name} (id ${r.id})${ext}`, r.code);
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${left.label} ↔ ${name} (id ${r.id})`);
  }

  // "바뀐 부분 보기": 왼쪽 = 저장한 코드, 오른쪽 = 지금 파일의 그 함수
  private async diffWithSource(r: SearchResult): Promise<void> {
    const uri = resolveUri(r);
    if (!uri) {
      vscode.window.showWarningMessage('원본 파일을 찾을 수 없습니다.');
      return;
    }
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      vscode.window.showWarningMessage(`원본 파일을 찾을 수 없습니다: ${r.file_path}`);
      return;
    }
    const range = await currentRange(doc, r);
    const name = r.function_name ?? r.file_path.split('/').pop() ?? 'snippet';
    const ext = r.file_path.includes('.') ? r.file_path.slice(r.file_path.lastIndexOf('.')) : '';
    const left = compareDocs.put(`저장한 코드 (id ${r.id})${ext}`, r.code);
    const right = compareDocs.put(`지금 파일 ${r.file_path.split('/').pop()} ${range.start.line + 1}-${range.end.line + 1}${ext}`, doc.getText(range));
    await vscode.commands.executeCommand('vscode.diff', left, right, `${name}: 저장한 코드 ↔ 지금 파일`);
  }

  // "다시 저장": 지금 파일의 그 함수를 선택하고 저장 명령 실행 (기존 행은 그대로 둔다)
  private async resave(r: SearchResult): Promise<void> {
    const uri = resolveUri(r);
    if (!uri) {
      vscode.window.showWarningMessage('원본 파일을 찾을 수 없습니다.');
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const range = await currentRange(doc, r);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    await vscode.commands.executeCommand('codeMemory.saveSnippet');
  }

  // 최근 검색어 — 같은 문장·같은 종류는 맨 앞으로, 최대 5개
  private readRecent(): RecentItem[] {
    return this.state.get<unknown[]>(RECENT_KEY, []).map(toRecent).filter((x): x is RecentItem => x !== null);
  }
  private async pushRecent(q: string, ai: boolean): Promise<(RecentItem & { cached: boolean })[]> {
    const items = [{ q, ai }, ...this.readRecent().filter((r) => !(r.q === q && r.ai === ai))].slice(0, RECENT_MAX);
    await this.state.update(RECENT_KEY, items);
    return this.recentView(items);
  }
  // 최근 기록에 "답변 저장됨" 표시용
  private recentView(items: RecentItem[]): (RecentItem & { cached: boolean })[] {
    return items.map((r) => ({ ...r, cached: r.ai && !!this.findCache(r.q) }));
  }

  // 저장 시도 한 건을 기록 (패널 아래 "저장 기록" + 패널 안 알림)
  public async addSaveRecord(record: SaveRecord): Promise<void> {
    const items = [record, ...this.state.get<SaveRecord[]>(HISTORY_KEY, [])].slice(0, HISTORY_MAX);
    await this.state.update(HISTORY_KEY, items);
    if (this.view && this.ready) {
      this.view.webview.postMessage({ type: 'history', items });
      this.view.webview.postMessage({ type: 'saved', record });
    }
  }

  // 웹페이지가 준비됐으면 밀린 요청을 보낸다 (준비 전이면 'ready' 때 다시 부른다)
  private flush(): void {
    if (!this.view || !this.ready) {
      return;
    }
    if (this.pendingQuery !== undefined) {
      this.view.webview.postMessage({ type: 'runSearch', query: this.pendingQuery });
      this.pendingQuery = undefined;
    }
    if (this.pendingFocus) {
      this.view.webview.postMessage({ type: 'focus' });
      this.pendingFocus = false;
    }
    if (this.pendingDemo) {
      this.pendingDemo = false;
      this.view.webview.postMessage({ type: 'demo' });
    }
    if (this.pendingKeyPanel) {
      this.pendingKeyPanel = false;
      void this.postKeyState(true);
    }
    if (this.pendingPrefill) {
      this.view.webview.postMessage({ type: 'prefill', ...this.pendingPrefill });
      this.pendingPrefill = undefined;
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true };
    view.webview.html = getHtml(view.webview);

    // mock 여부·서버 주소를 웹페이지에 알려준다 (MOCK 안내 줄, 기록 복사). 설정이 바뀌면 다시 보낸다.
    const postConfig = () => {
      const config = vscode.workspace.getConfiguration('codeMemory');
      view.webview.postMessage({
        type: 'config',
        mock: config.get<boolean>('mock', true),
        apiUrl: config.get<string>('apiUrl', 'http://localhost:8000'),
        askTimeout: clamp(config.get<number>('askTimeoutSeconds'), 1, 300, 45),
        askOnQuestionMark: config.get<boolean>('askOnQuestionMark', true),
        reviewAfterDays: clamp(config.get<number>('reviewAfterDays'), 0, 365, 7),
      });
    };
    const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codeMemory')) {
        postConfig();
        void this.postKeyState(false);   // mock·주소가 바뀌면 키 화면 안내도 바뀐다
      }
    });
    view.onDidDispose(() => {
      configListener.dispose();
      this.view = undefined;
      this.ready = false;
    });

    // 웹페이지 → 확장 본체 메시지 받기
    view.webview.onDidReceiveMessage(async (msg: FromWebview) => {
      switch (msg.type) {
        case 'ready': {
          this.ready = true;
          postConfig();
          view.webview.postMessage({ type: 'prefs', prefs: this.state.get<UiPrefs>(PREFS_KEY, DEFAULT_PREFS) });
          view.webview.postMessage({ type: 'recent', items: this.recentView(this.readRecent()) });
          view.webview.postMessage({ type: 'history', items: this.state.get<SaveRecord[]>(HISTORY_KEY, []) });
          // 바로 검색할 게 없으면 지난 검색어·결과를 복원
          const saved = this.state.get<SavedSearch>(STATE_KEY);
          if (this.pendingQuery === undefined && saved) {
            const results = await withLocalStatus(saved.results);
            view.webview.postMessage({ type: 'restore', query: saved.query, results, filter: saved.filter ?? null, check: saved.check ?? 'none' });
          }
          this.flush();
          break;
        }
        case 'search': {
          const filter = normalizeFilter(msg.filter);
          view.webview.postMessage({ type: 'recent', items: await this.pushRecent(msg.query, false) });
          try {
            if (filter.project.length > FILTER_MAX_LENGTH || filter.language.length > FILTER_MAX_LENGTH) {
              throw new SearchError('검색 조건을 확인하세요', `프로젝트·언어 이름은 ${FILTER_MAX_LENGTH}자까지예요.`, 'server');
            }
            const { results, check } = await searchSnippets(msg.query, filter);
            view.webview.postMessage({
              type: 'results', reqId: msg.reqId, query: msg.query, filter, check, results: await withLocalStatus(results),
            });
            await this.state.update(STATE_KEY, { query: msg.query, results, filter, check } satisfies SavedSearch);
          } catch (err) {
            const title = err instanceof SearchError ? err.title : '검색 실패';
            const detail = err instanceof SearchError ? err.detail : err instanceof Error ? err.message : String(err);
            const kind = err instanceof SearchError ? err.kind : 'server';
            view.webview.postMessage({ type: 'error', reqId: msg.reqId, title, detail, kind });
          }
          break;
        }
        case 'loadFilters': {
          const openFolders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.name);
          try {
            view.webview.postMessage({ type: 'filterOptions', options: await loadFilterOptions(), openFolders });
          } catch (err) {
            view.webview.postMessage({
              type: 'filterOptions', options: null, openFolders, error: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }
        case 'ask': {
          // 같은 화면에서 동시에 두 번 묻지 않게 웹페이지가 막지만, 응답에는 reqId 를 붙여 늦게 온 답을 버리게 한다
          const history = Array.isArray(msg.history) ? msg.history : [];
          const mock = vscode.workspace.getConfiguration('codeMemory').get<boolean>('mock', true);
          const today = () => (mock ? null : this.usageToday());
          if (!history.length) {
            // 이어서 묻기("그럼 음수도 돼?")는 앞 대화 없이는 뜻이 없어서 최근 기록에 넣지 않는다
            view.webview.postMessage({ type: 'recent', items: await this.pushRecent(msg.q, true) });
            const hit = msg.fresh ? undefined : this.findCache(msg.q);
            if (hit) {
              // 저장된 답변 → AI 를 다시 부르지 않는다 (사용량 0)
              const sources = await withLocalStatus(hit.result.sources);
              view.webview.postMessage({
                type: 'answer', reqId: msg.reqId, q: msg.q, elapsedMs: 0, historySent: 0, cached: { time: hit.time },
                today: today(), result: { ...hit.result, sources },
              });
              break;
            }
          }
          const ctrl = new AbortController();
          this.askCtrls.set(msg.reqId, ctrl);
          const started = Date.now();
          // 사용자 AI 키: 켜져 있고, mock 이 아니고, 보내도 되는 주소일 때만 싣는다
          const { key, ...keyInfo } = await this.keyForRequest(!!msg.useServerKey);
          try {
            const result = await askBackend(msg.q, {
              key,
              history,
              signal: ctrl.signal,
              onSources: (list) => view.webview.postMessage({
                type: 'askSources', reqId: msg.reqId,
                sources: list.map((s) => ({ citation_id: s.citation_id, function_name: s.function_name, file_path: s.file_path })),
              }),
              onDelta: (text) => view.webview.postMessage({ type: 'askDelta', reqId: msg.reqId, text }),
            });
            const usage = mock ? null : await this.addUsage(result.usage?.total_tokens ?? 0);
            if (!history.length && result.status === 'answered') {
              await this.putCache(msg.q, result);
              view.webview.postMessage({ type: 'recent', items: this.recentView(this.readRecent()) });
            }
            const sources = await withLocalStatus(result.sources);
            if (key) {
              await this.setKeyPrefs({ last: { ok: true, time: new Date().toISOString() } });
            }
            view.webview.postMessage({
              type: 'answer', reqId: msg.reqId, q: msg.q, elapsedMs: Date.now() - started, historySent: history.length,
              today: usage, result: { ...result, sources }, ...keyInfo,
            });
          } catch (err) {
            const e = err instanceof AskError ? err
              : new AskError('server', 'AI 질문 실패', err instanceof Error ? err.message : String(err));
            if (key && e.kind === 'key') {
              await this.setKeyPrefs({ last: { ok: false, time: new Date().toISOString(), msg: e.detail.slice(0, 120) } });
            }
            view.webview.postMessage({
              type: 'askError', reqId: msg.reqId, q: msg.q, title: e.title, detail: e.detail, kind: e.kind, ...keyInfo,
            });
          } finally {
            this.askCtrls.delete(msg.reqId);
          }
          break;
        }
        case 'askCancel': {
          this.askCtrls.get(msg.reqId)?.abort();
          break;
        }
        case 'feedback': {
          await this.saveFeedback(msg.fb);
          break;
        }
        case 'exportFeedback': {
          await this.exportFeedback();
          break;
        }
        case 'openKeyPanel': {
          await this.postKeyState(true);
          break;
        }
        case 'saveKey': {
          const problem = validateKey(msg.key);
          if (problem) {
            view.webview.postMessage({ type: 'keyError', msg: problem });
            break;
          }
          const provider = LLM_PROVIDERS.some((p) => p.id === msg.provider) ? msg.provider : guessProvider(msg.key) ?? 'openai';
          await this.secrets.store(SECRET_KEY, JSON.stringify({ provider, key: msg.key.trim(), savedAt: new Date().toISOString() } satisfies StoredKey));
          await this.setKeyPrefs({ useOwn: true, last: undefined });
          await this.postKeyState(true);
          break;
        }
        case 'clearKey': {
          const ok = await vscode.window.showWarningMessage('저장한 AI 키를 지울까요?', { modal: true, detail: '지우면 서버 기본 키로 AI 답변을 받아요.' }, '지우기');
          if (ok) {
            await this.secrets.delete(SECRET_KEY);
            await this.setKeyPrefs({ last: undefined });
          }
          await this.postKeyState(true);
          break;
        }
        case 'setUseOwn': {
          await this.setKeyPrefs({ useOwn: !!msg.useOwn });
          await this.postKeyState(true);
          break;
        }
        case 'open': {
          await openSource(msg.result);
          break;
        }
        case 'connectSource': {
          await this.connectSourceProject(msg.result);
          break;
        }
        case 'refreshLocal': {
          view.webview.postMessage({ type: 'localStatus', results: await withLocalStatus(msg.results) });
          break;
        }
        case 'insert': {
          await insertCode(msg.code);
          break;
        }
        case 'copy': {
          // 알림 팝업 대신 웹페이지 쪽에서 "복사됨" 표시
          await vscode.env.clipboard.writeText(msg.code);
          break;
        }
        case 'copyText': {
          await vscode.env.clipboard.writeText(msg.text);
          break;
        }
        case 'clearRecent': {
          await this.state.update(RECENT_KEY, []);
          view.webview.postMessage({ type: 'recent', items: [] });
          break;
        }
        case 'clearLast': {
          await this.state.update(STATE_KEY, undefined);
          break;
        }
        case 'clearHistory': {
          await this.state.update(HISTORY_KEY, []);
          view.webview.postMessage({ type: 'history', items: [] });
          break;
        }
        case 'prefs': {
          await this.state.update(PREFS_KEY, msg.prefs);
          break;
        }
        case 'switchMode': {
          await vscode.commands.executeCommand('codeMemory.switchMode');
          break;
        }
        case 'compare': {
          await this.compare(msg.result);
          break;
        }
        case 'compareSource': {
          await this.diffWithSource(msg.result);
          break;
        }
        case 'resave': {
          await this.resave(msg.result);
          break;
        }
        case 'walkthrough': {
          await vscode.commands.executeCommand('codeMemory.openWalkthrough');
          break;
        }
      }
    });
  }
}

// ─────────────────────────────────────────────
// 웹페이지 내용 (HTML + CSS + JS)
// ─────────────────────────────────────────────
function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

function getHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  /* 색은 전부 VS Code 테마 변수 → 다크·라이트 테마를 그대로 따라간다 */
  [hidden] { display: none !important; }
  /* keep-all: 한글이 글자 중간("나옵니/다")에서 끊기지 않고 띄어쓰기에서 줄바꿈 */
  body { word-break: keep-all; overflow-wrap: anywhere; margin: 0; padding: 0 0 56px;
         font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  button { font: inherit; cursor: pointer; }
  button:disabled { cursor: default; }
  svg.i { width: 13px; height: 13px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }

  .banner { display: flex; gap: 6px; align-items: center; font-size: 12px; padding: 5px 8px; margin: 6px 10px 8px;
            border-left: 3px solid var(--vscode-editorWarning-foreground);
            background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 10%, transparent); border-radius: 0 3px 3px 0; }
  .banner b { flex: none; white-space: nowrap; color: var(--vscode-editorWarning-foreground); font-weight: 600; }   /* MOCK 글자는 줄어들거나 끊기지 않게 */

  /* A. 검색창·요약줄은 스크롤해도 위에 붙어 있다 */
  .header { position: sticky; top: 0; z-index: 5; padding: 6px 10px 2px;
            background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-bottom: 1px solid transparent; }
  .header.shadow { border-bottom-color: var(--vscode-widget-border, #8883); box-shadow: 0 4px 6px -4px var(--vscode-widget-shadow, #0008); }
  .search { position: relative; margin: 0 0 6px; }
  .search > svg { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px;
                  stroke: var(--vscode-descriptionForeground); fill: none; stroke-width: 2; pointer-events: none; }
  .search input { box-sizing: border-box; width: 100%; padding: 6px 60px 6px 28px; font: inherit;
                  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
                  border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
  .search input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .search .go { position: absolute; right: 3px; top: 3px; bottom: 3px; padding: 0 10px; font-size: 12px; border: 0; border-radius: 3px;
                color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .search .go:hover { background: var(--vscode-button-hoverBackground); }
  .search .go:disabled { opacity: 0.5; }

  .recent { position: absolute; left: 0; right: 0; top: calc(100% + 2px); z-index: 10; padding: 4px 0; border-radius: 4px;
            background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background));
            border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, #8884));
            box-shadow: 0 4px 12px var(--vscode-widget-shadow, #0006); }
  .recent-head { display: flex; justify-content: space-between; padding: 2px 10px 4px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .link-btn { padding: 0; border: 0; background: none; font-size: 11px; color: var(--vscode-textLink-foreground); }
  .link-btn:hover { text-decoration: underline; }
  .recent-item { display: flex; align-items: center; padding: 4px 10px; cursor: pointer; white-space: nowrap; }
  .recent-item .rq { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .recent-item .rcached { flex: none; margin-left: 8px; font-size: 10.5px; color: var(--vscode-descriptionForeground); }
  .recent-item:hover { background: var(--vscode-list-hoverBackground); }
  .recent-item.active { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }

  /* 요약줄: 결과 수 · 자세히/간단히 · 기록 복사 · 지우기 */
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 4px; min-height: 22px; margin: 0 0 4px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .bar .grow { flex: 1 1 170px; min-width: 0; display: flex; align-items: center; gap: 4px; white-space: nowrap; overflow: hidden; }   /* 이보다 좁으면 버튼이 아랫줄로 */
  .bar .tools { margin-left: auto; }
  .bar .sq { flex: 0 1 auto; min-width: 3em; overflow: hidden; text-overflow: ellipsis; color: var(--vscode-foreground); }
  .bar .sdot, .bar .sc { flex: none; }
  .tools { display: flex; align-items: center; gap: 2px; flex: none; }
  .seg { display: inline-flex; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #8884)); border-radius: 4px; overflow: hidden; margin-right: 2px; }
  .seg button { padding: 1px 7px; font-size: 11px; border: 0; background: transparent; color: var(--vscode-descriptionForeground); }
  .seg button.on { color: var(--vscode-foreground); background: color-mix(in srgb, var(--vscode-foreground) 14%, transparent); }
  .ibtn { display: inline-flex; align-items: center; gap: 3px; padding: 2px 5px; font-size: 11px; border: 0; border-radius: 3px;
          color: var(--vscode-descriptionForeground); background: transparent; }
  .ibtn:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
  .ibtn.done { color: var(--vscode-testing-iconPassed, #73c991); }
  .ibtn svg.i { width: 12px; height: 12px; }

  /* 결과 필터 (언어·프로젝트가 2가지 이상일 때만) */
  /* 검색 범위 (프로젝트·언어) — 서버에서 먼저 거른다 */
  .frow { position: relative; display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin: 0 0 6px; font-size: 11.5px; }
  .flbl { font-size: 11px; color: var(--vscode-descriptionForeground); margin-right: 1px; }
  .fchip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 2px 8px; border-radius: 12px; font-size: 11.5px;
           color: var(--vscode-foreground); background: transparent;
           border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #8886)); }
  .fchip:hover { background: var(--vscode-list-hoverBackground); }
  .fchip svg.i { width: 12px; height: 12px; }
  .fchip .fk { color: var(--vscode-descriptionForeground); }
  .fchip .fv { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
  .fchip.on { color: var(--vscode-textLink-foreground); border-color: var(--vscode-textLink-foreground);
              background: color-mix(in srgb, var(--vscode-textLink-foreground) 10%, transparent); }
  .fchip.on .fk { color: inherit; opacity: 0.8; }
  .fchip.open { outline: 1px solid var(--vscode-focusBorder); }
  .fchip .fx { display: inline-flex; margin-left: 1px; opacity: 0.85; border-radius: 3px; }
  .fchip .fx:hover { opacity: 1; background: color-mix(in srgb, var(--vscode-textLink-foreground) 20%, transparent); }
  .fclear { margin-left: auto; }
  .fmenu { position: absolute; top: calc(100% + 3px); z-index: 12; width: 240px; max-width: calc(100vw - 24px); padding: 4px 0; border-radius: 5px; font-size: 12px;
           background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background));
           border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, #8884));
           box-shadow: 0 6px 16px var(--vscode-widget-shadow, #0008); }
  .fmenu input { box-sizing: border-box; width: calc(100% - 12px); margin: 2px 6px 4px; padding: 3px 6px; font: inherit; font-size: 11.5px; border-radius: 3px;
                 color: var(--vscode-input-foreground); background: var(--vscode-input-background);
                 border: 1px solid var(--vscode-focusBorder); outline: none; }
  .fmenu hr { border: 0; border-top: 1px solid var(--vscode-widget-border, #8884); margin: 3px 0; }
  .fit { display: flex; align-items: center; gap: 6px; padding: 3px 10px; cursor: pointer; white-space: nowrap; }
  .fit.hl, .fit:hover { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
  .fit .fchk { width: 12px; color: var(--vscode-textLink-foreground); }
  .fit .fname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .fit .ftag { flex: none; font-size: 10px; padding: 0 5px; border-radius: 7px; color: var(--vscode-textLink-foreground);
               border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 50%, transparent); }
  .fit .fcount { flex: none; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .fit.hl .fcount, .fit:hover .fcount { color: inherit; opacity: 0.8; }
  .ffoot { padding: 2px 10px; font-size: 10.5px; color: var(--vscode-descriptionForeground); }
  .ffoot.err { color: var(--vscode-editorWarning-foreground); }
  .fwarn { margin: 0 0 6px; }
  .bar .scope { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--vscode-textLink-foreground); }
  .bar .scope.warn { color: var(--vscode-editorWarning-foreground); }

  .content { padding: 0 10px; }
  .intro { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 2px 2px 6px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 10px; }
  .chip { font-size: 12px; padding: 3px 9px; border-radius: 12px; color: var(--vscode-foreground); background: transparent;
          border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #8884)); }
  .chip:hover { background: var(--vscode-list-hoverBackground); }

  /* 카드 (자세히) */
  .card { padding: 8px 8px 6px; border-radius: 6px; margin: 2px 0; }
  .card:hover { background: var(--vscode-list-hoverBackground); }
  .card:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; background: var(--vscode-list-hoverBackground); }
  .divider { height: 1px; margin: 2px 0; background: var(--vscode-widget-border, var(--vscode-panel-border, #8883)); }
  .head { display: flex; align-items: center; gap: 6px; }
  .rank { flex: none; min-width: 22px; height: 18px; padding: 0 4px; box-sizing: border-box; border-radius: 4px; font-size: 11px;
          display: inline-flex; align-items: center; justify-content: center; font-variant-numeric: tabular-nums;
          color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); }
  .top .rank { color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600;
          font-family: var(--vscode-editor-font-family); font-size: 12.5px; }
  .sim { flex: none; font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sim b { color: var(--vscode-foreground); font-weight: 500; }
  .loc { margin: 3px 0 0 28px; font-size: 12px; overflow-wrap: anywhere; }
  .loc a, .where.ok { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .loc a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
  .loc-off { color: var(--vscode-descriptionForeground); }
  .loc-old { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
  .stag { margin-left: 6px; padding: 0 5px; border-radius: 3px; font-size: 10.5px; white-space: nowrap; border: 1px solid; flex: none; }
  .stag.ok { color: var(--vscode-testing-iconPassed, #73c991); border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 45%, transparent); opacity: 0.85; }
  .stag.i { color: var(--vscode-textLink-foreground); border-color: color-mix(in srgb, var(--vscode-textLink-foreground) 50%, transparent); }
  .stag.w { color: var(--vscode-editorWarning-foreground); border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground) 50%, transparent); }
  .srcwarn { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin: 4px 0 2px 28px; padding: 4px 8px; font-size: 11.5px;
             border-radius: 0 4px 4px 0; border-left: 3px solid var(--vscode-editorWarning-foreground);
             background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 10%, transparent); }
  .tag { margin-left: 6px; padding: 0 5px; border-radius: 3px; font-size: 10.5px; white-space: nowrap;
         color: var(--vscode-editorWarning-foreground);
         border: 1px solid color-mix(in srgb, var(--vscode-editorWarning-foreground) 50%, transparent); }
  .sub { display: flex; align-items: center; gap: 5px; margin: 1px 0 6px 28px; font-size: 11px; color: var(--vscode-descriptionForeground);
         overflow: hidden; white-space: nowrap; }
  .sub span:last-child { overflow: hidden; text-overflow: ellipsis; }
  /* E. 언어 색 점 */
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); }

  .code { position: relative; margin-left: 28px; padding: 4px 0; overflow: hidden; border-radius: 4px;
          font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 1.5;
          background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-widget-border, transparent); }
  .code.clip { max-height: 98px; }
  .code.clip::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 28px;
                      background: linear-gradient(transparent, var(--vscode-textCodeBlock-background)); }
  .ln { display: flex; white-space: pre; }
  .n { flex: none; width: 30px; padding-right: 8px; text-align: right; user-select: none; color: var(--vscode-editorLineNumber-foreground); }
  .t { padding-right: 8px; overflow: hidden; text-overflow: ellipsis; }
  .kw { color: var(--vscode-debugTokenExpression-boolean, #569cd6); }
  .fn { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
  .type { color: var(--vscode-symbolIcon-classForeground, #4ec9b0); }
  .str { color: var(--vscode-debugTokenExpression-string, #ce9178); }
  .num { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
  .com { color: var(--vscode-descriptionForeground); font-style: italic; }
  .const { color: var(--vscode-debugTokenExpression-boolean, #569cd6); }
  .deco { color: var(--vscode-debugTokenExpression-name, #c586c0); }
  .more { margin: 2px 0 0 28px; padding: 0; border: 0; background: none; font-size: 11px; color: var(--vscode-textLink-foreground); }

  /* D. 버튼은 평소 흐리게, 마우스·키보드로 고른 카드만 진하게 */
  .acts { display: flex; flex-wrap: wrap; gap: 2px; margin: 6px 0 0 24px; opacity: 0.55; transition: opacity 0.12s; }
  .card:hover .acts, .card:focus .acts, .card:focus-within .acts { opacity: 1; }
  .acts button { display: inline-flex; align-items: center; gap: 4px; padding: 3px 7px; font-size: 12px; border: 0; border-radius: 3px; white-space: nowrap;
                 color: var(--vscode-foreground); background: transparent; }
  .acts button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
  .acts button:disabled { opacity: 0.4; background: transparent; }
  .acts button.done { color: var(--vscode-testing-iconPassed, #73c991); }

  /* C. 간단히 보기 — 한 줄에 하나 */
  .card.compact { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 4px; margin: 1px 0; cursor: pointer; }
  .card.compact.off { cursor: default; }
  .compact .name { flex: 0 1 auto; max-width: 45%; }
  .compact .where { flex: 1; min-width: 0; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }

  /* AI 질문 */
  /* 끝에 ? 면 AI 모드: 돋보기 → ✦, 테두리·버튼 색 */
  .search .ai-icon { display: none; }
  .search.ai .search-icon { display: none; }
  .search.ai .ai-icon { display: block; stroke: var(--vscode-textLink-foreground); }
  .search.ai input { border-color: var(--vscode-textLink-foreground); }
  .search.ai input:focus { outline-color: var(--vscode-textLink-foreground); }
  .askhint-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: -2px 0 6px; padding: 4px 8px;
                 font-size: 11px; border-radius: 4px; color: var(--vscode-descriptionForeground);
                 background: color-mix(in srgb, var(--vscode-textLink-foreground) 8%, transparent); }
  .askhint-bar b { color: var(--vscode-textLink-foreground); }
  .askhint-bar .link-btn { flex: none; }
  .chip.ask { border-color: color-mix(in srgb, var(--vscode-textLink-foreground) 55%, transparent); color: var(--vscode-textLink-foreground); }
  .rtag { margin-right: 6px; color: var(--vscode-textLink-foreground); }
  .suggest { margin: 2px 0 8px; }
  .suggest button { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 8px; font-size: 12px; text-align: left; border-radius: 4px;
                    color: var(--vscode-textLink-foreground); background: color-mix(in srgb, var(--vscode-textLink-foreground) 6%, transparent);
                    border: 1px dashed color-mix(in srgb, var(--vscode-textLink-foreground) 55%, transparent); }
  .suggest button:hover { background: color-mix(in srgb, var(--vscode-textLink-foreground) 12%, transparent); }
  .suggest .grow { flex: 1; }
  .kbd { flex: none; font-size: 10.5px; color: var(--vscode-descriptionForeground); }
  .answer { margin: 4px 0 10px; padding: 8px 10px; border-radius: 6px;
            border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #8884));
            background: color-mix(in srgb, var(--vscode-textLink-foreground) 6%, transparent); }
  .ahead { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; row-gap: 2px; font-size: 12px; white-space: nowrap; }
  .ahead strong, .ahead .achip { flex: none; }
  .htools { display: inline-flex; align-items: center; gap: 1px; margin-left: auto; }
  .ahead .ibtn { flex: none; padding: 2px 4px; }
  .ahead .ibtn.on { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
  .ahead .ibtn.regen { color: var(--vscode-textLink-foreground); }
  .answer:focus { outline: none; }
  .answer:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .ahead .grow { flex: 1; }
  .ahead .qmini, .ahead .expand { display: none; }
  .answer.collapsed { padding: 5px 10px; margin-bottom: 6px; }
  .answer.collapsed > *:not(.ahead) { display: none; }
  .answer.collapsed .achip { display: none; }
  .answer.collapsed .ahead .qmini { display: inline; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                                    font-size: 11px; color: var(--vscode-descriptionForeground); }
  .answer.collapsed .ahead .grow { flex: 0 0 4px; }
  .answer.collapsed .ahead .expand { display: inline; margin-left: auto; }
  .answer.collapsed .htools > .ibtn:not(:last-child) { display: none; }
  .answer.collapsed .ahead { flex-wrap: nowrap; }
  .answer.collapsed .ahead .expand { margin-left: auto; }
  .answer.collapsed .htools { margin-left: 4px; }
  .achip { padding: 0 6px; border-radius: 8px; font-size: 10.5px; white-space: nowrap; border: 1px solid; }
  .achip.ok { color: var(--vscode-testing-iconPassed, #73c991); border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 50%, transparent); }
  .achip.warn { color: var(--vscode-editorWarning-foreground); border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground) 50%, transparent); }
  .achip.pending { color: var(--vscode-textLink-foreground); border-color: color-mix(in srgb, var(--vscode-textLink-foreground) 50%, transparent); }
  .achip.err { color: var(--vscode-errorForeground); border-color: color-mix(in srgb, var(--vscode-errorForeground) 50%, transparent); }
  .achip.saved { color: var(--vscode-descriptionForeground); border-color: color-mix(in srgb, var(--vscode-descriptionForeground) 45%, transparent); }

  /* 단축키 목록 (헤더의 ?) */
  .keys { margin: 6px 0 2px; padding: 5px 9px; border-radius: 4px; font-size: 11.5px;
          background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, #8884); }
  .keys div { display: flex; justify-content: space-between; gap: 8px; padding: 1px 0; }
  .keys kbd { font-family: var(--vscode-editor-font-family); font-size: 10.5px; padding: 0 5px; border-radius: 3px;
              border: 1px solid var(--vscode-widget-border, #8886); border-bottom-width: 2px; }

  /* 이어서 묻기 — 앞 대화 한 줄 + 입력칸 */
  .prev { display: flex; align-items: center; gap: 5px; margin: 4px 0 2px; padding: 2px 6px; font-size: 11px; white-space: nowrap;
          color: var(--vscode-descriptionForeground); border-left: 2px solid color-mix(in srgb, var(--vscode-foreground) 25%, transparent); }
  .prev .ptext { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .prev .newchat { flex: none; margin-left: 6px; }
  .follow { display: flex; gap: 4px; margin-top: 8px; }
  .follow input { flex: 1; min-width: 0; padding: 4px 7px; font: inherit; font-size: 12px; border-radius: 3px;
                  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
                  border: 1px solid var(--vscode-input-border, transparent); }
  .follow input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

  /* 한 글자씩 */
  .found { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 2px 0 6px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .fpill { padding: 0 6px; border-radius: 3px; font-family: var(--vscode-editor-font-family);
           color: var(--vscode-foreground); background: color-mix(in srgb, var(--vscode-foreground) 9%, transparent); }
  .caret { display: inline-block; width: 7px; height: 1.1em; margin-left: 1px; vertical-align: -2px;
           background: var(--vscode-textLink-foreground); animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }

  /* 답변 속 코드 글씨 */
  .icode { font-family: var(--vscode-editor-font-family); font-size: 0.95em; padding: 0 3px; border-radius: 3px;
           background: var(--vscode-textCodeBlock-background, color-mix(in srgb, var(--vscode-foreground) 10%, transparent)); }

  /* 인용 안 된 참고 코드 — 한 줄로 접어서 아래 */
  .uncited { display: flex; align-items: center; gap: 6px; width: 100%; margin: 4px 0 0; padding: 4px 6px; border-radius: 4px; text-align: left;
             font-size: 11px; white-space: nowrap; color: var(--vscode-descriptionForeground); background: transparent;
             border: 1px dashed color-mix(in srgb, var(--vscode-foreground) 25%, transparent); }
  .uncited:hover { color: var(--vscode-foreground); }
  .uncited svg.i { transition: transform 0.12s; }
  .uncited.open svg.i { transform: rotate(90deg); }
  .uncited .ulabel { flex: none; }
  .uncited .unames { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-family: var(--vscode-editor-font-family); opacity: 0.8; }
  .asrc.dim .card { opacity: 0.75; }

  /* 버튼 줄 + 피드백 */
  .act { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .act .btns.left { margin-top: 0; }
  .fb { display: inline-flex; align-items: center; gap: 1px; margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .fb .fbq { margin-right: 3px; white-space: nowrap; }
  .fb .ibtn.on.up { color: var(--vscode-textLink-foreground); background: color-mix(in srgb, var(--vscode-textLink-foreground) 15%, transparent); }
  .fb .ibtn.on.down { color: var(--vscode-editorWarning-foreground); background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 15%, transparent); }
  .reasons { margin-top: 6px; padding: 6px 8px; border-radius: 4px; background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent); }
  .reasons .rt { margin-bottom: 5px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .rchips { display: flex; flex-wrap: wrap; gap: 4px; }
  .rchip { padding: 1px 8px; border-radius: 10px; font-size: 11px; color: var(--vscode-foreground); background: transparent;
           border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #8886)); }
  .rchip.on { color: var(--vscode-textLink-foreground); border-color: var(--vscode-textLink-foreground);
              background: color-mix(in srgb, var(--vscode-textLink-foreground) 10%, transparent); }
  .reasons input { box-sizing: border-box; width: 100%; margin-top: 6px; padding: 3px 6px; font: inherit; font-size: 11.5px; border-radius: 3px;
                   color: var(--vscode-input-foreground); background: var(--vscode-input-background);
                   border: 1px solid var(--vscode-input-border, transparent); }
  .thanks { margin-top: 5px; font-size: 11px; color: var(--vscode-testing-iconPassed, #73c991); }
  .thanks .fball { margin-left: 8px; }

  /* 애매한 질문 경고 (검색창 아래) */
  .vague { margin: -2px 0 6px; padding: 5px 8px; font-size: 11.5px; border-radius: 0 4px 4px 0;
           border-left: 3px solid var(--vscode-editorWarning-foreground);
           background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 10%, transparent); }
  .vague .vsub { color: var(--vscode-descriptionForeground); }

  /* AI 키 화면 — 켜져 있으면 검색 화면은 숨긴다 */
  body.keymode #header, body.keymode .content, body.keymode .section, body.keymode #banner, body.keymode #toast { display: none !important; }
  .keyp { padding: 8px 12px 16px; font-size: 12.5px; }
  .kback { font-size: 12px; margin-bottom: 8px; }
  .ktitle { font-size: 13px; font-weight: 600; margin: 4px 0 8px; }
  .kbox { padding: 9px 10px; border-radius: 6px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #8884)); }
  .kstate { display: flex; align-items: center; gap: 7px; }
  .kdot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--vscode-descriptionForeground); }
  .kdot.ok { background: var(--vscode-testing-iconPassed, #73c991); }
  .kdot.err { background: var(--vscode-errorForeground); }
  .kmeta { margin-top: 4px; font-size: 11.5px; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
  .kmeta.err { color: var(--vscode-errorForeground); }
  .kbtns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .sbtn.danger { color: var(--vscode-errorForeground); }
  .ksec { margin: 14px 0 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.03em; color: var(--vscode-descriptionForeground); }
  .ksel, .kin { box-sizing: border-box; width: 100%; margin-bottom: 6px; padding: 4px 7px; font: inherit; font-size: 12px; border-radius: 3px;
                color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  .kin { font-family: var(--vscode-editor-font-family); }
  .ksel:focus, .kin:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .kerr { margin-top: 6px; font-size: 12px; color: var(--vscode-errorForeground); }
  .kradio { display: flex; align-items: flex-start; gap: 6px; margin: 4px 0; cursor: pointer; }
  .kradio small { display: block; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .keyp .anote { margin-top: 12px; }

  /* 다시 볼 만한 코드 */
  .review { margin: 4px 0 10px; }
  .rv-head { display: flex; align-items: center; justify-content: space-between; font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
  .rv { display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px 6px; border: 0; border-radius: 4px; background: transparent; text-align: left; color: var(--vscode-foreground); }
  .rv:hover { background: var(--vscode-list-hoverBackground); }
  .rv-name { font-family: var(--vscode-editor-font-family); font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rv-meta { margin-left: auto; flex: none; font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }

  /* 시연 모드 */
  .demo { margin: 4px 0 10px; padding: 8px 10px; border-radius: 6px; font-size: 12px;
          border: 1px solid color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 40%, transparent);
          background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 5%, transparent); }
  .dm-head { display: flex; align-items: center; gap: 8px; }
  .dm-head .grow { flex: 1; }
  .dm-bar { height: 4px; margin: 6px 0 6px; border-radius: 2px; background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); }
  .dm-bar div { height: 100%; border-radius: 2px; background: var(--vscode-testing-iconPassed, #73c991); }
  .dm-step { display: flex; align-items: flex-start; gap: 8px; padding: 3px 0; }
  .dm-ck { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin-top: 1px; border-radius: 50%; font-size: 10px;
           border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #8886)); color: var(--vscode-descriptionForeground); }
  .dm-step.done .dm-ck { background: var(--vscode-testing-iconPassed, #73c991); border-color: transparent; color: var(--vscode-editor-background, #111); }
  .dm-step.done .dm-tx { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
  .dm-step.now .dm-ck { border-color: var(--vscode-textLink-foreground); color: var(--vscode-textLink-foreground); }
  .dm-step.now .dm-tx > div:first-child { font-weight: 600; }
  .dm-hint { font-size: 11px; color: var(--vscode-descriptionForeground); }

  /* 처음 화면 단축키 안내 */
  .tipcard { margin: 12px 0 8px; padding: 7px 9px; border-radius: 6px; font-size: 12px;
             border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #8884)); }
  .tip-h { margin-bottom: 4px; font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); }
  .tip-r { display: flex; align-items: baseline; gap: 8px; padding: 2px 0; }
  .tip-r kbd { flex: none; min-width: 74px; font-family: inherit; font-size: 10.5px; padding: 0 5px; border-radius: 3px;
               white-space: nowrap; text-align: center; border: 1px solid var(--vscode-widget-border, #8886); border-bottom-width: 2px; }
  .tip-r span { flex: 1; min-width: 0; }
  .aq { margin: 4px 0 6px; font-size: 11px; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
  .abody { margin: 4px 0 8px; font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; }
  .cite { display: inline-block; margin: 0 1px; padding: 0 4px; border: 0; border-radius: 3px; font-size: 10.5px; font-weight: 600; line-height: 1.5;
          vertical-align: 1px; color: var(--vscode-textLink-foreground); background: color-mix(in srgb, var(--vscode-textLink-foreground) 16%, transparent); }
  button.cite:hover { background: color-mix(in srgb, var(--vscode-textLink-foreground) 28%, transparent); }
  .cite.bad { cursor: help; color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 14%, transparent); }
  .anote { margin: 6px 0; padding: 6px 8px; font-size: 12px; border-radius: 0 4px 4px 0;
           border-left: 3px solid var(--vscode-editorWarning-foreground);
           background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 10%, transparent); }
  .anote.bad { border-left-color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent); }
  .asrc-title { margin: 8px 0 2px; font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); }
  .afoot { margin-top: 6px; font-size: 10.5px; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
  .btns.left { justify-content: flex-start; margin-top: 6px; }
  .skel-line { height: 10px; margin: 7px 0; border-radius: 4px; animation: shimmer 1.4s infinite linear; background-size: 200% 100%;
               background-image: linear-gradient(90deg,
                 color-mix(in srgb, var(--vscode-foreground) 6%, transparent) 0%,
                 color-mix(in srgb, var(--vscode-foreground) 13%, transparent) 50%,
                 color-mix(in srgb, var(--vscode-foreground) 6%, transparent) 100%); }
  .card.flash { animation: flash 1.2s ease-out; }
  @keyframes flash { from { background: color-mix(in srgb, var(--vscode-textLink-foreground) 28%, transparent); } to { background: transparent; } }

  .skel { height: 74px; margin-bottom: 6px; border-radius: 6px; animation: shimmer 1.4s infinite linear; background-size: 200% 100%;
          background-image: linear-gradient(90deg,
            color-mix(in srgb, var(--vscode-foreground) 5%, transparent) 0%,
            color-mix(in srgb, var(--vscode-foreground) 11%, transparent) 50%,
            color-mix(in srgb, var(--vscode-foreground) 5%, transparent) 100%); }
  @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

  /* F. 결과 없음 */
  .state { padding: 18px 8px 10px; text-align: center; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .state > svg.i { width: 28px; height: 28px; stroke-width: 1.6; margin-bottom: 6px; }
  .state strong { display: block; margin-bottom: 4px; font-size: 13px; color: var(--vscode-foreground); }
  .btns { display: flex; justify-content: center; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .sbtn { padding: 3px 10px; font-size: 12px; border-radius: 3px; color: var(--vscode-foreground); background: transparent;
          border: 1px solid var(--vscode-button-border, var(--vscode-input-border, #8886)); }
  .sbtn:hover { background: var(--vscode-list-hoverBackground); }
  .sbtn.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: transparent; }
  .sbtn.primary:hover { background: var(--vscode-button-hoverBackground); }

  /* G. 오류 — 연결·서버 문제는 빨강, 시간 초과는 노랑 */
  .error { display: flex; gap: 8px; padding: 8px; font-size: 12px; border-radius: 4px;
           border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
           background: var(--vscode-inputValidation-errorBackground, transparent); }
  .error > svg.i { width: 16px; height: 16px; margin-top: 1px; color: var(--vscode-errorForeground); }
  .error strong { display: block; margin-bottom: 2px; color: var(--vscode-errorForeground); }
  .error .btns { justify-content: flex-start; margin-top: 8px; }
  .error.warn { border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground));
                background: var(--vscode-inputValidation-warningBackground, transparent); }
  .error.warn > svg.i { color: var(--vscode-editorWarning-foreground); }
  .error.warn strong { color: var(--vscode-editorWarning-foreground); }

  /* H. 저장 기록 */
  .section { margin-top: 10px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #8883)); }
  .sec-head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 7px 10px; border: 0; background: transparent; text-align: left;
              font-size: 11px; font-weight: 600; letter-spacing: 0.04em; color: var(--vscode-foreground); }
  .sec-head:hover { background: var(--vscode-list-hoverBackground); }
  .sec-head svg.i { transition: transform 0.12s; }
  .sec-head.open svg.i { transform: rotate(90deg); }
  .sec-head .count { margin-left: auto; font-weight: 400; color: var(--vscode-descriptionForeground); }
  .hist { padding: 0 10px 8px; }
  .hist-tools { display: flex; justify-content: flex-end; margin: -2px 0 4px; }
  .hrow { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 4px; font-size: 12px; cursor: pointer; }
  .hrow:hover { background: var(--vscode-list-hoverBackground); }
  .hrow .fnm { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600;
               font-family: var(--vscode-editor-font-family); }
  .hrow .meta { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px;
                color: var(--vscode-descriptionForeground); }
  .pill { flex: none; padding: 0 5px; border-radius: 3px; font-size: 10.5px; white-space: nowrap; border: 1px solid; }
  .pill.ok { color: var(--vscode-testing-iconPassed, #73c991); border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 50%, transparent); }
  .pill.mock { color: var(--vscode-editorWarning-foreground); border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground) 50%, transparent); }
  .pill.fail { color: var(--vscode-errorForeground); border-color: color-mix(in srgb, var(--vscode-errorForeground) 50%, transparent); }
  .hist-empty { padding: 4px 6px; font-size: 12px; color: var(--vscode-descriptionForeground); }

  /* 패널 안 알림 */
  .toast { position: fixed; left: 8px; right: 8px; bottom: 8px; z-index: 20; display: flex; align-items: center; gap: 8px; padding: 7px 9px;
           font-size: 12px; border-radius: 5px; color: var(--vscode-notifications-foreground, var(--vscode-foreground));
           background: var(--vscode-notifications-background, var(--vscode-editorWidget-background));
           border: 1px solid var(--vscode-notifications-border, var(--vscode-widget-border, #8884));
           box-shadow: 0 6px 16px var(--vscode-widget-shadow, #0009); }
  .toast .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .toast.ok > svg.i, .toast.copy > svg.i { color: var(--vscode-testing-iconPassed, #73c991); }
  .toast.mock > svg.i { color: var(--vscode-editorWarning-foreground); }
  .toast.fail > svg.i { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
  <div id="banner" class="banner" hidden><b>MOCK</b><span>서버를 부르지 않아요. 샘플 결과만 나옵니다.</span></div>

  <section id="keyPanel" class="keyp" hidden></section>

  <div id="header" class="header">
    <form id="form" class="search">
      <svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <svg class="ai-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/></svg>
      <input id="q" placeholder="찾고 싶은 코드를 말로 설명해 보세요 · 끝에 ? 면 AI 질문" />
      <button id="go" class="go" type="submit">검색</button>
      <div id="recent" class="recent" hidden></div>
    </form>
    <div id="frow" class="frow">
      <span class="flbl">범위</span>
      <button id="fProject" class="fchip" type="button"></button>
      <button id="fLanguage" class="fchip" type="button"></button>
      <button id="fClear" class="link-btn fclear" type="button" hidden>모두 해제</button>
      <div id="fmenu" class="fmenu" hidden></div>
    </div>
    <div id="vague" class="vague" hidden></div>
    <div id="askHint" class="askhint-bar" hidden title="Ctrl+Enter 는 항상 AI 질문 · Shift+Enter 는 항상 일반 검색">
      <span>끝에 <b>?</b> 를 붙이면 AI에게 물어봐요</span>
      <button id="askHintClose" class="link-btn" type="button">알겠어요</button>
    </div>
    <div id="bar" class="bar" hidden>
      <span id="summary" class="grow"></span>
      <span id="tools" class="tools" hidden>
        <span class="seg"><button id="vFull" type="button">자세히</button><button id="vCompact" type="button">간단히</button></span>
        <button id="copyRecord" class="ibtn" type="button" title="기록 복사 — 질문·범위·순위·id·위치·유사도를 표로"></button>
        <button id="clearResults" class="ibtn" type="button" title="결과 지우기"></button>
      </span>
    </div>
    <div id="fwarn" class="anote fwarn" hidden></div>
  </div>

  <div class="content">
    <div id="demo" class="demo" hidden></div>
    <div id="intro">
      <div id="review" class="review" hidden></div>
      <div class="intro">검색 예시 — 저장된 코드 찾기</div>
      <div id="chips" class="chips">
        <button type="button" class="chip" data-kind="search">두 숫자를 더하는 함수</button>
        <button type="button" class="chip" data-kind="search">리스트에서 짝수만 고르기</button>
        <button type="button" class="chip" data-kind="search">나이순으로 정렬</button>
      </div>
      <div class="intro">질문 예시 — 끝에 ? 를 붙이면 AI 답변</div>
      <div id="chipsAsk" class="chips">
        <button type="button" class="chip ask" data-kind="ask">add 함수는 뭘 반환해?</button>
        <button type="button" class="chip ask" data-kind="ask">짝수만 고르는 코드는 어떻게 동작해?</button>
      </div>
      <div class="tipcard">
        <div class="tip-h">이렇게도 쓸 수 있어요</div>
        <div class="tip-r"><kbd>Ctrl+Alt+S</kbd><span>커서가 있는 함수 저장</span></div>
        <div class="tip-r"><kbd>Ctrl+Alt+A</kbd><span>선택한 코드로 AI에게 묻기</span></div>
        <div class="tip-r"><kbd>함수 위 글자</kbd><span>💾 저장 · ✦ 묻기 · 🔍 비슷한 코드</span></div>
        <div class="tip-r"><kbd>Ctrl+Alt+F</kbd><span>어디서든 검색창으로</span></div>
        <div class="tip-r"><kbd>상태 표시줄</kbd><span>Code Memory 를 누르면 전체 메뉴</span></div>
      </div>
      <button id="walk" class="link-btn" type="button">처음이면 시작하기 안내 보기</button>
    </div>
    <section id="answer" class="answer" hidden></section>
    <div id="suggest" class="suggest" hidden></div>
    <div id="list"></div>
  </div>

  <div class="section">
    <button id="histHead" class="sec-head" type="button"></button>
    <div id="histBody" class="hist" hidden></div>
  </div>

  <div id="toast" class="toast" hidden></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const byId = function (id) { return document.getElementById(id); };
  const form = byId('form'), input = byId('q'), goBtn = byId('go'), recentBox = byId('recent');
  const header = byId('header'), bar = byId('bar'), summary = byId('summary'), tools = byId('tools');
  const vFull = byId('vFull'), vCompact = byId('vCompact'), copyRecordBtn = byId('copyRecord'), clearBtn = byId('clearResults');
  const intro = byId('intro'), chips = byId('chips'), list = byId('list'), banner = byId('banner');
  const histHead = byId('histHead'), histBody = byId('histBody'), toast = byId('toast');
  const answerBox = byId('answer'), suggestBox = byId('suggest'), askHint = byId('askHint');

  // 검색인지 AI 질문인지 고르는 규칙 — logic.ts 의 함수를 그대로 가져와서 단위 테스트와 같은 코드를 쓴다
  const endsWithQuestionMark = ${endsWithQuestionMark.toString()};
  const looksLikeQuestion = ${looksLikeQuestion.toString()};
  const isVagueQuestion = ${isVagueQuestion.toString()};
  const answerToMarkdown = ${answerToMarkdown.toString()};

  const MAX_LINES = 6;   // 이보다 긴 코드는 접어서 보여준다
  // 문법 색에 쓰는 키워드 (언어 공통으로 대충 모은 것)
  const KEYWORDS = new Set(['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'is', 'not', 'and', 'or',
    'import', 'from', 'as', 'with', 'try', 'except', 'finally', 'raise', 'lambda', 'yield', 'pass', 'break', 'continue',
    'global', 'nonlocal', 'assert', 'del', 'function', 'const', 'let', 'var', 'new', 'async', 'await', 'catch', 'throw',
    'throws', 'switch', 'case', 'default', 'export', 'extends', 'implements', 'public', 'private', 'protected', 'static',
    'final', 'abstract', 'override', 'void', 'interface', 'enum', 'struct', 'trait', 'type', 'typeof', 'instanceof', 'delete',
    'of', 'do', 'package', 'fn', 'fun', 'func', 'val', 'impl', 'pub', 'use', 'mod', 'match', 'where', 'defer', 'go', 'chan',
    'using', 'namespace', 'template', 'typename', 'sizeof', 'goto', 'readonly', 'declare', 'module', 'require']);
  // E. 언어 색 (GitHub 언어 색 기준). 없으면 회색
  const LANG_COLORS = { python: '#3572A5', typescript: '#3178c6', typescriptreact: '#3178c6', javascript: '#f1e05a',
    javascriptreact: '#f1e05a', java: '#b07219', c: '#555555', cpp: '#f34b7d', csharp: '#178600', go: '#00ADD8', rust: '#dea584',
    ruby: '#701516', php: '#4F5D95', kotlin: '#A97BFF', swift: '#F05138', html: '#e34c26', css: '#563d7c', scss: '#c6538c',
    shellscript: '#89e051', sql: '#e38c00', json: '#8a8a8a', markdown: '#083fa1', vue: '#41b883', dart: '#00B4AB' };
  const ICONS = {
    open: ['M14 3h7v7', 'M10 14L21 3', 'M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5'],
    insert: ['M12 5v14', 'M5 12h14'],
    spark: ['M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z', 'M19 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z'],
    copy: ['M11 9h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z', 'M5 15V5a2 2 0 0 1 2-2h10'],
    record: ['M9 3h6v4H9z', 'M7 5H5v16h14V5h-2', 'M8 12h8', 'M8 16h5'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    chev: ['M9 6l6 6-6 6'],
    empty: ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z', 'M20 20l-3.5-3.5', 'M8 11h6'],
    alert: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M12 7v6', 'M12 16.5v.5'],
    clock: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M12 7v5l3 2'],
    check: ['M5 12l5 5L20 7'],
    diff: ['M4 4h6v16H4z', 'M14 4h6v16h-6z'],
    up: ['M7 11v9H4v-9z', 'M7 11l4-8a2 2 0 0 1 3 2l-1 5h6a2 2 0 0 1 2 2.3l-1.3 6.6A2 2 0 0 1 17.7 21H7'],
    down: ['M17 13V4h3v9z', 'M17 13l-4 8a2 2 0 0 1-3-2l1-5H5a2 2 0 0 1-2-2.3l1.3-6.6A2 2 0 0 1 6.3 3H17'],
    redo: ['M21 12a9 9 0 1 1-3-6.7L21 8', 'M21 3v5h-5'],
    folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
    code: ['M8 7l-5 5 5 5', 'M16 7l5 5-5 5'],
    chevdown: ['M6 9l6 6 6-6'],
  };

  // ── 상태
  let searching = false;     // 검색 응답을 기다리는 중이면 또 보내지 않는다
  let lastQuery = '';        // 다시 시도용
  let current = null;        // { query, results, restored } — results 에 원래 순위(rank)를 붙여 둔다
  let mode = { mock: true, apiUrl: '' };
  let prefs = { view: 'full', historyOpen: false, askHintSeen: false };
  let recentItems = [];
  let activeIdx = -1;        // 키보드 ↑↓ 로 고른 최근 검색어 위치
  let historyItems = [];
  let toastTimer = 0;

  // 고정 아이콘 채우기
  copyRecordBtn.append(icon('record'));   // 좁은 패널에서 요약줄과 안 겹치게 아이콘만 (설명은 마우스 올리면)
  clearBtn.append(icon('close'));
  vFull.classList.add('on');

  function setSearching(on) {
    searching = on;
    updateMode();
  }

  // 지금 Enter 를 누르면 AI 질문인지 (끝에 ? + 설정 켜짐)
  function willAsk(v) {
    return mode.askOnQuestionMark !== false && endsWithQuestionMark(String(v || '').trim());
  }

  // 입력하는 중에 모드가 보이게: 아이콘·버튼 글자·테두리 색
  function updateMode() {
    const ai = willAsk(input.value);
    form.classList.toggle('ai', ai);
    goBtn.textContent = ai ? '✦ 묻기' : '검색';
    goBtn.title = ai ? '끝에 ? 가 있어서 AI에게 묻습니다 (Shift+Enter 는 일반 검색)' : '일반 검색 (Ctrl+Enter 는 AI 질문)';
    goBtn.disabled = ai ? asking : searching;
  }

  function hideSuggest() { suggestBox.hidden = true; suggestBox.replaceChildren(); }

  // 보낸 뒤 검색창 비우기 — 다시 쓰려면 검색창을 눌러 최근 기록에서 고르면 된다
  function clearInput() {
    input.value = '';
    updateMode();
  }
  // 요약줄: [검색어(길면 …)] · [개수] — 개수는 잘리지 않게
  function setSummary(query, countText, title, scope) {
    summary.replaceChildren();
    if (query) {
      summary.append(el('span', 'sq', query), el('span', 'sdot', '·'));
    }
    summary.append(el('span', 'sc', countText));
    if (scope) {
      summary.append(el('span', 'sdot', '·'), el('span', scope.warn ? 'scope warn' : 'scope', scope.text));
      summary.title += (summary.title ? ' · ' : '') + '범위: ' + scopeLabel(sfilter);
    }
    summary.title = (query ? '검색어: ' + query + (title ? ' · ' : '') : '') + (title || '');
  }

  // ? 없이 질문처럼 생긴 검색어 → 결과 위에 "AI에게 물어볼까요?" (누를 때만 질문)
  function showSuggest(q) {
    if (!looksLikeQuestion(q)) { hideSuggest(); return; }
    const b = el('button', '');
    b.type = 'button';
    b.append(icon('spark'), el('span', 'grow', '질문처럼 보여요 — AI에게 물어볼까요?'), el('span', 'kbd', 'Ctrl+Enter'));
    b.addEventListener('click', function () { input.value = q; ask(q); });
    suggestBox.replaceChildren(b);
    suggestBox.hidden = false;
  }

  function updateAskHint() {
    askHint.hidden = !!prefs.askHintSeen || mode.askOnQuestionMark === false;
  }
  byId('askHintClose').addEventListener('click', function () {
    prefs.askHintSeen = true;
    vscode.postMessage({ type: 'prefs', prefs: prefs });
    updateAskHint();
  });

  // opts.force: 범위를 바꿔서 다시 검색할 때 — 검색 중이어도 보낸다 (이전 응답은 번호로 버림)
  function search(query, opts) {
    opts = opts || {};
    if (!query || (searching && !opts.force)) { return; }
    closeFilterMenu();
    closeRecent();
    hideSuggest();
    // 이전 AI 답변은 지우지 않고 한 줄로 접는다 — 새 검색 결과를 가리지 않게 (생성 중이면 그대로 둔다)
    if (!answerBox.hidden && !asking) { answerBox.classList.add('collapsed'); }
    lastQuery = query;
    clearInput();
    setSearching(true);
    intro.hidden = true;
    bar.hidden = false;
    tools.hidden = true;
    fWarn.hidden = true;
    setSummary(query, '검색 중…', '', filterOn(sfilter) ? { text: '범위 적용' } : null);
    list.replaceChildren(el('div', 'skel'), el('div', 'skel'));
    searchSeq += 1;
    vscode.postMessage({ type: 'search', query: query, reqId: searchSeq, filter: sfilter });
  }

  // Enter / 버튼: 끝에 ? 면 AI 질문, 아니면 일반 검색
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    const q = input.value.trim();
    if (willAsk(q)) { ask(q, { checkVague: true }); } else { search(q); }
  });
  // Ctrl+Enter = 항상 AI 질문, Shift+Enter = 항상 일반 검색 (끝에 ? 가 있어도)
  input.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') { return; }
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); e.stopImmediatePropagation(); ask(input.value.trim(), { checkVague: true }); }
    else if (e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); search(input.value.trim()); }
  });
  input.addEventListener('input', updateMode);

  // 예시 → 검색창에 넣고 바로 실행 (검색 예시는 검색, 질문 예시는 AI)
  [chips, byId('chipsAsk')].forEach(function (group) {
    group.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        input.value = b.textContent;
        updateMode();
        if (b.dataset.kind === 'ask') { ask(b.textContent); } else { search(b.textContent); }
      });
    });
  });

  byId('walk').addEventListener('click', function () { vscode.postMessage({ type: 'walkthrough' }); });

  // A. 스크롤하면 고정 영역 아래에 그림자
  window.addEventListener('scroll', function () {
    header.classList.toggle('shadow', window.scrollY > 0);
  });

  // ── 최근 검색어: 검색창을 누르면 아래로 펼쳐진다. ↑↓ 로 고르고 Enter, Esc 로 닫기
  function renderRecent() {
    recentBox.replaceChildren();
    if (!recentItems.length) { recentBox.hidden = true; return; }
    const head = el('div', 'recent-head');
    const clear = el('button', 'link-btn', '지우기');
    clear.type = 'button';
    clear.addEventListener('mousedown', function (e) { e.preventDefault(); vscode.postMessage({ type: 'clearRecent' }); });
    head.append(el('span', '', '최근 검색'), clear);
    recentBox.append(head);
    recentItems.forEach(function (r, idx) {
      const item = el('div', idx === activeIdx ? 'recent-item active' : 'recent-item');
      if (r.ai) { item.append(el('span', 'rtag', '✦')); }
      item.append(el('span', 'rq', r.q));
      if (r.cached) { item.append(el('span', 'rcached', '답변 저장됨')); }
      item.title = r.cached ? '저장된 답변 바로 보기 (AI를 다시 부르지 않음)' : r.ai ? 'AI 질문으로 다시 묻기' : '다시 검색';
      // mousedown: 검색창 blur(닫힘)보다 먼저 처리되게
      item.addEventListener('mousedown', function (e) { e.preventDefault(); pickRecent(r); });
      recentBox.append(item);
    });
  }
  function openRecent() {
    if (!recentItems.length) { return; }
    activeIdx = -1;
    renderRecent();
    recentBox.hidden = false;
  }
  function closeRecent() {
    recentBox.hidden = true;
    activeIdx = -1;
  }
  function pickRecent(r) {
    input.value = r.q;
    closeRecent();
    updateMode();
    if (r.ai) { ask(r.q); } else { search(r.q); }
  }
  input.addEventListener('focus', openRecent);
  input.addEventListener('blur', closeRecent);
  input.addEventListener('input', closeRecent);   // 새로 타이핑하면 닫는다
  input.addEventListener('keydown', function (e) {
    if (recentBox.hidden) {
      // 결과가 있으면 ↓ 로 첫 카드로, 없으면 최근 검색어 펼치기
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!focusCard(0)) { openRecent(); } }
      return;
    }
    if (e.key === 'ArrowDown' && activeIdx === recentItems.length - 1) {
      // 최근 검색어 맨 아래에서 ↓ → 결과 카드로
      if (list.querySelector('.card')) { e.preventDefault(); closeRecent(); focusCard(0); }
    }
    else if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, recentItems.length - 1); renderRecent(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, -1); renderRecent(); }
    else if (e.key === 'Enter' && activeIdx >= 0) { e.preventDefault(); pickRecent(recentItems[activeIdx]); }
    else if (e.key === 'Escape') { e.preventDefault(); closeRecent(); }
  });

  // ── C. 자세히 / 간단히
  function setView(v) {
    prefs.view = v;
    vFull.classList.toggle('on', v === 'full');
    vCompact.classList.toggle('on', v === 'compact');
    vscode.postMessage({ type: 'prefs', prefs: prefs });
    if (current) { renderResults(); }
  }
  vFull.addEventListener('click', function () { setView('full'); });
  vCompact.addEventListener('click', function () { setView('compact'); });

  // ── 필터

  // ── B. 기록 복사: 9쪽 "현장에서 적을 실제 결과"에 붙여넣을 마크다운 표
  copyRecordBtn.addEventListener('click', function () {
    if (!current) { return; }
    const now = new Date();
    const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
    const rows = visibleResults();
    const lines = [
      '질문: ' + current.query,
      '모드: ' + (mode.mock ? 'mock (서버 호출 안 함)' : '실제 서버 ' + mode.apiUrl) + ' · ' + stamp,
    ];
    if (filterOn(current.filter)) {
      lines.push('범위: ' + scopeLabel(current.filter) + (current.check === 'ignored' ? ' (서버 미적용 — 화면에서만 거름)' : ' (서버에서 거름)'));
    }
    lines.push('', '| 순위 | id | 함수 | 위치 | 유사도 |', '|---|---|---|---|---|');
    rows.forEach(function (r) {
      lines.push('| ' + r.rank + ' | ' + r.id + ' | ' + (r.function_name || '-') + ' | ' + r.file_path + ':' + r.start_line + '-' + r.end_line +
        ' | ' + (typeof r.score === 'number' ? r.score.toFixed(3) : '-') + ' |');
    });
    vscode.postMessage({ type: 'copyText', text: lines.join('\\n') });
    copyRecordBtn.replaceChildren(icon('check'));
    copyRecordBtn.classList.add('done');
    setTimeout(function () { copyRecordBtn.replaceChildren(icon('record')); copyRecordBtn.classList.remove('done'); }, 1500);
  });

  // ── 결과 지우기 → 처음 화면으로
  clearBtn.addEventListener('click', function () {
    current = null;
    list.replaceChildren();
    bar.hidden = true;
    fWarn.hidden = true;
    intro.hidden = false;
    input.value = '';
    input.focus();
    vscode.postMessage({ type: 'clearLast' });
  });

  // ── 확장 본체 → 웹페이지
  window.addEventListener('message', function (event) {
    const msg = event.data;
    switch (msg.type) {
      case 'config':
        mode = { mock: !!msg.mock, apiUrl: msg.apiUrl || '', askTimeout: msg.askTimeout || 45, askOnQuestionMark: msg.askOnQuestionMark !== false,
          reviewAfterDays: typeof msg.reviewAfterDays === 'number' ? msg.reviewAfterDays : 7 };
        renderReview();
        banner.hidden = !msg.mock;
        updateMode();
        updateAskHint();
        break;
      case 'prefs':
        prefs = Object.assign({ view: 'full', historyOpen: false, askHintSeen: false }, msg.prefs || {});
        sfilter = normFilter(prefs.filter);
        renderChips();
        renderReview();
        renderDemo();
        updateAskHint();
        vFull.classList.toggle('on', prefs.view === 'full');
        vCompact.classList.toggle('on', prefs.view === 'compact');
        renderHistory();
        if (current) { renderResults(); }
        break;
      case 'recent':
        recentItems = (msg.items || []).map(function (r) { return typeof r === 'string' ? { q: r, ai: false } : r; });
        if (!recentBox.hidden) { renderRecent(); }
        break;
      case 'history':
        historyItems = msg.items || [];
        renderHistory();
        renderReview();
        break;
      case 'saved':
        showToast(msg.record);
        if (msg.record && msg.record.status !== 'fail') { demoDone('save'); if (msg.record.masked) { demoDone('secret'); } }
        break;
      case 'demo':
        setDemo(msg.on === undefined ? !(prefs.demo && prefs.demo.on) : !!msg.on);
        break;
      case 'runSearch':
        input.value = msg.query;
        updateMode();
        search(msg.query);
        break;
      case 'focus':
        input.focus();
        input.select();
        break;
      case 'restore':
        lastQuery = msg.query;
        setResults(msg.query, msg.results, true, msg.filter, msg.check);
        break;
      case 'sourceLocationsChanged': {
        const rows = (current ? current.results : []).concat(currentAnswer ? currentAnswer.r.sources : []);
        if (rows.length) { vscode.postMessage({ type: 'refreshLocal', results: rows }); }
        break;
      }
      case 'localStatus': {
        const updated = msg.results || [];
        const patch = function (row) {
          const found = updated.find(function (item) {
            return item.id === row.id && item.project_name === row.project_name && item.file_path === row.file_path
              && item.code === row.code && item.start_line === row.start_line && item.end_line === row.end_line;
          });
          return found ? Object.assign({}, row, { local: found.local, source: found.source, moved_start: found.moved_start, moved_end: found.moved_end }) : row;
        };
        if (current) { current.results = current.results.map(patch); renderResults(); }
        if (currentAnswer && !asking) {
          currentAnswer.r.sources = currentAnswer.r.sources.map(patch);
          answerBox.querySelectorAll('.card[data-cite]').forEach(function (old, index) {
            const source = currentAnswer.r.sources.find(function (item) { return item.citation_id === old.dataset.cite; });
            if (source) {
              const replacement = card(Object.assign({ rank: source.citation_id }, source), index);
              replacement.dataset.cite = source.citation_id;
              old.replaceWith(replacement);
            }
          });
        }
        break;
      }
      case 'results':
        if (msg.reqId !== undefined && msg.reqId !== searchSeq) { break; }   // 범위를 바꾸기 전에 보낸 검색의 응답은 버린다
        setSearching(false);
        if (msg.query) { lastQuery = msg.query; }
        setResults(lastQuery, msg.results, false, msg.filter, msg.check);
        showSuggest(lastQuery);
        demoDone('search');
        if (filterOn(normFilter(msg.filter))) { demoDone('scope'); }
        break;
      case 'error':
        if (msg.reqId !== undefined && msg.reqId !== searchSeq) { break; }
        setSearching(false);
        showError(msg.title, msg.detail, msg.kind);
        break;
      case 'keyState':
        keyState = msg.state;
        if (msg.show) { showKeyPanel(true); } else if (!keyPanel.hidden) { renderKeyPanel(); }
        break;
      case 'keyError':
        if (!keyPanel.hidden) { keyEditing = true; renderKeyPanel(msg.msg); }
        break;
      case 'filterOptions':
        filterOpts = msg.options || null;
        filterErr = msg.error || '';
        openFolders = msg.openFolders || [];
        if (menuKind) { const fi = fMenu.querySelector('input'); renderFilterMenu(fi ? fi.value : ''); }
        break;
      case 'answer':
        if (msg.reqId !== askSeq) { break; }   // 늦게 온 이전 질문의 답은 버린다
        setAsking(false);
        renderAnswer(msg);
        demoDone('ask');
        break;
      case 'askError':
        if (msg.reqId !== askSeq) { break; }
        setAsking(false);
        renderAskError(msg);
        break;
      case 'askSources':
        if (msg.reqId !== askSeq || !asking) { break; }
        renderStreamSources(msg.sources || []);
        break;
      case 'askDelta':
        if (msg.reqId !== askSeq || !asking) { break; }
        renderStreamDelta(msg.text || '');
        break;
      case 'prefill':
        // "이 코드에 대해 묻기" — 채우기만 하고 보내지는 않는다. 고칠 부분을 선택해 둔다
        input.value = msg.text;
        updateMode();
        hideVague();
        input.focus();
        closeRecent();
        try { input.setSelectionRange(msg.selStart, msg.selEnd); } catch (e) { /* 무시 */ }
        break;
    }
  });

  // ── 사용자 AI 키 화면 (제목줄 🔑) — 키 값은 확장 본체의 비밀 저장소에만. 여기엔 가린 글자만 온다
  const keyPanel = byId('keyPanel');
  const KEY_PROVIDERS = [
    { id: 'openai', label: 'OpenAI', hint: 'sk-…' },
    { id: 'anthropic', label: 'Anthropic (Claude)', hint: 'sk-ant-…' },
    { id: 'google', label: 'Google (Gemini)', hint: 'AIza…' },
  ];
  let keyState = null;
  let keyEditing = false;

  function showKeyPanel(on) {
    document.body.classList.toggle('keymode', on);
    keyPanel.hidden = !on;
    if (on) { renderKeyPanel(); window.scrollTo(0, 0); }
  }
  function renderKeyPanel(errMsg) {
    const s = keyState;
    if (!s) { return; }
    const back = el('button', 'link-btn kback', '← 검색으로');
    back.type = 'button';
    back.addEventListener('click', function () { keyEditing = false; showKeyPanel(false); input.focus(); });
    const parts = [back, el('div', 'ktitle', 'AI 키')];

    // 지금 상태
    const box = el('div', 'kbox');
    const st = el('div', 'kstate');
    const using = s.hasKey && s.useOwn;
    st.append(el('span', 'kdot ' + (using ? (s.last && !s.last.ok ? 'err' : 'ok') : 'off')),
      el('b', '', using ? '내 키 사용 중' : s.hasKey ? '내 키 저장됨 (지금은 서버 기본 키 사용)' : '내 키 없음'));
    box.append(st);
    if (s.hasKey) {
      box.append(el('div', 'kmeta', s.providerLabel + ' · ' + s.masked));
      let line = '저장 ' + new Date(s.savedAt).toLocaleString();
      if (s.last) { line += ' · 마지막 사용 ' + (s.last.ok ? '정상' : '키 오류'); }
      const meta = el('div', 'kmeta', line);
      if (s.last && !s.last.ok) { meta.classList.add('err'); meta.title = s.last.msg || ''; }
      box.append(meta);
      const btns = el('div', 'kbtns');
      btns.append(sbtn('바꾸기', false, function () { keyEditing = true; renderKeyPanel(); }),
        sbtn('지우기', false, function () { vscode.postMessage({ type: 'clearKey' }); }));
      btns.lastChild.classList.add('danger');
      box.append(btns);
    } else {
      box.append(el('div', 'kmeta', '지금은 서버에 설정된 기본 키로 AI 답변을 받아요.'));
    }
    parts.push(box);

    // 입력 칸 (키가 없거나 "바꾸기")
    if (!s.hasKey || keyEditing) {
      parts.push(el('div', 'ksec', s.hasKey ? '새 키로 바꾸기' : '내 AI 키 넣기'));
      const sel = el('select', 'ksel');
      KEY_PROVIDERS.forEach(function (p) { const o = el('option', '', p.label); o.value = p.id; sel.append(o); });
      sel.value = s.provider || 'openai';
      const kin = el('input', 'kin');
      kin.type = 'password';
      kin.autocomplete = 'off';
      kin.spellcheck = false;
      kin.placeholder = hintOf(sel.value);
      const kinfo = el('div', 'kmeta');
      let confirmMismatch = '';   // 키 모양과 다른 회사를 고른 채 저장 → 한 번 묻고, 다시 누르면 저장
      sel.addEventListener('change', function () { kin.placeholder = hintOf(sel.value); confirmMismatch = ''; kinfo.textContent = ''; kinfo.classList.remove('err'); });
      // 키를 붙여넣거나 고칠 때마다 모양으로 회사를 다시 고른다 (그 뒤에 직접 바꾸는 건 된다)
      kin.addEventListener('input', function () {
        confirmMismatch = '';
        kinfo.classList.remove('err');
        const g = guessKeyProvider(kin.value);
        if (g && g !== sel.value) {
          sel.value = g;
          kin.placeholder = hintOf(g);
          kinfo.textContent = '키 모양을 보고 ' + labelOf(g) + ' 로 골랐어요. 아니면 위에서 바꾸세요.';
        } else if (!g) {
          kinfo.textContent = '';
        }
      });
      const save = sbtn('저장', true, function () {
        const g = guessKeyProvider(kin.value);
        if (g && g !== sel.value && confirmMismatch !== kin.value + '|' + sel.value) {
          confirmMismatch = kin.value + '|' + sel.value;
          kinfo.textContent = '이 키는 ' + labelOf(g) + ' 키 모양인데 ' + labelOf(sel.value) + ' 를 골랐어요. 맞으면 저장을 한 번 더 누르세요.';
          kinfo.classList.add('err');
          return;
        }
        vscode.postMessage({ type: 'saveKey', provider: sel.value, key: kin.value });
        kin.value = '';
        keyEditing = false;
      });
      kin.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); save.click(); } });
      const row = el('div', 'kbtns');
      row.append(save);
      if (keyEditing) { row.append(sbtn('취소', false, function () { keyEditing = false; renderKeyPanel(); })); }
      parts.push(sel, kin, kinfo, row);
      if (errMsg) { parts.push(el('div', 'kerr', errMsg)); }
      parts.push(el('div', 'kmeta', '키는 이 PC 의 VS Code 비밀 저장소에만 저장돼요. 설정 파일·Git·이 화면에는 남지 않고, AI 질문을 보낼 때만 서버로 전달돼요.'));
    }

    // 무엇을 쓸지
    if (s.hasKey) {
      parts.push(el('div', 'ksec', 'AI 답변에 쓸 키'));
      [[true, '내 키', '요금은 내 ' + s.providerLabel + ' 계정으로'], [false, '서버 기본 키', '팀 서버의 키 (내 키는 저장만 해둠)']].forEach(function (o) {
        const lab = el('label', 'kradio');
        const r = el('input');
        r.type = 'radio';
        r.name = 'useOwn';
        r.checked = s.useOwn === o[0];
        r.addEventListener('change', function () { vscode.postMessage({ type: 'setUseOwn', useOwn: o[0] }); });
        const tx = el('span', '', o[1]);
        tx.append(el('small', '', o[2]));
        lab.append(r, tx);
        parts.push(lab);
      });
    }

    // 주의
    if (s.mock) {
      parts.push(el('div', 'anote', 'mock 모드에서는 서버를 부르지 않아서 키를 쓰지 않아요. 실제 서버 모드에서 써요.'));
    } else if (s.hasKey && !s.canSend) {
      parts.push(el('div', 'anote', '서버 주소(' + s.apiUrl + ')가 내 PC 도 아니고 https 도 아니라서 키를 보내지 않아요. 키가 암호화 없이 전달될 수 있어요.'));
    }
    keyPanel.replaceChildren.apply(keyPanel, parts);
    const first = keyPanel.querySelector('.kin');
    if (first) { first.focus(); }
  }
  function guessKeyProvider(v) {
    const k = String(v || '').trim();
    return /^sk-ant-/.test(k) ? 'anthropic' : /^AIza/.test(k) ? 'google' : /^sk-/.test(k) ? 'openai' : '';
  }
  function labelOf(id) {
    const p = KEY_PROVIDERS.find(function (x) { return x.id === id; });
    return p ? p.label : id;
  }
  function hintOf(id) {
    const p = KEY_PROVIDERS.find(function (x) { return x.id === id; });
    return (p ? p.hint : '') + '  (붙여넣기)';
  }

  // ── 다시 볼 만한 코드 (처음 화면) — 저장 기록에서 며칠 지났고 아직 다시 안 본 코드 3개. 내 PC 기록만 쓴다
  const reviewBox = byId('review');
  function reviewKey(fn, file) { return (file || '') + '|' + (fn || ''); }
  function markSeen(fn, file) {
    const seen = Object.assign({}, prefs.reviewSeen || {});
    seen[reviewKey(fn, file)] = new Date().toISOString();
    const keys = Object.keys(seen);
    if (keys.length > 200) { keys.sort(function (a, b) { return seen[a] < seen[b] ? -1 : 1; }).slice(0, keys.length - 200).forEach(function (k) { delete seen[k]; }); }
    prefs.reviewSeen = seen;
    vscode.postMessage({ type: 'prefs', prefs: prefs });
    renderReview();
  }
  function reviewCandidates() {
    const days = typeof mode.reviewAfterDays === 'number' ? mode.reviewAfterDays : 7;
    const seen = prefs.reviewSeen || {};
    const now = Date.now();
    const used = {};
    const out = [];
    historyItems.forEach(function (h) {
      if (h.status !== 'ok' && h.status !== 'mock') { return; }
      const k = reviewKey(h.function_name, h.file_path);
      if (used[k]) { return; }   // 같은 함수는 가장 최근 저장 하나만
      used[k] = true;
      const t = new Date(h.time).getTime();
      const age = (now - t) / 86400000;
      if (!(age >= days)) { return; }
      if (seen[k] && new Date(seen[k]).getTime() > t) { return; }   // 저장 뒤에 이미 다시 봤으면 빼기
      out.push({ h: h, age: age });
    });
    out.sort(function (a, b) { return b.age - a.age; });
    return out.slice(0, 3);
  }
  function renderReview() {
    const items = reviewCandidates();
    reviewBox.replaceChildren();
    if (!items.length) { reviewBox.hidden = true; return; }
    reviewBox.hidden = false;
    if (prefs.reviewHidden) {
      const more = el('button', 'link-btn', '다시 볼 만한 코드 ' + items.length + '개 보기');
      more.type = 'button';
      more.addEventListener('click', function () { prefs.reviewHidden = false; vscode.postMessage({ type: 'prefs', prefs: prefs }); renderReview(); });
      reviewBox.append(more);
      return;
    }
    const head = el('div', 'rv-head');
    const hide = el('button', 'link-btn', '숨기기');
    hide.type = 'button';
    hide.addEventListener('click', function () { prefs.reviewHidden = true; vscode.postMessage({ type: 'prefs', prefs: prefs }); renderReview(); });
    head.append(el('span', '', '다시 볼 만한 코드'), hide);
    reviewBox.append(head);
    items.forEach(function (it) {
      const h = it.h;
      const name = h.function_name || String(h.file_path || '').split('/').pop();
      const row = el('button', 'rv');
      row.type = 'button';
      const d = Math.floor(it.age);
      row.append(el('span', 'rv-name', name), el('span', 'rv-meta', String(h.file_path || '').split('/').pop() + ' · ' + (d < 1 ? '오늘' : d + '일 전') + ' 저장'));
      row.title = '"' + name + '" 검색해서 다시 보기';
      row.addEventListener('click', function () { markSeen(h.function_name, h.file_path); search(name); });
      reviewBox.append(row);
    });
  }

  // ── 시연 모드 (학술제용) — 순서 안내, 실제로 그 기능을 쓰면 자동 체크
  const demoBox = byId('demo');
  const DEMO_STEPS = [
    ['save', '코드 저장', '함수 위 💾 저장 또는 Ctrl+Alt+S'],
    ['search', '말로 검색', '예: "두 숫자를 더하는 함수"'],
    ['scope', '범위로 좁히기', '검색창 아래 프로젝트·언어 칩'],
    ['ask', 'AI에게 묻기', '예: "0으로 나누면 뭘 반환해?" — 끝에 ?'],
    ['stale', '원본 바뀜 보여주기', '파일을 고친 뒤 다시 검색 → 바뀐 부분 보기'],
    ['secret', '비밀값 가리고 저장', '키가 든 함수를 저장 → 가리고 저장'],
  ];
  function demoDone(id) {
    if (!prefs.demo || !prefs.demo.on || prefs.demo.done.indexOf(id) >= 0) { return; }
    prefs.demo.done.push(id);
    vscode.postMessage({ type: 'prefs', prefs: prefs });
    renderDemo();
  }
  function setDemo(on) {
    prefs.demo = { on: on, done: on ? [] : ((prefs.demo && prefs.demo.done) || []) };
    vscode.postMessage({ type: 'prefs', prefs: prefs });
    renderDemo();
  }
  function renderDemo() {
    const d = prefs.demo;
    if (!d || !d.on) { demoBox.hidden = true; demoBox.replaceChildren(); return; }
    demoBox.hidden = false;
    const done = DEMO_STEPS.filter(function (s) { return d.done.indexOf(s[0]) >= 0; }).length;
    const head = el('div', 'dm-head');
    const reset = el('button', 'link-btn', '처음부터');
    reset.type = 'button';
    reset.addEventListener('click', function () { setDemo(true); });
    const end = el('button', 'link-btn', '끝내기');
    end.type = 'button';
    end.addEventListener('click', function () { setDemo(false); });
    head.append(el('strong', '', done === DEMO_STEPS.length ? '시연 순서 · 다 했어요' : '시연 순서 · ' + done + ' / ' + DEMO_STEPS.length), el('span', 'grow'), reset, end);
    const bar = el('div', 'dm-bar');
    const fill = el('div');
    fill.style.width = Math.round(done / DEMO_STEPS.length * 100) + '%';
    bar.append(fill);
    demoBox.replaceChildren(head, bar);
    let nowSet = false;
    DEMO_STEPS.forEach(function (s, i) {
      const isDone = d.done.indexOf(s[0]) >= 0;
      const isNow = !isDone && !nowSet;
      if (isNow) { nowSet = true; }
      const row = el('div', 'dm-step' + (isDone ? ' done' : isNow ? ' now' : ''));
      const ck = el('span', 'dm-ck', isDone ? '✓' : String(i + 1));
      const tx = el('div', 'dm-tx');
      tx.append(el('div', '', s[1]));
      if (isNow) { tx.append(el('div', 'dm-hint', s[2])); }
      row.append(ck, tx);
      demoBox.append(row);
    });
  }

  function setResults(query, results, restored, usedFilter, check) {
    current = {
      query: query, restored: restored, filter: normFilter(usedFilter), check: check || 'none',
      results: results.map(function (r, i) { return Object.assign({ rank: i + 1 }, r); }),
    };
    intro.hidden = true;
    bar.hidden = false;
    renderFilterWarn();
    renderResults();
  }

  function visibleResults() {
    return current ? current.results : [];
  }

  // ── 검색 범위 (프로젝트·언어) — 서버에 조건으로 보내서 DB 에서 먼저 거른다 (GET /search?project=&language=)
  //    목록은 GET /filters. 고르면 마지막 검색어로 바로 다시 검색. 늦게 온 이전 결과는 번호(searchSeq)로 버린다
  const fProjectBtn = byId('fProject'), fLanguageBtn = byId('fLanguage'), fClearBtn = byId('fClear');
  const fMenu = byId('fmenu'), fWarn = byId('fwarn'), fRow = byId('frow');
  const FILTER_KINDS = {
    project: { label: '프로젝트', icon: 'folder', btn: fProjectBtn, find: '프로젝트 찾기' },
    language: { label: '언어', icon: 'code', btn: fLanguageBtn, find: '언어 찾기' },
  };
  let sfilter = { project: '', language: '' };   // 지금 고른 범위 (다음 검색에 쓴다)
  let filterOpts = null;                          // GET /filters 결과 { projects, languages } — 없으면 null
  let filterErr = '';
  let openFolders = [];
  let menuKind = '';
  let menuIdx = 0;
  let searchSeq = 0;

  function normFilter(f) {
    return {
      project: f && typeof f.project === 'string' ? f.project.trim() : '',
      language: f && typeof f.language === 'string' ? f.language.trim().toLowerCase() : '',
    };
  }
  function filterOn(f) { return !!(f && (f.project || f.language)); }
  function scopeLabel(f) { return [f.project, f.language].filter(Boolean).join(' · '); }

  function renderChips() {
    Object.keys(FILTER_KINDS).forEach(function (kind) {
      const k = FILTER_KINDS[kind];
      const v = sfilter[kind];
      const b = k.btn;
      b.replaceChildren(icon(k.icon), el('span', 'fk', k.label), el('span', 'fv', v || '전체'));
      if (v) {
        const x = el('span', 'fx');
        x.title = k.label + ' 조건 해제';
        x.append(icon('close'));
        x.addEventListener('click', function (e) { e.stopPropagation(); setFilter(kind, ''); });
        b.append(x);
      } else {
        b.append(icon('chevdown'));
      }
      b.classList.toggle('on', !!v);
      b.classList.toggle('open', menuKind === kind);
      b.title = v ? k.label + ': ' + v + ' 에서만 검색 (눌러서 바꾸기)' : k.label + ' 전체에서 검색 (눌러서 고르기)';
    });
    fClearBtn.hidden = !filterOn(sfilter);
  }

  function setFilter(kind, value) {
    sfilter = normFilter(Object.assign({}, sfilter, { [kind]: value }));
    prefs.filter = sfilter;
    vscode.postMessage({ type: 'prefs', prefs: prefs });
    closeFilterMenu();
    renderChips();
    if (lastQuery) { search(lastQuery, { force: true }); }   // 바꾼 범위로 바로 다시 검색
  }
  fClearBtn.addEventListener('click', function () {
    sfilter = { project: '', language: '' };
    prefs.filter = sfilter;
    vscode.postMessage({ type: 'prefs', prefs: prefs });
    renderChips();
    if (lastQuery) { search(lastQuery, { force: true }); }
  });

  function optionsOf(kind) {
    if (!filterOpts) { return []; }
    const list = (kind === 'project' ? filterOpts.projects : filterOpts.languages) || [];
    const items = list.map(function (o) { return { name: o.name, count: o.count, open: kind === 'project' && openFolders.indexOf(o.name) >= 0 }; });
    // 지금 열린 폴더는 맨 위로
    items.sort(function (a, b) { return (b.open ? 1 : 0) - (a.open ? 1 : 0); });
    return items;
  }

  function openFilterMenu(kind) {
    if (menuKind === kind) { closeFilterMenu(); return; }
    menuKind = kind;
    menuIdx = 0;
    vscode.postMessage({ type: 'loadFilters' });   // 열 때마다 최신 목록
    renderFilterMenu('');
    renderChips();
    const finput = fMenu.querySelector('input');
    if (finput) { finput.focus(); }
  }
  function closeFilterMenu() {
    if (!menuKind) { return; }
    menuKind = '';
    fMenu.hidden = true;
    fMenu.replaceChildren();
    renderChips();
  }
  fProjectBtn.addEventListener('click', function () { openFilterMenu('project'); });
  fLanguageBtn.addEventListener('click', function () { openFilterMenu('language'); });
  document.addEventListener('mousedown', function (e) {
    if (menuKind && !fRow.contains(e.target)) { closeFilterMenu(); }
  });

  // 목록: 전체 + DB 목록(찾기 칸으로 거름) + 목록에 없으면 "직접 입력"
  function renderFilterMenu(typed) {
    const k = FILTER_KINDS[menuKind];
    if (!k) { return; }
    let finput = fMenu.querySelector('input');
    if (!finput) {
      finput = el('input');
      finput.placeholder = k.find;
      finput.maxLength = 200;
      finput.addEventListener('input', function () { menuIdx = 0; renderFilterMenu(finput.value); });
      finput.addEventListener('keydown', function (e) {
        const rows = fMenu.querySelectorAll('.fit');
        if (e.key === 'ArrowDown') { e.preventDefault(); menuIdx = Math.min(menuIdx + 1, rows.length - 1); paintMenuIdx(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); menuIdx = Math.max(menuIdx - 1, 0); paintMenuIdx(); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          if (e.isComposing) { return; }   // 한글 조합 중 Enter 는 글자 확정만
          if (rows[menuIdx]) { const b = k.btn; rows[menuIdx].click(); b.focus(); }
        }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const b = k.btn; closeFilterMenu(); b.focus(); }
      });
      fMenu.replaceChildren(finput);
    }
    while (finput.nextSibling) { finput.nextSibling.remove(); }

    const q = String(typed || '').trim();
    const cur = sfilter[menuKind];
    const add = function (label, value, opt) {
      const row = el('div', 'fit');
      row.append(el('span', 'fchk', value === cur ? '✓' : ''), el('span', 'fname', label));
      if (opt && opt.open) { row.append(el('span', 'ftag', '열린 폴더')); }
      if (opt && typeof opt.count === 'number') { row.append(el('span', 'fcount', String(opt.count))); }
      row.addEventListener('mousedown', function (e) { e.preventDefault(); });
      row.addEventListener('click', function () { setFilter(menuKind, value); });
      fMenu.append(row);
    };

    if (!q) {
      add('전체', '', null);
      fMenu.append(el('hr'));
    }
    const all = optionsOf(menuKind);
    const lower = q.toLowerCase();
    const shown = all.filter(function (o) { return !q || o.name.toLowerCase().indexOf(lower) >= 0; });
    shown.forEach(function (o) { add(o.name, o.name, o); });
    const exact = all.some(function (o) { return o.name === q || (menuKind === 'language' && o.name.toLowerCase() === lower); });
    if (q && !exact) {
      add('"' + q + '" 직접 입력', q, null);
    }
    let foot = '';
    if (filterErr) { foot = filterErr + ' · 이름을 직접 입력할 수 있어요'; }
    else if (!filterOpts) { foot = '목록 불러오는 중…'; }
    else if (!all.length) { foot = 'DB 에 저장된 ' + k.label + '가 없어요'; }
    else { foot = 'DB 에 저장된 ' + k.label + ' · 숫자는 코드 수' + (mode.mock ? ' (mock 예시)' : ''); }
    fMenu.append(el('hr'), el('div', filterErr ? 'ffoot err' : 'ffoot', foot));

    fMenu.style.left = k.btn.offsetLeft + 'px';
    fMenu.hidden = false;
    paintMenuIdx();
  }
  function paintMenuIdx() {
    fMenu.querySelectorAll('.fit').forEach(function (r, i) { r.classList.toggle('hl', i === menuIdx); });
  }

  // 결과 위 경고: 서버가 조건을 적용하지 않았을 때
  function renderFilterWarn() {
    const ignored = !!current && current.check === 'ignored';
    fWarn.hidden = !ignored;
    if (ignored) {
      fWarn.replaceChildren(el('b', '', '서버가 범위 조건을 적용하지 않았어요'),
        document.createTextNode(' — 응답에 적용한 조건(filters)이 없어서, 전체 검색 결과를 화면에서만 걸렀어요. Backend 버전을 확인하세요.'));
    }
  }

  function renderResults() {
    list.replaceChildren();
    const scoped = filterOn(current.filter);
    const scope = scoped
      ? (current.check === 'ignored' ? { text: '화면에서만 거름', warn: true } : { text: '범위 적용' })
      : null;
    if (!current.results.length) {
      tools.hidden = true;
      setSummary(current.query, current.restored ? '지난 검색 · 0개' : '0개', '', scope);
      list.append(scoped ? scopedEmptyState(current.filter) : emptyState());
      return;
    }
    tools.hidden = false;
    const rows = visibleResults();
    let text = rows.length + '개';
    // mock 결과는 검색어와 상관없는 샘플 — 짧게, 자세한 설명은 마우스 올리면
    if (mode.mock) { text = 'mock ' + text; }
    setSummary(current.query, text,
      (current.restored ? '지난 검색 결과입니다. ' : '') + (mode.mock ? 'mock 모드라서 검색어와 상관없이 같은 샘플이 나옵니다' : ''), scope);

    rows.forEach(function (r, i) {
      if (prefs.view === 'compact') {
        list.append(compactRow(r, i));
      } else {
        if (i > 0) { list.append(el('div', 'divider')); }
        list.append(card(r, i));
      }
    });
  }

  // F-2. 범위 때문에 결과 없음 — 조건을 풀어서 바로 다시
  function scopedEmptyState(f) {
    const s = el('div', 'state');
    s.append(icon('empty'), el('strong', '', '이 범위에는 결과가 없어요'),
      el('div', '', scopeLabel(f) + ' 에 맞는 코드가 없거나, 아직 검색 준비가 안 됐어요.'));
    const btns = el('div', 'btns');
    btns.append(sbtn('조건 풀고 전체에서 검색', true, function () { fClearBtn.click(); }));
    if (f.project && f.language) {
      btns.append(sbtn('언어만 풀기', false, function () { setFilter('language', ''); }));
      btns.append(sbtn('프로젝트만 풀기', false, function () { setFilter('project', ''); }));
    }
    s.append(btns);
    return s;
  }

  // F. 결과 없음
  function emptyState() {
    const s = el('div', 'state');
    s.append(icon('empty'), el('strong', '', '결과가 없습니다'),
      el('div', '', '벡터가 준비된 스니펫만 검색돼요.'),
      el('div', '', '방금 저장했다면 저장 알림을 확인하세요.'));
    const btns = el('div', 'btns');
    btns.append(
      sbtn('다른 말로 검색', false, function () { input.value = lastQuery; updateMode(); input.focus(); input.select(); }),
      sbtn('모드 바꾸기', false, function () { vscode.postMessage({ type: 'switchMode' }); })
    );
    s.append(btns);
    return s;
  }

  // G. 오류 — 아이콘 + 다시 시도
  function showError(title, detail, kind) {
    current = null;
    tools.hidden = true;
    fWarn.hidden = true;
    summary.textContent = '';
    const warn = kind === 'timeout';
    const box = el('div', warn ? 'error warn' : 'error');
    const text = el('div');
    text.append(el('strong', '', title), el('div', '', detail || ''));
    const btns = el('div', 'btns');
    btns.append(sbtn('다시 시도', true, function () { search(lastQuery); }));
    if (kind === 'connect' || kind === 'server') {
      btns.append(sbtn('모드 바꾸기', false, function () { vscode.postMessage({ type: 'switchMode' }); }));
    }
    text.append(btns);
    box.append(icon(warn ? 'clock' : 'alert'), text);
    list.replaceChildren(box);
  }

  // ── 카드 공통: 원본을 열 수 있는지, 위치 글자
  function locInfo(r) {
    const range = r.start_line === r.end_line ? String(r.start_line) : r.start_line + '–' + r.end_line;
    const canOpen = r.local !== 'no_folder' && r.local !== 'missing';
    const why = r.local === 'no_folder'
      ? '이 PC의 원본 프로젝트 위치를 한 번 연결하세요. 이후에는 프로젝트를 닫아도 열 수 있습니다.'
      : '기억한 위치에 파일이 없습니다. 옮긴 프로젝트 위치를 다시 연결할 수 있습니다.';
    if (r.source === 'moved' && r.moved_start) {
      const nr = r.moved_start === r.moved_end ? String(r.moved_start) : r.moved_start + '–' + r.moved_end;
      return { where: nr + '줄', oldWhere: r.file_path + ' : ' + range, canOpen: canOpen, why: why };
    }
    return { where: r.file_path + ' : ' + range, canOpen: canOpen, why: why };
  }

  function srcTag(kind, text, title) {
    const s = el('span', 'stag ' + kind, text);
    s.title = title;
    return s;
  }

  function langDot(lang) {
    const d = el('span', 'dot');
    const c = LANG_COLORS[lang];
    if (c) { d.style.background = c; }
    d.title = lang;
    return d;
  }

  function simEl(r) {
    if (typeof r.score !== 'number') { return el('span', 'sim'); }
    // 코사인 유사도(-1~1)를 소수점으로 표시한다. 정답 확률이나 정확도 퍼센트가 아니다.
    const sim = el('span', 'sim', prefs.view === 'compact' ? '' : '유사도 ');
    sim.append(el('b', '', r.score.toFixed(3)));
    sim.title = '코사인 유사도 (-1~1, 클수록 비슷함). 정확도 퍼센트가 아닙니다';
    return sim;
  }

  function nameOf(r) {
    return r.function_name || String(r.file_path || '').split('/').pop() || '(이름 없음)';
  }

  // 자세히 보기 카드
  function card(r, i) {
    const c = el('div', r.rank === 1 ? 'card top' : 'card');
    const info = locInfo(r);

    // 1줄: 순위 · 이름 · 유사도
    const head = el('div', 'head');
    head.append(el('span', 'rank', String(r.rank)), el('span', 'name', nameOf(r)), simEl(r));

    // 2줄: 파일 : 줄 범위 (누르면 원본 열기). 이 PC 에 원본이 없으면 흐린 글자 + "원본 없음"
    const loc = el('div', 'loc');
    let srcBanner = null;
    if (info.canOpen) {
      const link = el('a', '', info.where);
      link.href = '#';
      link.title = '원본 열기';
      link.addEventListener('click', function (e) { e.preventDefault(); openResult(r); });
      // 저장한 코드와 지금 파일 비교 결과
      if (r.source === 'moved') {
        loc.append(el('span', 'loc-old', info.oldWhere), document.createTextNode(' → '), link, srcTag('i', '위치 이동',
          '저장 뒤 위아래 코드가 바뀌어서 ' + r.moved_start + '–' + r.moved_end + '줄로 옮겨졌어요. 원본 열기는 새 위치로 가요.'));
      } else {
        loc.append(link);
        if (r.source === 'same') { loc.append(srcTag('ok', '원본 같음', '저장한 코드와 지금 파일 내용이 같아요')); }
        if (r.source === 'changed') {
          loc.append(srcTag('w', '원본 바뀜', '저장한 코드와 지금 파일 내용이 달라요'));
          srcBanner = el('div', 'srcwarn');
          const diffBtn = el('button', 'link-btn', '바뀐 부분 보기');
          diffBtn.type = 'button';
          diffBtn.addEventListener('click', function () { demoDone('stale'); vscode.postMessage({ type: 'compareSource', result: r }); });
          const resaveBtn = el('button', 'link-btn', '지금 내용으로 다시 저장');
          resaveBtn.type = 'button';
          resaveBtn.title = '지금 파일의 이 함수를 새로 저장해요 (기존 저장본은 그대로 둬요)';
          resaveBtn.addEventListener('click', function () { vscode.postMessage({ type: 'resave', result: r }); });
          srcBanner.append(el('span', '', '저장한 코드와 지금 파일 내용이 달라요'), diffBtn, resaveBtn);
        }
      }
    } else {
      const tag = el('button', 'tag', '원본 위치 연결');
      tag.type = 'button';
      tag.title = info.why;
      tag.addEventListener('click', function () { openResult(r); });
      loc.append(el('span', 'loc-off', info.where), tag);
    }

    // 3줄: 언어 색 점 · 언어 · 프로젝트 · id (Swagger 결과와 대조용)
    const sub = el('div', 'sub');
    sub.append(langDot(r.language), el('span', '', r.language + ' · ' + (r.project_name || '-') + ' · id ' + r.id));
    c.append(head, loc);
    if (srcBanner) { c.append(srcBanner); }
    c.append(sub);

    // 코드 — 실제 줄 번호(start_line 부터)와 함께
    const lines = String(r.code || '').replace(/\\r\\n/g, '\\n').replace(/\\n$/, '').split('\\n');
    const code = el('div', 'code');
    let hlState = null;   // 여러 줄 주석·문자열이 다음 줄로 이어질 때
    lines.forEach(function (text, k) {
      const h = highlight(text, r.language, hlState);
      hlState = h.state;
      const ln = el('div', 'ln');
      ln.append(el('span', 'n', String(r.start_line + k)), h.node);
      code.append(ln);
    });
    c.append(code);
    if (lines.length > MAX_LINES) {
      code.classList.add('clip');
      const more = el('button', 'more', lines.length + '줄 전체 보기');
      more.type = 'button';
      more.addEventListener('click', function () {
        const clipped = code.classList.toggle('clip');
        more.textContent = clipped ? lines.length + '줄 전체 보기' : '접기';
      });
      c.append(more);
    }

    const acts = el('div', 'acts');
    const openBtn = action('open', info.canOpen ? '원본 열기' : '위치 연결', function () { openResult(r); });
    if (!info.canOpen) { openBtn.title = info.why; }
    const copyBtn = action('copy', '복사', function () { copyCode(r, copyBtn); });
    acts.append(openBtn, action('insert', '삽입', function () { insertCode(r); }), copyBtn,
      action('diff', '비교', function () { compareResult(r); }));
    c.append(acts);

    keyboard(c, r, i, true, function () { copyBtn.click(); });
    return c;
  }

  // C. 간단히 보기 — 한 줄
  function compactRow(r, i) {
    const info = locInfo(r);
    const c = el('div', 'card compact' + (r.rank === 1 ? ' top' : '') + (info.canOpen ? '' : ' off'));
    const where = el('span', info.canOpen ? 'where ok' : 'where', info.oldWhere ? r.file_path + ' : ' + info.where : info.where);
    c.append(el('span', 'rank', String(r.rank)), langDot(r.language), el('span', 'name', nameOf(r)), where);
    if (r.source === 'moved') { c.append(srcTag('i', '이동', '위치 이동: ' + r.moved_start + '–' + r.moved_end + '줄')); }
    if (r.source === 'changed') { c.append(srcTag('w', '바뀜', '저장한 코드와 지금 파일 내용이 달라요')); }
    c.append(simEl(r));
    c.title = (info.canOpen ? '눌러서 원본 열기' : info.why) + ' · ↑↓ 이동 · C 복사 · I 삽입 · D 비교 · Esc 검색창';
    c.addEventListener('click', function () { openResult(r); });
    keyboard(c, r, i, true, function () { copyCode(r, null); showToast({ status: 'copy', function_name: nameOf(r) }); });
    return c;
  }

  // 키보드: ↑↓ 이동, Enter 원본 열기, C 복사, I 삽입, Esc 검색창
  function keyboard(c, r, i, canOpen, onCopy) {
    c.tabIndex = 0;
    if (!c.title) { c.title = '↑↓ 이동 · Enter 원본 열기 · C 복사 · I 삽입 · D 비교 · Esc 검색창'; }
    c.addEventListener('keydown', function (e) {
      if (e.target !== c) { return; }   // 카드 안 버튼에 포커스가 있으면 버튼 기본 동작
      const k = e.key.toLowerCase();
      if (e.key === 'ArrowDown') { e.preventDefault(); focusSibling(c, 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (!focusSibling(c, -1)) { input.focus(); } }
      else if (e.key === 'Enter') { e.preventDefault(); if (canOpen) { openResult(r); } }
      else if (k === 'c') { e.preventDefault(); onCopy(); }
      else if (k === 'i') { e.preventDefault(); insertCode(r); }
      else if (k === 'd') { e.preventDefault(); compareResult(r); }
      else if (e.key === 'Escape') { e.preventDefault(); input.focus(); }
    });
  }

  // 같은 묶음(검색 결과 목록 / AI 참고 코드) 안에서 앞뒤 카드로. 없으면 false
  function focusSibling(c, delta) {
    const cards = Array.prototype.slice.call(c.parentElement.querySelectorAll(':scope > .card'));
    const n = cards.indexOf(c) + delta;
    if (n < 0 || n >= cards.length) { return false; }
    cards[n].focus();
    cards[n].scrollIntoView({ block: 'nearest' });
    return true;
  }

  // n 번째 카드에 포커스. 없으면 false
  function focusCard(n) {
    const cards = list.querySelectorAll('.card');
    if (n < 0 || n >= cards.length) { return false; }
    cards[n].focus();
    cards[n].scrollIntoView({ block: 'nearest' });
    return true;
  }

  // 위치가 옮겨진 원본은 새 위치로 연다
  function openResult(r) {
    if (!locInfo(r).canOpen) { vscode.postMessage({ type: 'connectSource', result: r }); return; }
    markSeen(r.function_name, r.file_path);
    const target = r.source === 'moved' && r.moved_start ? Object.assign({}, r, { start_line: r.moved_start, end_line: r.moved_end }) : r;
    vscode.postMessage({ type: 'open', result: target });
  }
  function compareResult(r) { vscode.postMessage({ type: 'compare', result: r }); }
  function insertCode(r) { vscode.postMessage({ type: 'insert', code: r.code }); }
  function copyCode(r, btn) {
    vscode.postMessage({ type: 'copy', code: r.code });
    if (btn) { flashLabel(btn, '복사됨 ✓', '복사'); }
  }

  // 버튼 글자를 잠깐 바꿨다가 되돌린다 (마지막 글자 노드만 바꿔서 아이콘은 유지)
  function flashLabel(btn, temp, normal) {
    btn.lastChild.textContent = temp;
    btn.classList.add('done');
    setTimeout(function () { btn.lastChild.textContent = normal; btn.classList.remove('done'); }, 1500);
  }

  // ── H. 저장 기록
  function renderHistory() {
    histHead.replaceChildren(icon('chev'), document.createTextNode('저장 기록'), el('span', 'count', historyItems.length + '개'));
    histHead.classList.toggle('open', prefs.historyOpen);
    histBody.hidden = !prefs.historyOpen;
    histBody.replaceChildren();
    if (!historyItems.length) {
      histBody.append(el('div', 'hist-empty', '아직 저장한 코드가 없어요. 코드를 선택하고 Ctrl+Alt+S'));
      return;
    }
    const tools2 = el('div', 'hist-tools');
    const clear = el('button', 'link-btn', '기록 지우기');
    clear.type = 'button';
    clear.addEventListener('click', function () { vscode.postMessage({ type: 'clearHistory' }); });
    tools2.append(clear);
    histBody.append(tools2);
    historyItems.forEach(function (h) {
      const name = h.function_name || String(h.file_path || '').split('/').pop();
      const row = el('div', 'hrow');
      const parts = [];
      if (h.id !== undefined && h.id !== null) { parts.push('id ' + h.id); }
      parts.push(timeOf(h.time));
      if (typeof h.elapsedMs === 'number') { parts.push((h.elapsedMs / 1000).toFixed(1) + '초'); }
      parts.push(h.error ? h.error : h.file_path + ':' + h.start_line + '-' + h.end_line);
      const p = pillOf(h);
      const pill = el('span', 'pill ' + p.cls, p.text);
      row.append(el('span', 'fnm', name), el('span', 'meta', parts.join(' · ')));
      if (h.masked) {
        const mp = el('span', 'pill mock', '가림 ' + h.masked);
        mp.title = '저장 전에 비밀값 ' + h.masked + '개를 가렸어요';
        row.append(mp);
      }
      row.append(pill);
      row.title = '눌러서 "' + name + '" 검색' + (h.error ? ' — ' + h.error : '');
      row.addEventListener('click', function () { input.value = name; search(name); });
      histBody.append(row);
    });
  }
  // 원문 저장 여부와 검색 준비 상태를 구분한다. pending은 처리 중이라는 뜻이 아니다.
  function pillOf(h) {
    if (h.status === 'mock') { return { cls: 'mock', text: 'mock' }; }
    if (h.status === 'fail') { return { cls: 'fail', text: '실패' }; }
    if (h.status === 'unconfirmed') { return { cls: 'mock', text: '저장 여부 확인 필요' }; }
    if (h.embedding === null) { return { cls: 'mock', text: '검색 준비 확인 필요' }; }
    if (h.embedding === 'ready') { return { cls: 'ok', text: '검색 준비됨' }; }
    if (h.embedding === 'pending') { return { cls: 'mock', text: '임베딩 미처리' }; }
    if (h.embedding === 'failed') { return { cls: 'fail', text: '검색 준비 실패' }; }
    return { cls: 'ok', text: '저장됨' };
  }

  histHead.addEventListener('click', function () {
    prefs.historyOpen = !prefs.historyOpen;
    vscode.postMessage({ type: 'prefs', prefs: prefs });
    renderHistory();
  });

  // ── 패널 안 알림 (저장 결과 / 간단히 보기에서 복사)
  function showToast(rec) {
    const name = rec.function_name || String(rec.file_path || '').split('/').pop() || '';
    const embFailed = rec.status === 'ok' && rec.embedding === 'failed';
    const embUnconfirmed = rec.status === 'ok' && rec.embedding === null;
    const warning = embFailed || embUnconfirmed || rec.status === 'unconfirmed';
    toast.className = 'toast ' + (warning ? 'mock' : rec.status);
    let text;
    if (embFailed) { text = '저장됨 · 검색 준비 실패 · ' + name + ' · id ' + rec.id; }
    else if (embUnconfirmed) { text = '원문 저장됨 · ' + name + ' · id ' + rec.id + ' · 검색 준비 확인 필요'; }
    else if (rec.status === 'ok') {
      text = '저장됨 · ' + name + ' · id ' + rec.id + (rec.embedding === 'ready' ? ' · 검색 준비 완료' : rec.embedding === 'pending' ? ' · 임베딩 미처리' : '');
    }
    else if (rec.status === 'unconfirmed') { text = '저장 여부 확인 필요 · ' + name; }
    else if (rec.status === 'mock') { text = '[mock] 저장 흉내 · ' + name; }
    else if (rec.status === 'copy') { text = '복사됨 · ' + name; }
    else { text = '저장 실패 · ' + name; }
    if (rec.masked && rec.status !== 'copy') { text += ' · 비밀값 ' + rec.masked + '개 가림'; }
    toast.replaceChildren(icon(rec.status === 'fail' || warning ? 'alert' : 'check'), el('span', 'grow', text));
    if ((rec.status === 'ok' && rec.embedding === 'ready') || rec.status === 'mock') {
      const go = el('button', 'link-btn', '검색에서 확인');
      go.type = 'button';
      go.addEventListener('click', function () { toast.hidden = true; input.value = name; search(name); });
      toast.append(go);
    }
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, rec.status === 'copy' ? 1500 : 5000);
  }

  // ── 문법 색: 문자열·주석·숫자·키워드·함수·타입·데코레이터를 줄 단위로 칠한다.
  //    여러 줄짜리 주석(/* */)·문자열(파이썬 따옴표 3개, 백틱)은 state 로 다음 줄에 이어진다.
  //    innerHTML 을 쓰지 않아서 코드 안의 태그가 실행되지 않는다.
  const BS = String.fromCharCode(92);   // 역슬래시
  const BT = String.fromCharCode(96);   // 백틱
  const HASH_LANGS = new Set(['python', 'shellscript', 'ruby', 'r', 'yaml', 'perl', 'powershell', 'dockerfile', 'makefile', 'toml', 'coffeescript']);
  const SLASH_LANGS = new Set(['c', 'cpp', 'csharp', 'java', 'javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'go', 'rust',
    'kotlin', 'swift', 'php', 'dart', 'scss', 'less', 'css', 'jsonc', 'vue', 'scala', 'groovy']);
  const SQL_KEYWORDS = new Set(['SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'JOIN', 'LEFT', 'RIGHT',
    'INNER', 'OUTER', 'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'LIMIT', 'CREATE',
    'TABLE', 'INDEX', 'DROP', 'ALTER', 'ADD', 'PRIMARY', 'KEY', 'REFERENCES', 'DISTINCT', 'UNION', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    'RETURNING', 'EXISTS', 'IF', 'DEFAULT', 'BEGIN', 'COMMIT', 'ROLLBACK', 'WITH']);
  const FN_DECL = new Set(['def', 'function', 'fn', 'fun', 'func']);
  const TYPE_DECL = new Set(['class', 'interface', 'struct', 'enum', 'trait', 'type']);
  const CONSTS = new Set(['None', 'True', 'False', 'null', 'true', 'false', 'undefined', 'nil', 'NaN', 'this', 'self', 'super']);

  function isIdStart(c) { return !!c && /[A-Za-z_$]/.test(c); }
  function isIdChar(c) { return !!c && /[A-Za-z0-9_$]/.test(c); }

  function tokenize(text, lang, state) {
    const parts = [];
    const n = text.length;
    const hash = HASH_LANGS.has(lang), slash = SLASH_LANGS.has(lang), dash = lang === 'sql', py = lang === 'python';
    let i = 0;
    let plain = '';
    let decl = '';
    function flush() { if (plain) { parts.push(['', plain]); plain = ''; } }
    function push(cls, s) { flush(); if (s) { parts.push([cls, s]); } }

    // 앞 줄에서 이어진 주석·문자열
    if (state) {
      const e = text.indexOf(state.end);
      if (e < 0) { push(state.cls, text); return { parts: parts, state: state }; }
      push(state.cls, text.slice(0, e + state.end.length));
      i = e + state.end.length;
      state = null;
    }
    while (i < n) {
      const ch = text[i];
      const two = text.slice(i, i + 2);
      const three = text.slice(i, i + 3);
      if ((hash && ch === '#') || (slash && two === '//') || (dash && two === '--')) { push('com', text.slice(i)); break; }
      if (slash && two === '/*') {
        const e = text.indexOf('*/', i + 2);
        if (e < 0) { push('com', text.slice(i)); state = { end: '*/', cls: 'com' }; break; }
        push('com', text.slice(i, e + 2)); i = e + 2; continue;
      }
      if (py && (three === '"""' || three === "'''")) {
        const e = text.indexOf(three, i + 3);
        if (e < 0) { push('str', text.slice(i)); state = { end: three, cls: 'str' }; break; }
        push('str', text.slice(i, e + 3)); i = e + 3; continue;
      }
      if (ch === '"' || ch === "'" || (ch === BT && slash)) {
        let j = i + 1;
        while (j < n && text[j] !== ch) { j += text[j] === BS ? 2 : 1; }
        if (j >= n && ch === BT) { push('str', text.slice(i)); state = { end: BT, cls: 'str' }; break; }
        push('str', text.slice(i, Math.min(j + 1, n))); i = j + 1; continue;
      }
      if (/[0-9]/.test(ch) && !isIdChar(text[i - 1])) {
        let j = i;
        while (j < n && /[0-9a-fA-FxXoObB._]/.test(text[j])) { j++; }
        push('num', text.slice(i, j)); i = j; continue;
      }
      if (ch === '@' && isIdStart(text[i + 1])) {
        let j = i + 1;
        while (j < n && (isIdChar(text[j]) || text[j] === '.')) { j++; }
        push('deco', text.slice(i, j)); i = j; continue;
      }
      if (isIdStart(ch)) {
        let j = i;
        while (j < n && isIdChar(text[j])) { j++; }
        const w = text.slice(i, j);
        let k = j;
        while (k < n && text[k] === ' ') { k++; }
        let cls = '';
        if (decl) { cls = decl; decl = ''; }
        else if (CONSTS.has(w)) { cls = 'const'; }
        else if (lang === 'sql' ? SQL_KEYWORDS.has(w.toUpperCase()) : KEYWORDS.has(w)) {
          cls = 'kw';
          decl = FN_DECL.has(w) ? 'fn' : TYPE_DECL.has(w) ? 'type' : '';
        }
        else if (text[k] === '(') { cls = 'fn'; }
        else if (w[0] >= 'A' && w[0] <= 'Z' && w !== w.toUpperCase()) { cls = 'type'; }
        if (cls) { push(cls, w); } else { plain += w; }
        i = j; continue;
      }
      plain += ch;
      i++;
    }
    flush();
    return { parts: parts, state: state };
  }

  function highlight(text, lang, state) {
    const res = tokenize(text, lang, state);
    const span = el('span', 't');
    res.parts.forEach(function (p) { span.append(p[0] ? el('span', p[0], p[1]) : document.createTextNode(p[1])); });
    return { node: span, state: res.state };
  }

  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'i');
    ICONS[name].forEach(function (d) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    });
    return svg;
  }

  function action(name, label, onClick) {
    const b = el('button', '');
    b.type = 'button';
    b.append(icon(name), document.createTextNode(label));
    b.addEventListener('click', onClick);
    return b;
  }

  // ── AI 질문 (POST /ask) — 끝에 ? + Enter, Ctrl+Enter, 질문 예시·제안 줄을 눌렀을 때만 보낸다. 입력·탭 이동만으로는 안 나간다.
  //    답변 영역은 검색 결과와 따로 있어서 서로 덮어쓰지 않는다. 늦게 도착한 이전 질문의 답은 reqId 로 버린다.
  let asking = false;
  let askSeq = 0;
  let lastAsk = '';
  // 이어서 묻기 — 지금 대화의 질문·답변들 (최대 3번). 위 검색창에서 물으면 새 대화
  const TURN_MAX = 3;
  const HISTORY_SEND = 2;
  let thread = [];
  let currentAsk = null;      // { q, base } — base: 이 질문 앞의 대화
  let currentAnswer = null;   // 지금 보이는 답변 { q, r } — 복사·다시 생성·단축키용
  let askStartedAt = 0;
  let askTicker = 0;
  let pendingVague = '';      // 애매한 질문 경고를 띄운 질문 — 한 번 더 누르면 보낸다
  const vagueBox = byId('vague');
  answerBox.tabIndex = -1;    // 답변 칸을 누르면 단축키가 먹게

  function setAsking(on) {
    asking = on;
    updateMode();
    clearInterval(askTicker);
    if (on) {
      askStartedAt = Date.now();
      askTicker = setInterval(tickAsk, 1000);
    }
  }
  // 생성 중 칩에 걸린 초
  function tickAsk() {
    const chip = answerBox.querySelector('.achip.pending');
    if (!chip) { return; }
    chip.textContent = chip.dataset.base + ' · ' + Math.round((Date.now() - askStartedAt) / 1000) + '초';
  }

  function showVague(q) {
    pendingVague = q;
    const ex = el('b', '', '정렬하는 함수 어떻게 동작해?');
    const line1 = el('div');
    line1.append(document.createTextNode('질문이 너무 짧아요. 예: '), ex);
    vagueBox.replaceChildren(line1, el('div', 'vsub', '그래도 보내려면 Enter 한 번 더'));
    vagueBox.hidden = false;
  }
  function hideVague() {
    pendingVague = '';
    vagueBox.hidden = true;
  }
  input.addEventListener('input', hideVague);

  // opts: follow(이어서 묻기) / regen(같은 질문을 같은 앞 대화로 다시, 저장된 답변 무시) / checkVague(애매하면 한 번 멈춤)
  function ask(q, opts) {
    opts = opts || {};
    if (!q || asking) { return; }
    if (opts.checkVague && pendingVague !== q && isVagueQuestion(q)) { showVague(q); return; }
    hideVague();
    closeRecent();
    hideSuggest();
    const base = opts.regen && currentAsk ? currentAsk.base : opts.follow ? thread.slice() : [];
    currentAsk = { q: q, base: base };
    if (!opts.follow && !opts.regen) { clearInput(); }   // 위 검색창에서 보낸 질문이면 비운다
    askSeq += 1;
    lastAsk = q;
    setAsking(true);
    intro.hidden = true;
    renderAnswerLoading(q);
    vscode.postMessage({ type: 'ask', q: q, reqId: askSeq, history: base.slice(-HISTORY_SEND), fresh: !!opts.regen || !!opts.serverKey, useServerKey: !!opts.serverKey });
  }

  // 취소 — 확장 본체에 끊으라고 알리고, 늦게 오는 응답은 번호가 달라서 버려진다
  function cancelAsk() {
    if (!asking) { return; }
    vscode.postMessage({ type: 'askCancel', reqId: askSeq });
    askSeq += 1;
    setAsking(false);
    if (currentAsk) { thread = currentAsk.base; }
    renderCancelled(lastAsk);
  }
  function regenerate() {
    if (!currentAnswer || asking) { return; }
    ask(currentAnswer.q, { regen: true });
  }
  function newChat() {
    thread = [];
    currentAsk = null;
    closeAnswer();
    input.focus();
    input.select();
  }
  function closeAnswer() {
    answerBox.hidden = true;
    currentAnswer = null;
    if (!current && !list.firstChild) { intro.hidden = false; }
  }
  function copyAnswer(btn) {
    if (!currentAnswer) { return; }
    const r = currentAnswer.r;
    vscode.postMessage({ type: 'copyText', text: answerToMarkdown(currentAnswer.q, r.answer, r.sources) });
    // 헤더가 좁아서 아이콘만 — 잠깐 초록 체크로 바꿔서 복사됐다고 보여준다
    const b = btn || answerBox.querySelector('.copy-answer');
    if (!b) { return; }
    b.replaceChildren(icon('check'));
    b.classList.add('done');
    setTimeout(function () { b.replaceChildren(icon('copy')); b.classList.remove('done'); }, 1500);
  }
  // Esc: 생성 중이면 취소 (검색창·답변 어디서든). 최근 검색어 목록이 열려 있으면 그걸 먼저 닫는다
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && asking && !e.defaultPrevented && recentBox.hidden) { e.preventDefault(); cancelAsk(); }
  });
  // 답변 칸 단축키: 1~9 인용 코드로 · C 복사 · R 다시 생성 · F 이어서 묻기 · Esc 닫기
  answerBox.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) { return; }
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { return; }
    if (asking || !currentAnswer) { return; }
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') { closeAnswer(); input.focus(); }
    else if (/^[1-9]$/.test(e.key)) { focusSource('S' + e.key); }
    else if (k === 'c') { copyAnswer(null); }
    else if (k === 'r') { regenerate(); }
    else if (k === 'f') { const f = answerBox.querySelector('.follow input'); if (!f) { return; } f.focus(); }
    else { return; }
    e.preventDefault();
  });

  function hbtn(iconName, label, title, onClick, cls) {
    const b = el('button', 'ibtn' + (cls ? ' ' + cls : ''));
    b.type = 'button';
    b.title = title;
    if (iconName) { b.append(icon(iconName)); }
    if (label) { b.append(document.createTextNode(label)); }
    b.addEventListener('click', onClick);
    return b;
  }

  const KEYS_HELP = [['1~9', 'S1~S9 코드로 이동'], ['C', '답변 복사'], ['R', '다시 생성'], ['F', '이어서 묻기 칸으로'], ['Esc', '닫기 / 생성 취소']];

  // o: { cancel, regen, copy, keys, turn }
  function answerHead(label, cls, q, o) {
    o = o || {};
    const head = el('div', 'ahead');
    // 접혔을 때만 보이는 것: 질문 한 줄 + 펼치기
    const qmini = el('span', 'qmini', q || '');
    const expand = el('button', 'link-btn expand', '펼치기');
    expand.type = 'button';
    expand.addEventListener('click', function () { answerBox.classList.remove('collapsed'); });
    const chip = el('span', 'achip ' + cls, label);
    chip.dataset.base = label;
    // 버튼은 오른쪽 한 묶음 — 좁으면 묶음째 다음 줄 오른쪽으로 (글자가 … 로 잘리지 않게)
    const tools = el('span', 'htools');
    head.append(icon('spark'), el('strong', '', 'AI 답변'), chip, qmini, el('span', 'grow'), expand, tools);
    if (o.cancel) {
      tools.append(hbtn('close', '취소', '기다리기 취소 (Esc)', cancelAsk, 'cancel'));
      return head;
    }
    if (o.regen) { tools.append(hbtn('redo', '다시 생성', 'AI를 다시 불러서 새로 받기 (R)', regenerate, 'regen')); }
    if (o.copy) {
      const cb = hbtn('copy', '', '답변 복사 — 질문·답변·참고 코드를 마크다운으로 (C)', function () { copyAnswer(cb); }, 'copy-answer');
      tools.append(cb);
    }
    if (o.keys) {
      const kb = hbtn('', '?', KEYS_HELP.map(function (x) { return x[0] + ' ' + x[1]; }).join(' · '), function () {
        const open = answerBox.querySelector('.keys');
        if (open) { open.remove(); kb.classList.remove('on'); return; }
        const box = el('div', 'keys');
        KEYS_HELP.forEach(function (x) {
          const row = el('div');
          row.append(el('span', '', x[1]), el('kbd', '', x[0]));
          box.append(row);
        });
        head.after(box);
        kb.classList.add('on');
      }, 'keys-btn');
      tools.append(kb);
    }
    tools.append(hbtn('close', '', '답변 닫기 (Esc)', closeAnswer));
    return head;
  }

  // AI 질문은 범위(프로젝트·언어)를 보내지 않는다 — 걸려 있으면 분명히 알린다
  function scopeText() {
    return filterOn(sfilter) ? 'AI 질문은 범위(' + scopeLabel(sfilter) + ') 없이 전체 DB 대상' : '전체 DB 대상';
  }

  // 이어서 묻기 중이면 앞 대화를 한 줄씩. withNewChat: 마지막 줄 오른쪽에 "새 대화"
  function prevLines(base, withNewChat) {
    return base.map(function (t, i) {
      const d = el('div', 'prev');
      d.append(icon('chev'), el('span', 'ptext', '이전: ' + t.q + ' → ' + t.answer.replace(/\\s+/g, ' ').slice(0, 80)));
      d.title = t.q + '\\n\\n' + t.answer;
      if (withNewChat && i === base.length - 1) {
        const nb = el('button', 'link-btn newchat', '새 대화');
        nb.type = 'button';
        nb.title = '이어서 묻기를 끊고 새로 묻기';
        nb.addEventListener('click', newChat);
        d.append(nb);
      }
      return d;
    });
  }

  function renderAnswerLoading(q) {
    answerBox.hidden = false;
    answerBox.classList.remove('collapsed');
    const lines = el('div', 'alines');
    [92, 100, 64].forEach(function (w) { const s = el('div', 'skel-line'); s.style.width = w + '%'; lines.append(s); });
    const parts = [answerHead('생성 중', 'pending', q, { cancel: true })];
    if (currentAsk) { parts.push.apply(parts, prevLines(currentAsk.base)); }
    parts.push(el('div', 'aq', '질문: ' + q), lines,
      el('div', 'afoot', '저장된 코드를 찾아서 답변을 만드는 중… 최대 ' + (mode.askTimeout || 45) + '초 · Esc 로도 취소'));
    answerBox.replaceChildren.apply(answerBox, parts);
    tickAsk();
  }

  // 한 글자씩: 참고 코드 이름 먼저 → 답변 조각을 이어 붙인다. 다 오면 renderAnswer 가 통째로 바꾼다
  function streamView() {
    let box = answerBox.querySelector('.stream');
    if (box) { return box; }
    const parts = [answerHead('작성 중', 'pending', lastAsk, { cancel: true })];
    if (currentAsk) { parts.push.apply(parts, prevLines(currentAsk.base)); }
    const found = el('div', 'found');
    found.hidden = true;
    box = el('div', 'abody stream');
    box.append(el('span', 'stext', ''), el('span', 'caret'));
    parts.push(el('div', 'aq', '질문: ' + lastAsk), found, box, el('div', 'afoot', '답변을 쓰는 중… 최대 ' + (mode.askTimeout || 45) + '초 · Esc 로도 취소'));
    answerBox.replaceChildren.apply(answerBox, parts);
    tickAsk();
    return box;
  }
  function renderStreamSources(sources) {
    streamView();
    const found = answerBox.querySelector('.found');
    found.replaceChildren(document.createTextNode('참고 코드 찾음'));
    sources.forEach(function (s) {
      const p = el('span', 'fpill', s.citation_id + ' ' + (s.function_name || s.file_path));
      found.append(p);
    });
    found.hidden = !sources.length;
  }
  function renderStreamDelta(text) {
    const box = streamView();
    box.dataset.raw = (box.dataset.raw || '') + text;
    box.querySelector('.stext').textContent = box.dataset.raw.split(BT).join('');   // 백틱은 다 받은 뒤 코드 글씨로
  }

  function renderCancelled(q) {
    answerBox.hidden = false;
    answerBox.classList.remove('collapsed');
    currentAnswer = null;
    const btns = el('div', 'btns left');
    btns.append(sbtn('다시 묻기', true, function () { ask(q, { regen: true }); }));
    answerBox.replaceChildren(
      answerHead('취소함', 'warn', q, {}),
      el('div', 'aq', '질문: ' + q),
      el('div', 'afoot', '기다리기를 그만뒀어요. 서버에서는 답변이 계속 만들어졌을 수 있어요.'),
      btns
    );
  }

  function agoText(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!(ms >= 0)) { return ''; }
    const m = Math.floor(ms / 60000);
    if (m < 1) { return '방금'; }
    if (m < 60) { return m + '분 전'; }
    if (m < 60 * 24) { return Math.floor(m / 60) + '시간 전'; }
    return timeOf(iso) ? new Date(iso).toLocaleDateString() : '';
  }

  function renderAnswer(msg) {
    const r = msg.result;
    const insufficient = r.status === 'insufficient_context';
    const base = currentAsk && currentAsk.q === msg.q ? currentAsk.base : [];
    if (!currentAsk || currentAsk.q !== msg.q) { currentAsk = { q: msg.q, base: base }; }
    thread = insufficient ? base.slice() : base.concat([{ q: msg.q, answer: r.answer }]);
    currentAnswer = { q: msg.q, r: r };
    answerBox.hidden = false;
    answerBox.classList.remove('collapsed');

    const label = msg.cached ? '저장됨 · ' + agoText(msg.cached.time) : insufficient ? '근거 부족' : '답변 완료';
    const cls = msg.cached ? 'saved' : insufficient ? 'warn' : 'ok';
    const parts = [answerHead(label, cls, msg.q, { copy: true, keys: true, regen: !!msg.cached })];
    if (filterOn(sfilter)) {
      const pill = el('span', 'achip saved', '범위 무시 · 전체 DB');
      pill.title = 'AI 질문에는 프로젝트·언어 범위를 적용하지 않아요';
      parts[0].querySelector('.achip').after(pill);
    }
    parts.push.apply(parts, prevLines(base, true));
    parts.push(el('div', 'aq', '질문: ' + msg.q));

    if (insufficient) {
      parts.push(el('div', 'anote', r.sources.length
        ? '참고할 만한 코드는 찾았지만, 답하기에는 근거가 부족해요.'
        : '질문과 관련된 저장 코드를 찾지 못했어요. 다른 말로 묻거나 일반 검색으로 찾아보세요.'));
    }
    if (msg.historySent > 0 && r.historyUsed === null) {
      parts.push(el('div', 'anote', '서버가 아직 이전 대화를 반영하지 않아요 — 새 질문처럼 답했을 수 있어요.'));
    }
    if (r.answer && r.answer.trim()) { parts.push(citedText(r.answer, r.sources)); }
    if (r.unknownCitations.length) {
      parts.push(el('div', 'anote bad', '답변에 참고 코드 목록에 없는 인용이 있어요: ' + r.unknownCitations.join(', ') + ' — 표시만 하고 열 수 없어요.'));
    }

    // 답변에 쓰인 코드는 펼쳐서, 인용 안 된 코드는 한 줄로 접어서 아래로
    if (r.sources.length) {
      const cited = r.sources.filter(function (s) { return r.citations.indexOf(s.citation_id) >= 0; });
      const uncited = r.sources.filter(function (s) { return r.citations.indexOf(s.citation_id) < 0; });
      const shown = cited.length ? cited : r.sources;
      parts.push(el('div', 'asrc-title', cited.length
        ? '답변에 쓰인 코드 ' + cited.length + '개 · 본문의 출처 번호를 누르면 이동'
        : '참고 코드 ' + r.sources.length + '개'));
      const box = el('div', 'asrc');
      shown.forEach(function (s, i) {
        const c = card(Object.assign({ rank: s.citation_id }, s), i);
        c.dataset.cite = s.citation_id;
        box.append(c);
      });
      parts.push(box);
      if (cited.length && uncited.length) {
        const more = el('button', 'uncited');
        more.type = 'button';
        more.append(icon('chev'), el('span', 'ulabel', '인용 안 된 참고 코드 ' + uncited.length + '개'),
          el('span', 'unames', uncited.map(function (s) { return nameOf(s); }).join(', ')));
        const ubox = el('div', 'asrc dim');
        ubox.hidden = true;
        uncited.forEach(function (s, i) {
          const c = card(Object.assign({ rank: s.citation_id }, s), i);
          c.dataset.cite = s.citation_id;
          ubox.append(c);
        });
        more.addEventListener('click', function () {
          ubox.hidden = !ubox.hidden;
          more.classList.toggle('open', !ubox.hidden);
        });
        parts.push(more, ubox);
      }
    }

    const act = el('div', 'act');
    const btns = el('div', 'btns left');
    if (insufficient) {
      btns.append(sbtn('다른 말로 묻기', false, function () { input.value = msg.q; updateMode(); input.focus(); input.select(); }));
    }
    btns.append(sbtn('같은 말로 일반 검색', false, function () { input.value = msg.q; updateMode(); search(msg.q); }));
    const fb = feedbackRow(msg);
    act.append(btns, fb.row);
    parts.push(act, fb.panel, fb.thanks);

    // 이어서 묻기 (답을 받았을 때만, 최대 3번)
    if (!insufficient && thread.length < TURN_MAX) {
      const follow = el('form', 'follow');
      const fin = el('input');
      fin.placeholder = '이어서 묻기… (예: 그럼 음수도 돼?)';
      const fgo = el('button', 'sbtn primary', '묻기');
      fgo.type = 'submit';
      follow.append(fin, fgo);
      follow.addEventListener('submit', function (e) {
        e.preventDefault();
        const v = fin.value.trim();
        if (v) { ask(v, { follow: true }); }
      });
      parts.push(follow);
    } else if (!insufficient) {
      parts.push(el('div', 'afoot', '대화가 길어졌어요 — 새 질문은 위 검색창에서 해 주세요.'));
    }

    const foot = [];
    if (msg.cached) {
      foot.push('저장해 둔 답변이라 AI를 다시 부르지 않았어요 · 코드가 바뀌었으면 다시 생성');
    } else {
      if (r.model === 'mock') { foot.push('mock 답변 (서버 호출 안 함)'); }
      else if (r.model) { foot.push(r.model); }
      else { foot.push('LLM 호출 없음'); }
      if (r.usage) {
        foot.push('토큰 ' + r.usage.total_tokens.toLocaleString() + ' (입력 ' + r.usage.input_tokens.toLocaleString() + ' / 출력 ' + r.usage.output_tokens.toLocaleString() + ')');
      } else if (r.model && r.model !== 'mock') {
        foot.push('사용량 정보 없음');
      }
      foot.push((msg.elapsedMs / 1000).toFixed(1) + '초');
    }
    if (msg.keyUsed) { foot.push('내 키 (' + msg.keyUsed + ')'); }
    if (msg.keyBlocked) { foot.push('주소가 https 가 아니라 내 키를 안 보냄 (서버 기본 키)'); }
    if (msg.historySent > 0) { foot.push('앞 대화 ' + msg.historySent + '개를 같이 보냄'); }
    if (msg.today) { foot.push('오늘 ' + msg.today.count + '번 · ' + msg.today.tokens.toLocaleString() + ' 토큰'); }
    foot.push(scopeText());
    parts.push(el('div', 'afoot', foot.join(' · ')));
    answerBox.replaceChildren.apply(answerBox, parts);
  }

  // 👍 / 👎 — 👎 면 이유 칩 + 한 줄 메모 (둘 다 선택). 같은 버튼을 다시 누르면 취소
  const FB_REASONS = ['틀린 내용', '엉뚱한 코드 참고', '못 찾음', '너무 김', '기타'];
  function feedbackRow(msg) {
    const r = msg.result;
    const fb = { id: 'fb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7), rating: null, reasons: [], memo: '' };
    const row = el('span', 'fb');
    const up = hbtn('up', '', '도움이 됐어요', function () { rate('up'); }, 'up');
    const down = hbtn('down', '', '별로예요', function () { rate('down'); }, 'down');
    row.append(el('span', 'fbq', '도움이 됐나요?'), up, down);

    const panel = el('div', 'reasons');
    panel.hidden = true;
    const chipsBox = el('div', 'rchips');
    FB_REASONS.forEach(function (label) {
      const c = el('button', 'rchip', label);
      c.type = 'button';
      c.addEventListener('click', function () {
        const i = fb.reasons.indexOf(label);
        if (i >= 0) { fb.reasons.splice(i, 1); } else { fb.reasons.push(label); }
        c.classList.toggle('on', i < 0);
        send();
      });
      chipsBox.append(c);
    });
    const memo = el('input');
    memo.placeholder = '한 줄 메모 (선택) · Enter 로 저장';
    memo.maxLength = 300;
    memo.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') { return; }
      e.preventDefault();
      fb.memo = memo.value.trim();
      send();
      thanksText.textContent = '✓ 메모까지 기록했어요';
    });
    panel.append(el('div', 'rt', '뭐가 별로였어요? (선택)'), chipsBox, memo);
    const thanks = el('div', 'thanks');
    thanks.hidden = true;
    const thanksText = el('span', '', '');
    const allFb = el('button', 'link-btn fball', '피드백 모아보기 (JSON)');
    allFb.type = 'button';
    allFb.title = '이 PC 에 남긴 AI 피드백 전체를 JSON 으로 열기 (팀 공유용)';
    allFb.addEventListener('click', function () { vscode.postMessage({ type: 'exportFeedback' }); });
    thanks.append(thanksText, allFb);

    function rate(v) {
      fb.rating = fb.rating === v ? null : v;
      up.classList.toggle('on', fb.rating === 'up');
      down.classList.toggle('on', fb.rating === 'down');
      panel.hidden = fb.rating !== 'down';
      thanks.hidden = !fb.rating;
      thanksText.textContent = '✓ 기록했어요 · 다시 누르면 취소';
      send();
    }
    function send() {
      vscode.postMessage({ type: 'feedback', fb: {
        id: fb.id, time: new Date().toISOString(), q: msg.q, answer: r.answer, status: r.status, model: r.model,
        mock: r.model === 'mock', source_ids: r.sources.map(function (s) { return s.id; }),
        rating: fb.rating, reasons: fb.reasons.slice(), memo: fb.memo,
      } });
    }
    return { row: row, panel: panel, thanks: thanks };
  }

  // 답변 글자 속 [S1] → 누르면 그 참고 코드로. 목록에 없는 인용은 누를 수 없게 빨갛게. 백틱으로 감싼 코드는 코드 글씨로
  function citedText(answer, sources) {
    const known = sources.map(function (s) { return s.citation_id; });
    const body = el('div', 'abody');
    let i = 0;
    let plain = '';
    function flush() { if (plain) { body.append(document.createTextNode(plain)); plain = ''; } }
    while (i < answer.length) {
      if (answer[i] === BT) {
        const j = answer.indexOf(BT, i + 1);
        if (j > i + 1 && answer.slice(i + 1, j).indexOf('\\n') < 0) {
          flush();
          body.append(el('code', 'icode', answer.slice(i + 1, j)));
          i = j + 1;
          continue;
        }
      }
      if (answer[i] === '[' && answer[i + 1] === 'S') {
        let j = i + 2;
        while (j < answer.length && answer[j] >= '0' && answer[j] <= '9') { j++; }
        if (j > i + 2 && answer[j] === ']') {
          const id = answer.slice(i + 1, j);
          flush();
          if (known.indexOf(id) >= 0) {
            const b = el('button', 'cite', id);
            b.type = 'button';
            b.title = id + ' 참고 코드로 이동';
            b.addEventListener('click', function () { focusSource(id); });
            body.append(b);
          } else {
            const bad = el('span', 'cite bad', id);
            bad.title = '참고 코드 목록에 없는 인용입니다';
            body.append(bad);
          }
          i = j + 1;
          continue;
        }
      }
      plain += answer[i];
      i++;
    }
    flush();
    return body;
  }

  // 인용 → 그 참고 코드 카드를 펼치고, 보이게 스크롤하고, 잠깐 깜빡
  function focusSource(id) {
    const c = answerBox.querySelector('.card[data-cite="' + id + '"]');
    if (!c) { return; }
    if (c.parentElement && c.parentElement.hidden) {   // 접힌 "인용 안 된 코드" 안이면 펼친다
      c.parentElement.hidden = false;
      const more = answerBox.querySelector('.uncited');
      if (more) { more.classList.add('open'); }
    }
    const code = c.querySelector('.code');
    const more = c.querySelector('.more');
    if (code && code.classList.contains('clip')) {
      code.classList.remove('clip');
      if (more) { more.textContent = '접기'; }
    }
    c.classList.remove('flash');
    void c.offsetWidth;
    c.classList.add('flash');
    c.scrollIntoView({ block: 'nearest' });
    c.focus();
  }

  function renderAskError(msg) {
    answerBox.hidden = false;
    answerBox.classList.remove('collapsed');
    currentAnswer = null;
    if (currentAsk) { thread = currentAsk.base; }
    const warn = msg.kind === 'timeout' || msg.kind === 'cancelled';
    const box = el('div', warn ? 'error warn' : 'error');
    const text = el('div');
    text.append(el('strong', '', msg.title), el('div', '', msg.detail || ''));
    const btns = el('div', 'btns');
    if (msg.kind === 'key') {
      btns.append(sbtn('AI 키 설정 열기', true, function () { vscode.postMessage({ type: 'openKeyPanel' }); }));
      btns.append(sbtn('서버 기본 키로 다시 묻기', false, function () { ask(msg.q, { regen: true, serverKey: true }); }));
    } else if (msg.kind === 'input') {
      btns.append(sbtn('질문 고치기', true, function () { input.value = msg.q; updateMode(); input.focus(); input.select(); }));
    } else {
      // 자동 재전송은 하지 않는다. 사람이 누를 때만 같은 질문을 다시 보낸다.
      btns.append(sbtn('다시 묻기', true, function () { ask(msg.q, { regen: true }); }));
    }
    if (msg.kind === 'connect' || msg.kind === 'unavailable' || msg.kind === 'server') {
      btns.append(sbtn('모드 바꾸기', false, function () { vscode.postMessage({ type: 'switchMode' }); }));
    }
    text.append(btns);
    box.append(icon(warn ? 'clock' : 'alert'), text);
    answerBox.replaceChildren(answerHead(msg.kind === 'key' ? '키 확인 필요' : warn ? '시간 초과' : '오류', warn ? 'warn' : 'err', msg.q, {}),
      el('div', 'aq', '질문: ' + msg.q), box);
    if (msg.keyUsed) { answerBox.append(el('div', 'afoot', '내 AI 키 (' + msg.keyUsed + ')로 보냄 · 자동으로 다시 보내지 않아요')); }
  }

  function sbtn(label, primary, onClick) {
    const b = el('button', primary ? 'sbtn primary' : 'sbtn', label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function unique(arr) { return arr.filter(function (v, i) { return arr.indexOf(v) === i; }); }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function timeOf(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // textContent 로만 넣는다 — 코드 안에 <script> 같은 게 있어도 실행되지 않게
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  renderHistory();
  renderChips();
  // 준비됐다고 알리면 확장 본체가 설정·최근 검색어·저장 기록·지난 검색을 보내준다
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
