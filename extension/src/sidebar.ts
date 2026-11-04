import * as vscode from 'vscode';
import { clamp, EmbeddingStatus, reindent } from './logic';

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
const MOCK_RESULTS: SearchResult[] = [
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
];

// ─────────────────────────────────────────────
// 검색 — GET /search (mock 이면 샘플 반환)
// ─────────────────────────────────────────────
// 검색 오류 — 사이드바에 "제목 + 설명"으로 나눠 보여주기 위해
//   kind: timeout(기다리면 될 수 있음) / connect(서버·주소 문제) / server(서버 오류) / format(응답 모양 문제)
type SearchErrorKind = 'timeout' | 'connect' | 'server' | 'format';
class SearchError extends Error {
  constructor(
    public readonly title: string,
    public readonly detail: string,
    public readonly kind: SearchErrorKind = 'server',
  ) {
    super(`${title}: ${detail}`);
  }
}

async function searchSnippets(query: string): Promise<SearchResult[]> {
  const config = vscode.workspace.getConfiguration('codeMemory');

  if (config.get<boolean>('mock', true)) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return MOCK_RESULTS;   // mock 은 검색어와 상관없이 샘플 3개
  }

  // API_CONTRACT.md: GET /search?q=...&limit=N → { results: [...] }. limit 은 설정값(계약 범위 1~20)
  const baseUrl = config.get<string>('apiUrl', 'http://localhost:8000').replace(/\/+$/, '');
  const limit = Math.min(20, Math.max(1, Math.round(config.get<number>('searchLimit', 10))));
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&limit=${limit}`;
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
  if (!res.ok) {
    throw new SearchError(`서버 오류 (HTTP ${res.status})`, text.slice(0, 300), 'server');
  }

  // 응답이 예상한 모양이 아니면 빈 결과로 넘기지 말고 오류로 보여준다
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new SearchError('응답 형식 오류', `JSON 이 아닙니다: ${text.slice(0, 200)}`, 'format');
  }
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    throw new SearchError('응답 형식 오류', `results 배열이 없습니다: ${text.slice(0, 200)}`, 'format');
  }
  return results as SearchResult[];
}

// ─────────────────────────────────────────────
// 웹페이지가 부탁할 수 있는 일들
// ─────────────────────────────────────────────
function resolveUri(r: SearchResult): vscode.Uri | null {
  if (r.absolute_path) {
    return vscode.Uri.file(r.absolute_path);
  }
  // 절대 경로가 없으면: 지금 열린 폴더 중 이름이 같은 프로젝트에서 상대 경로로 찾기
  const folder = vscode.workspace.workspaceFolders?.find((f) => f.name === r.project_name);
  return folder ? vscode.Uri.joinPath(folder.uri, r.file_path) : null;
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
  | { type: 'search'; query: string }
  | { type: 'open'; result: SearchResult }
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
  | { type: 'walkthrough' };

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
}
const HISTORY_KEY = 'codeMemory.saveHistory';
const HISTORY_MAX = 20;

// 화면 설정 — 자세히/간단히, 저장 기록 펼침
interface UiPrefs {
  view: 'full' | 'compact';
  historyOpen: boolean;
}
const PREFS_KEY = 'codeMemory.uiPrefs';
const DEFAULT_PREFS: UiPrefs = { view: 'full', historyOpen: false };

// 마지막 검색 — 다시 열었을 때 복원용
interface SavedSearch {
  query: string;
  results: SearchResult[];
}
const STATE_KEY = 'codeMemory.lastSearch';
const RECENT_KEY = 'codeMemory.recentQueries';   // 최근 검색어 (최대 5개)
const RECENT_MAX = 5;

// 결과마다 "이 PC 에서 원본을 열 수 있는지" 미리 확인해서 붙인다
//   ok: 열 수 있음 / no_folder: 그 프로젝트 폴더가 안 열려 있음 / missing: 폴더는 있는데 파일이 없음
type LocalStatus = 'ok' | 'no_folder' | 'missing';

async function withLocalStatus(results: SearchResult[]): Promise<(SearchResult & { local: LocalStatus })[]> {
  return Promise.all(results.map(async (r) => {
    const uri = resolveUri(r);
    if (!uri) {
      return { ...r, local: 'no_folder' as const };
    }
    try {
      await vscode.workspace.fs.stat(uri);
      return { ...r, local: 'ok' as const };
    } catch {
      return { ...r, local: 'missing' as const };
    }
  }));
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

  // state: 마지막 검색·최근 검색어·저장 기록·화면 설정을 워크스페이스별로 저장 (다시 열어도 남는다)
  constructor(private readonly state: vscode.Memento) {}

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
      });
    };
    const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codeMemory')) {
        postConfig();
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
          view.webview.postMessage({ type: 'recent', items: this.state.get<string[]>(RECENT_KEY, []) });
          view.webview.postMessage({ type: 'history', items: this.state.get<SaveRecord[]>(HISTORY_KEY, []) });
          // 바로 검색할 게 없으면 지난 검색어·결과를 복원
          const saved = this.state.get<SavedSearch>(STATE_KEY);
          if (this.pendingQuery === undefined && saved) {
            const results = await withLocalStatus(saved.results);
            view.webview.postMessage({ type: 'restore', query: saved.query, results });
          }
          this.flush();
          break;
        }
        case 'search': {
          // 최근 검색어: 같은 건 맨 앞으로, 최대 5개
          const recent = [msg.query, ...this.state.get<string[]>(RECENT_KEY, []).filter((q) => q !== msg.query)].slice(0, RECENT_MAX);
          await this.state.update(RECENT_KEY, recent);
          view.webview.postMessage({ type: 'recent', items: recent });
          try {
            const results = await searchSnippets(msg.query);
            view.webview.postMessage({ type: 'results', query: msg.query, results: await withLocalStatus(results) });
            await this.state.update(STATE_KEY, { query: msg.query, results } satisfies SavedSearch);
          } catch (err) {
            const title = err instanceof SearchError ? err.title : '검색 실패';
            const detail = err instanceof SearchError ? err.detail : err instanceof Error ? err.message : String(err);
            const kind = err instanceof SearchError ? err.kind : 'server';
            view.webview.postMessage({ type: 'error', title, detail, kind });
          }
          break;
        }
        case 'open': {
          await openSource(msg.result);
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
  .recent-item { padding: 4px 10px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .recent-item:hover { background: var(--vscode-list-hoverBackground); }
  .recent-item.active { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }

  /* 요약줄: 결과 수 · 자세히/간단히 · 기록 복사 · 지우기 */
  .bar { display: flex; align-items: center; gap: 4px; min-height: 22px; margin: 0 0 4px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .bar .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
  .filters { display: flex; gap: 6px; margin: 0 0 6px; }
  .filters select { flex: 1; min-width: 0; padding: 2px 4px; font: inherit; font-size: 11px; border-radius: 3px;
                    color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background);
                    border: 1px solid var(--vscode-dropdown-border, transparent); }

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

  <div id="header" class="header">
    <form id="form" class="search">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <input id="q" placeholder="찾고 싶은 코드를 말로 설명해 보세요" />
      <button id="go" class="go" type="submit">검색</button>
      <div id="recent" class="recent" hidden></div>
    </form>
    <div id="bar" class="bar" hidden>
      <span id="summary" class="grow"></span>
      <span id="tools" class="tools" hidden>
        <span class="seg"><button id="vFull" type="button">자세히</button><button id="vCompact" type="button">간단히</button></span>
        <button id="copyRecord" class="ibtn" type="button" title="질문·순위·id·위치·유사도를 표로 복사"></button>
        <button id="clearResults" class="ibtn" type="button" title="결과 지우기"></button>
      </span>
    </div>
    <div id="filters" class="filters" hidden>
      <select id="fLang" title="언어로 거르기"></select>
      <select id="fProj" title="프로젝트로 거르기"></select>
    </div>
  </div>

  <div class="content">
    <div id="intro">
      <div class="intro">이렇게 물어보세요</div>
      <div id="chips" class="chips">
        <button type="button" class="chip">두 숫자를 더하는 함수</button>
        <button type="button" class="chip">리스트에서 짝수만 고르기</button>
        <button type="button" class="chip">나이순으로 정렬</button>
      </div>
      <button id="walk" class="link-btn" type="button">처음이면 시작하기 안내 보기</button>
    </div>
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
  const filtersBox = byId('filters'), fLang = byId('fLang'), fProj = byId('fProj');
  const intro = byId('intro'), chips = byId('chips'), list = byId('list'), banner = byId('banner');
  const histHead = byId('histHead'), histBody = byId('histBody'), toast = byId('toast');

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
    copy: ['M11 9h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z', 'M5 15V5a2 2 0 0 1 2-2h10'],
    record: ['M9 3h6v4H9z', 'M7 5H5v16h14V5h-2', 'M8 12h8', 'M8 16h5'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    chev: ['M9 6l6 6-6 6'],
    empty: ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z', 'M20 20l-3.5-3.5', 'M8 11h6'],
    alert: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M12 7v6', 'M12 16.5v.5'],
    clock: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M12 7v5l3 2'],
    check: ['M5 12l5 5L20 7'],
    diff: ['M4 4h6v16H4z', 'M14 4h6v16h-6z'],
  };

  // ── 상태
  let searching = false;     // 검색 응답을 기다리는 중이면 또 보내지 않는다
  let lastQuery = '';        // 다시 시도용
  let current = null;        // { query, results, restored } — results 에 원래 순위(rank)를 붙여 둔다
  let mode = { mock: true, apiUrl: '' };
  let prefs = { view: 'full', historyOpen: false };
  let filter = { lang: '', proj: '' };
  let recentItems = [];
  let activeIdx = -1;        // 키보드 ↑↓ 로 고른 최근 검색어 위치
  let historyItems = [];
  let toastTimer = 0;

  // 고정 아이콘 채우기
  copyRecordBtn.append(icon('record'), document.createTextNode('기록 복사'));
  clearBtn.append(icon('close'));
  vFull.classList.add('on');

  function setSearching(on) {
    searching = on;
    goBtn.disabled = on;
  }

  function search(query) {
    if (!query || searching) { return; }
    closeRecent();
    lastQuery = query;
    setSearching(true);
    intro.hidden = true;
    bar.hidden = false;
    tools.hidden = true;
    filtersBox.hidden = true;
    summary.textContent = '검색 중…';
    list.replaceChildren(el('div', 'skel'), el('div', 'skel'));
    vscode.postMessage({ type: 'search', query: query });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    search(input.value.trim());
  });

  // 예시 질문 → 검색창에 넣고 바로 검색
  chips.querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () {
      input.value = b.textContent;
      search(b.textContent);
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
    recentItems.forEach(function (q, idx) {
      const item = el('div', idx === activeIdx ? 'recent-item active' : 'recent-item', q);
      // mousedown: 검색창 blur(닫힘)보다 먼저 처리되게
      item.addEventListener('mousedown', function (e) { e.preventDefault(); pickRecent(q); });
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
  function pickRecent(q) {
    input.value = q;
    closeRecent();
    search(q);
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
    else if (e.key === 'Escape') { closeRecent(); }
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
  fLang.addEventListener('change', function () { filter.lang = fLang.value; renderResults(); });
  fProj.addEventListener('change', function () { filter.proj = fProj.value; renderResults(); });

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
    if (filter.lang || filter.proj) {
      lines.push('필터: ' + [filter.lang, filter.proj].filter(Boolean).join(', ') + ' (전체 ' + current.results.length + '개 중 ' + rows.length + '개)');
    }
    lines.push('', '| 순위 | id | 함수 | 위치 | 유사도 |', '|---|---|---|---|---|');
    rows.forEach(function (r) {
      lines.push('| ' + r.rank + ' | ' + r.id + ' | ' + (r.function_name || '-') + ' | ' + r.file_path + ':' + r.start_line + '-' + r.end_line +
        ' | ' + (typeof r.score === 'number' ? r.score.toFixed(3) : '-') + ' |');
    });
    vscode.postMessage({ type: 'copyText', text: lines.join('\\n') });
    flashLabel(copyRecordBtn, '복사됨 ✓', '기록 복사');
  });

  // ── 결과 지우기 → 처음 화면으로
  clearBtn.addEventListener('click', function () {
    current = null;
    filter = { lang: '', proj: '' };
    list.replaceChildren();
    bar.hidden = true;
    filtersBox.hidden = true;
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
        mode = { mock: !!msg.mock, apiUrl: msg.apiUrl || '' };
        banner.hidden = !msg.mock;
        break;
      case 'prefs':
        prefs = Object.assign({ view: 'full', historyOpen: false }, msg.prefs || {});
        vFull.classList.toggle('on', prefs.view === 'full');
        vCompact.classList.toggle('on', prefs.view === 'compact');
        renderHistory();
        if (current) { renderResults(); }
        break;
      case 'recent':
        recentItems = msg.items || [];
        if (!recentBox.hidden) { renderRecent(); }
        break;
      case 'history':
        historyItems = msg.items || [];
        renderHistory();
        break;
      case 'saved':
        showToast(msg.record);
        break;
      case 'runSearch':
        input.value = msg.query;
        search(msg.query);
        break;
      case 'focus':
        input.focus();
        input.select();
        break;
      case 'restore':
        input.value = msg.query;
        lastQuery = msg.query;
        setResults(msg.query, msg.results, true);
        break;
      case 'results':
        setSearching(false);
        if (msg.query) { lastQuery = msg.query; }
        setResults(lastQuery, msg.results, false);
        break;
      case 'error':
        setSearching(false);
        showError(msg.title, msg.detail, msg.kind);
        break;
    }
  });

  function setResults(query, results, restored) {
    // 원래 순위를 붙여 둔다 — 필터로 걸러도 서버 순위가 그대로 보이게
    current = { query: query, restored: restored, results: results.map(function (r, i) { return Object.assign({ rank: i + 1 }, r); }) };
    filter = { lang: '', proj: '' };
    intro.hidden = true;
    bar.hidden = false;
    buildFilters();
    renderResults();
  }

  function visibleResults() {
    if (!current) { return []; }
    return current.results.filter(function (r) {
      return (!filter.lang || r.language === filter.lang) && (!filter.proj || (r.project_name || '(없음)') === filter.proj);
    });
  }

  function buildFilters() {
    const langs = unique(current.results.map(function (r) { return r.language; }));
    const projs = unique(current.results.map(function (r) { return r.project_name || '(없음)'; }));
    fillSelect(fLang, '모든 언어', langs);
    fillSelect(fProj, '모든 프로젝트', projs);
    fLang.hidden = langs.length < 2;
    fProj.hidden = projs.length < 2;
    filtersBox.hidden = fLang.hidden && fProj.hidden;
  }
  function fillSelect(sel, allLabel, values) {
    sel.replaceChildren();
    const all = el('option', '', allLabel);
    all.value = '';
    sel.append(all);
    values.forEach(function (v) {
      const o = el('option', '', v);
      o.value = v;
      sel.append(o);
    });
    sel.value = '';
  }

  function renderResults() {
    list.replaceChildren();
    if (!current.results.length) {
      tools.hidden = true;
      summary.textContent = current.restored ? '지난 검색' : '';
      list.append(emptyState());
      return;
    }
    tools.hidden = false;
    const rows = visibleResults();
    let text = '결과 ' + rows.length + '개';
    if (rows.length !== current.results.length) { text += ' · 전체 ' + current.results.length + '개 중'; }
    if (current.restored) { text = '지난 검색 · ' + text; }
    // mock 결과는 검색어와 상관없는 샘플 — 좁은 화면에서도 보이게 짧게, 자세한 설명은 마우스 올리면
    if (mode.mock) { text = (current.restored ? '지난 검색 · ' : '') + 'mock 샘플 ' + rows.length + '개'; }
    summary.textContent = text;
    summary.title = mode.mock ? 'mock 모드라서 검색어와 상관없이 같은 샘플이 나옵니다' : '';

    if (!rows.length) {
      const s = el('div', 'state');
      s.append(el('strong', '', '필터에 맞는 결과가 없습니다'));
      const btns = el('div', 'btns');
      btns.append(sbtn('필터 해제', false, function () { filter = { lang: '', proj: '' }; fLang.value = ''; fProj.value = ''; renderResults(); }));
      s.append(btns);
      list.append(s);
      return;
    }
    rows.forEach(function (r, i) {
      if (prefs.view === 'compact') {
        list.append(compactRow(r, i));
      } else {
        if (i > 0) { list.append(el('div', 'divider')); }
        list.append(card(r, i));
      }
    });
  }

  // F. 결과 없음
  function emptyState() {
    const s = el('div', 'state');
    s.append(icon('empty'), el('strong', '', '결과가 없습니다'),
      el('div', '', '벡터가 준비된 스니펫만 검색돼요.'),
      el('div', '', '방금 저장했다면 저장 알림을 확인하세요.'));
    const btns = el('div', 'btns');
    btns.append(
      sbtn('다른 말로 검색', false, function () { input.focus(); input.select(); }),
      sbtn('모드 바꾸기', false, function () { vscode.postMessage({ type: 'switchMode' }); })
    );
    s.append(btns);
    return s;
  }

  // G. 오류 — 아이콘 + 다시 시도
  function showError(title, detail, kind) {
    current = null;
    tools.hidden = true;
    filtersBox.hidden = true;
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
      ? '이 PC 에서 ' + (r.project_name || '(프로젝트 없음)') + ' 폴더가 열려 있지 않습니다'
      : '열린 프로젝트 폴더에 이 파일이 없습니다';
    return { where: r.file_path + ' : ' + range, canOpen: canOpen, why: why };
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
    if (info.canOpen) {
      const link = el('a', '', info.where);
      link.href = '#';
      link.title = '원본 열기';
      link.addEventListener('click', function (e) { e.preventDefault(); openResult(r); });
      loc.append(link);
    } else {
      const tag = el('span', 'tag', '원본 없음');
      tag.title = info.why;
      loc.append(el('span', 'loc-off', info.where), tag);
    }

    // 3줄: 언어 색 점 · 언어 · 프로젝트 · id (Swagger 결과와 대조용)
    const sub = el('div', 'sub');
    sub.append(langDot(r.language), el('span', '', r.language + ' · ' + (r.project_name || '-') + ' · id ' + r.id));
    c.append(head, loc, sub);

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
    const openBtn = action('open', '원본 열기', function () { openResult(r); });
    if (!info.canOpen) { openBtn.disabled = true; openBtn.title = info.why; }
    const copyBtn = action('copy', '복사', function () { copyCode(r, copyBtn); });
    acts.append(openBtn, action('insert', '삽입', function () { insertCode(r); }), copyBtn,
      action('diff', '비교', function () { compareResult(r); }));
    c.append(acts);

    keyboard(c, r, i, info.canOpen, function () { copyBtn.click(); });
    return c;
  }

  // C. 간단히 보기 — 한 줄
  function compactRow(r, i) {
    const info = locInfo(r);
    const c = el('div', 'card compact' + (r.rank === 1 ? ' top' : '') + (info.canOpen ? '' : ' off'));
    const where = el('span', info.canOpen ? 'where ok' : 'where', info.where);
    c.append(el('span', 'rank', String(r.rank)), langDot(r.language), el('span', 'name', nameOf(r)), where, simEl(r));
    c.title = (info.canOpen ? '눌러서 원본 열기' : info.why) + ' · ↑↓ 이동 · C 복사 · I 삽입 · D 비교 · Esc 검색창';
    c.addEventListener('click', function () { if (info.canOpen) { openResult(r); } });
    keyboard(c, r, i, info.canOpen, function () { copyCode(r, null); showToast({ status: 'copy', function_name: nameOf(r) }); });
    return c;
  }

  // 키보드: ↑↓ 이동, Enter 원본 열기, C 복사, I 삽입, Esc 검색창
  function keyboard(c, r, i, canOpen, onCopy) {
    c.tabIndex = 0;
    if (!c.title) { c.title = '↑↓ 이동 · Enter 원본 열기 · C 복사 · I 삽입 · D 비교 · Esc 검색창'; }
    c.addEventListener('keydown', function (e) {
      if (e.target !== c) { return; }   // 카드 안 버튼에 포커스가 있으면 버튼 기본 동작
      const k = e.key.toLowerCase();
      if (e.key === 'ArrowDown') { e.preventDefault(); focusCard(i + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (!focusCard(i - 1)) { input.focus(); } }
      else if (e.key === 'Enter') { e.preventDefault(); if (canOpen) { openResult(r); } }
      else if (k === 'c') { e.preventDefault(); onCopy(); }
      else if (k === 'i') { e.preventDefault(); insertCode(r); }
      else if (k === 'd') { e.preventDefault(); compareResult(r); }
      else if (e.key === 'Escape') { e.preventDefault(); input.focus(); }
    });
  }

  // n 번째 카드에 포커스. 없으면 false
  function focusCard(n) {
    const cards = list.querySelectorAll('.card');
    if (n < 0 || n >= cards.length) { return false; }
    cards[n].focus();
    cards[n].scrollIntoView({ block: 'nearest' });
    return true;
  }

  function openResult(r) { vscode.postMessage({ type: 'open', result: r }); }
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
      row.append(el('span', 'fnm', name), el('span', 'meta', parts.join(' · ')), pill);
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
  // 준비됐다고 알리면 확장 본체가 설정·최근 검색어·저장 기록·지난 검색을 보내준다
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
