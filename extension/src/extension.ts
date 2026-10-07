import * as vscode from 'vscode';
import { SearchViewProvider } from './sidebar';
// ─────────────────────────────────────────────
// 1. 스니펫의 모양
//    Snippet   = 백엔드로 "보내는" 객체. 계약의 7개 필드만 들어간다.
//    Collected = 수집 결과. 보내는 객체 + 내 PC 에서만 쓰는 정보(절대 경로).
// ─────────────────────────────────────────────
export interface Snippet {
  project_name: string;
  file_path: string;          // Workspace 폴더 기준 상대 경로, 구분자는 /
  language: string;
  function_name: string | null;
  start_line: number;
  end_line: number;
  code: string;
}

interface Collected {
  snippet: Snippet;
  absolutePath: string;       // 로컬 전용 — POST 에 넣지 않는다
}

// 결과를 찍어볼 "출력" 패널 채널
const output = vscode.window.createOutputChannel('Code Memory');

// ─────────────────────────────────────────────
// 2. 함수 이름 찾기
//    선택한 줄에서 위로 올라가며 가장 가까운 함수/클래스 선언을 찾는다.
//    정규식 기반이라 완벽하지 않다. 못 찾으면 null.
// ─────────────────────────────────────────────
const DECL_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /\bfunction\s+(\w+)/,
    /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/,
    /^\s*(?:(?:public|private|protected|static|async)\s+)*(\w+)\s*\([^)]*\)\s*(?::\s*[^={]+)?\{/,
    /\bclass\s+(\w+)/,
  ],
  javascript: [
    /\bfunction\s+(\w+)/,
    /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/,
    /^\s*(?:(?:static|async)\s+)*(\w+)\s*\([^)]*\)\s*\{/,
    /\bclass\s+(\w+)/,
  ],
  python: [
    /^\s*(?:async\s+)?def\s+(\w+)/,
    /^\s*class\s+(\w+)/,
  ],
  java: [
    /^\s*(?!return\b|new\b|else\b|throw\b)(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)*[\w<>\[\]]+\s+(\w+)\s*\(/,
    /\bclass\s+(\w+)/,
  ],
};

// if (...) { 같은 걸 함수로 착각하지 않게 걸러낸다
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'else']);

function findFunctionName(doc: vscode.TextDocument, fromLine: number): string | null {
  const patterns = DECL_PATTERNS[doc.languageId];
  if (!patterns) {
    return null;   // 지원 안 하는 언어
  }

  for (let i = fromLine; i >= 0 && i > fromLine - 80; i--) {
    const text = doc.lineAt(i).text;
    for (const re of patterns) {
      const m = text.match(re);
      if (m?.[1] && !KEYWORDS.has(m[1])) {
        return m[1];
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// 3. 정보 수집 — 선택한 코드 + 그 코드가 어디서 왔는지
//    저장하면 안 되는 경우(새 파일, 폴더 밖 파일, 빈 선택)는 여기서 막는다.
// ─────────────────────────────────────────────
function collectSnippet(): Collected | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('열려 있는 편집기가 없습니다.');
    return null;
  }

  const doc = editor.document;
  const sel = editor.selection;

  // 아직 디스크에 저장 안 된 새 파일(Untitled) → 경로가 없으니 차단
  if (doc.isUntitled) {
    vscode.window.showWarningMessage('아직 저장되지 않은 새 파일입니다. 프로젝트 폴더 안에 파일로 저장한 뒤 다시 시도하세요.');
    return null;
  }

  // 열려 있는 프로젝트 폴더(Workspace)에 속하지 않은 파일 → 프로젝트명을 알 수 없으니 차단
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) {
    vscode.window.showWarningMessage('프로젝트 폴더에 속한 파일이 아닙니다. [파일 > 폴더 열기]로 프로젝트 폴더를 연 뒤 그 안의 파일에서 저장하세요.');
    return null;
  }

  if (sel.isEmpty) {
    vscode.window.showWarningMessage('저장할 코드를 먼저 선택하세요.');
    return null;
  }

  const code = doc.getText(sel);
  if (code.trim().length === 0) {
    vscode.window.showWarningMessage('공백만 선택되었습니다.');
    return null;
  }

  // 여러 줄을 끌어서 선택하면 커서가 "다음 줄 맨 앞"에서 끝나는 경우가 많다.
  // 그대로 두면 end_line 이 실제보다 한 줄 커지므로 보정.
  let endLine = sel.end.line;
  if (sel.end.character === 0 && sel.end.line > sel.start.line) {
    endLine -= 1;
  }

  return {
    snippet: {
      project_name: folder.name,
      file_path: vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/'),
      language: doc.languageId,
      function_name: findFunctionName(doc, sel.start.line),
      start_line: sel.start.line + 1,   // VS Code 는 0부터 센다 → 사람 기준 1부터로
      end_line: endLine + 1,
      code,
    },
    absolutePath: doc.uri.fsPath,
  };
}

// ─────────────────────────────────────────────
// 4. 백엔드 전송 — POST /snippets
//    mock 설정이 켜져 있으면 서버를 아예 호출하지 않는다 (가짜 응답).
// ─────────────────────────────────────────────
interface SaveResult {
  id: number;
  mock: boolean;      // true 면 실제 저장이 아니다
  detail: string;     // 출력 패널에 남길 근거 (주소, HTTP 상태, 응답 원문)
}

async function postSnippet(snippet: Snippet): Promise<SaveResult> {
  const config = vscode.workspace.getConfiguration('codeMemory');

  if (config.get<boolean>('mock', true)) {
    await new Promise((resolve) => setTimeout(resolve, 200));   // 네트워크 흉내
    return { id: Date.now(), mock: true, detail: 'mock=true — 서버 호출 안 함' };
  }

  const baseUrl = config.get<string>('apiUrl', 'http://localhost:8000').replace(/\/+$/, '');
  const url = `${baseUrl}/snippets`;

  // 계약의 7개 필드만 골라서 보낸다 (객체를 통째로 넘기지 않는다)
  const body = {
    project_name: snippet.project_name,
    file_path: snippet.file_path,
    language: snippet.language,
    function_name: snippet.function_name,
    start_line: snippet.start_line,
    end_line: snippet.end_line,
    code: snippet.code,
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    // 서버가 꺼져 있음 / 주소 틀림 / 10초 동안 응답 없음
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`서버에 연결할 수 없습니다: ${url} (${reason})`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  // 성공 응답인데 id 가 없으면 성공으로 치지 않는다
  let id: unknown;
  try {
    id = (JSON.parse(text) as { id?: unknown }).id;
  } catch {
    id = undefined;
  }
  if (typeof id !== 'number') {
    throw new Error(`응답에 id 가 없습니다: HTTP ${res.status} ${text}`);
  }

  return { id, mock: false, detail: `POST ${url} → HTTP ${res.status} ${text}` };
}

// ─────────────────────────────────────────────
// 5. 확장 시작점 — package.json 의 명령·패널 ID 와 실제 동작을 연결
// ─────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  const command = vscode.commands.registerCommand('codeMemory.saveSnippet', async () => {
    const collected = collectSnippet();
    if (!collected) {
      return;
    }
    const { snippet, absolutePath } = collected;

    output.appendLine(`[${new Date().toLocaleTimeString()}] 보낼 스니펫 (원본: ${absolutePath})`);
    output.appendLine(JSON.stringify(snippet, null, 2));

    try {
      const saved = await postSnippet(snippet);
      const where = snippet.function_name ?? snippet.file_path;
      output.appendLine(`→ ${saved.detail}`);

      if (saved.mock) {
        output.appendLine(`→ [mock] 실제 저장 아님 (가짜 id=${saved.id})\n`);
        vscode.window.showInformationMessage(`[mock] 저장 흉내만 냈습니다 — ${where}`);
      } else {
        output.appendLine(`→ 저장 완료 id=${saved.id}\n`);
        vscode.window.showInformationMessage(`저장했습니다 (id ${saved.id}) — ${where}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`→ 저장 실패: ${message}\n`);
      vscode.window.showErrorMessage(`저장 실패: ${message}`);
    }

    output.show(true);
  });

  // 사이드바 검색 패널 등록
  // retainContextWhenHidden: 다른 사이드바 탭 갔다 와도 검색 결과가 안 날아가게
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SearchViewProvider.viewId,
      new SearchViewProvider(),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(command, output);
}

export function deactivate() {}