import * as vscode from 'vscode';

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
  score: number;   // 의미(유사도/거리)·범위는 #12 계약에서 확정
}

// mock 결과 — 문서 12쪽 테스트 파일 3개 (C:\dev\mvp-save-test 에 실제로 있어야 "원본 열기"가 됨)
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
async function searchSnippets(query: string): Promise<SearchResult[]> {
  const config = vscode.workspace.getConfiguration('codeMemory');

  if (config.get<boolean>('mock', true)) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return MOCK_RESULTS;   // mock 은 검색어와 상관없이 샘플 3개
  }

  // ※ 경로·파라미터·응답 모양은 아직 공식 계약 전 초안. #12 합의 후 여기만 맞추면 된다.
  const baseUrl = config.get<string>('apiUrl', 'http://localhost:8000').replace(/\/+$/, '');
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&limit=10`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  } catch (err) {
    // 서버 꺼짐 / 주소 틀림 / 10초 동안 응답 없음
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`서버에 연결할 수 없습니다: ${baseUrl} (${reason})`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  // 응답이 예상한 모양이 아니면 빈 결과로 넘기지 말고 오류로 보여준다
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`응답이 JSON 이 아닙니다: ${text.slice(0, 200)}`);
  }
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    throw new Error(`응답에 results 배열이 없습니다: ${text.slice(0, 200)}`);
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
  // insertSnippet 대신 edit 을 쓰는 이유: 코드에 $ 가 있으면 스니펫 문법으로 해석돼서 깨짐
  await editor.edit((builder) => builder.replace(editor.selection, code));
}

type FromWebview =
  | { type: 'search'; query: string }
  | { type: 'open'; result: SearchResult }
  | { type: 'insert'; code: string }
  | { type: 'copy'; code: string };

// ─────────────────────────────────────────────
// 사이드바 패널 — VS Code 가 패널을 처음 보여줄 때 resolveWebviewView 를 부른다
// ─────────────────────────────────────────────
export class SearchViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'codeMemory.searchView';

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = getHtml(view.webview);

    // 웹페이지 → 확장 본체 메시지 받기
    view.webview.onDidReceiveMessage(async (msg: FromWebview) => {
      switch (msg.type) {
        case 'search': {
          try {
            const results = await searchSnippets(msg.query);
            view.webview.postMessage({ type: 'results', results });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            view.webview.postMessage({ type: 'error', message });
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
          await vscode.env.clipboard.writeText(msg.code);
          vscode.window.showInformationMessage('클립보드에 복사했습니다.');
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
  body { padding: 8px 10px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  form { display: flex; gap: 6px; margin-bottom: 6px; }
  input { flex: 1; min-width: 0; padding: 4px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
  input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  button { padding: 4px 10px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; border-radius: 2px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .status { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 4px 0 10px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; margin-bottom: 8px; }
  .head { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
  .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .score { font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 2px 0 6px; overflow-wrap: anywhere; }
  pre.code { margin: 0 0 6px; padding: 6px; max-height: 120px; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-textCodeBlock-background); border-radius: 3px; }
  .actions { display: flex; gap: 4px; }
  .actions button { padding: 2px 8px; font-size: 12px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .actions button:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
  <form id="form">
    <input id="q" placeholder="찾고 싶은 코드를 말로 설명해 보세요" />
    <button type="submit">검색</button>
  </form>
  <div id="status" class="status">예: 배열 중복 제거, 파일 경로에서 확장자 빼기</div>
  <div id="list"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const form = document.getElementById('form');
  const input = document.getElementById('q');
  const list = document.getElementById('list');
  const statusEl = document.getElementById('status');

  // 검색 버튼 → 확장 본체에 "검색해줘"
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    const query = input.value.trim();
    if (!query) { return; }
    statusEl.textContent = '검색 중…';
    list.replaceChildren();
    vscode.postMessage({ type: 'search', query: query });
  });

  // 확장 본체 → "결과 여기 있어"
  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg.type === 'results') { render(msg.results); }
    else if (msg.type === 'error') { statusEl.textContent = '검색 실패: ' + msg.message; }
  });

  function render(results) {
    list.replaceChildren();
    if (!results.length) { statusEl.textContent = '결과가 없습니다.'; return; }
    statusEl.textContent = results.length + '개 찾음';

    results.forEach(function (r) {
      const name = r.function_name || String(r.file_path || '').split('/').pop() || '(이름 없음)';
      const card = el('div', 'card');

      const head = el('div', 'head');
      // score 는 퍼센트(정확도)가 아니다. 뜻(유사도/거리)이 계약으로 정해지기 전까지 숫자만 그대로 보여준다
      const scoreText = typeof r.score === 'number' ? 'score ' + r.score.toFixed(3) : '';
      head.append(el('span', 'name', name), el('span', 'score', scoreText));

      const meta = el('div', 'meta',
        (r.project_name || '-') + ' · ' + r.language + ' · ' + r.file_path + ':' + r.start_line);

      const actions = el('div', 'actions');
      actions.append(
        button('원본 열기', function () { vscode.postMessage({ type: 'open', result: r }); }),
        button('삽입', function () { vscode.postMessage({ type: 'insert', code: r.code }); }),
        button('복사', function () { vscode.postMessage({ type: 'copy', code: r.code }); })
      );

      card.append(head, meta, el('pre', 'code', r.code), actions);
      list.append(card);
    });
  }

  // textContent 로만 넣는다 — 코드 안에 <script> 같은 게 있어도 실행되지 않게
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    node.className = cls;
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function button(label, onClick) {
    const b = el('button', '', label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
</script>
</body>
</html>`;
}