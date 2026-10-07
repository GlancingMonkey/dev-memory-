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
  score: number;   // 0~1, 클수록 비슷함
}

// mock 결과 — 실제로 존재하는 파일·줄을 가리키게 해서 "원본 열기"도 테스트되게 함
const MOCK_RESULTS: SearchResult[] = [
  {
    id: 1,
    project_name: 'capstone-rag',
    file_path: 'extension/src/extension.ts',
    absolute_path: '/workspaces/capstone-rag/extension/src/extension.ts',
    language: 'typescript',
    function_name: 'findFunctionName',
    start_line: 57,
    end_line: 73,
    code: 'function findFunctionName(doc: vscode.TextDocument, fromLine: number): string | null {\n  const patterns = DECL_PATTERNS[doc.languageId];\n  if (!patterns) {\n    return null;\n  }',
    score: 0.91,
  },
  {
    id: 2,
    project_name: 'capstone-rag',
    file_path: 'extension/src/extension.ts',
    absolute_path: '/workspaces/capstone-rag/extension/src/extension.ts',
    language: 'typescript',
    function_name: 'collectSnippet',
    start_line: 79,
    end_line: 132,
    code: 'function collectSnippet(): Collected | null {\n  const editor = vscode.window.activeTextEditor;\n  if (!editor) {',
    score: 0.84,
  },
  {
    id: 3,
    project_name: 'capstone-rag',
    file_path: 'extension/src/extension.ts',
    absolute_path: '/workspaces/capstone-rag/extension/src/extension.ts',
    language: 'typescript',
    function_name: 'postSnippet',
    start_line: 144,
    end_line: 197,
    code: 'async function postSnippet(snippet: Snippet): Promise<SaveResult> {\n  const config = vscode.workspace.getConfiguration(\'codeMemory\');',
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

  const baseUrl = config.get<string>('apiUrl', 'http://localhost:8000');
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&limit=10`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { results: SearchResult[] };
  return data.results;
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
    vscode.window.showWarningMessage('원본 파일 위치를 알 수 없습니다.');
    return;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const start = Math.max(0, r.start_line - 1);                  // 1부터 → 0부터로
    const end = Math.min(doc.lineCount - 1, r.end_line - 1);
    const range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
    await vscode.window.showTextDocument(doc, { selection: range, preview: false });
  } catch {
    vscode.window.showWarningMessage(`원본 파일을 찾을 수 없습니다: ${r.file_path}`);
  }
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
      const name = r.function_name || r.file_path.split('/').pop();
      const card = el('div', 'card');

      const head = el('div', 'head');
      head.append(el('span', 'name', name), el('span', 'score', Math.round(r.score * 100) + '%'));

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