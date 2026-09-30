import * as vscode from 'vscode';
import { SearchViewProvider } from './sidebar';
// ─────────────────────────────────────────────
// 1. 스니펫의 모양 — 팀이 정한 JSON 형식
// ─────────────────────────────────────────────
export interface Snippet {
  project_name: string | null;
  file_path: string;          // 프로젝트 기준 상대 경로 (예: src/Main.java)
  absolute_path: string;      // ※ 팀 스펙 외 추가 — 나중에 "원본 파일로 이동"에 필요
  language: string;
  function_name: string | null;
  start_line: number;
  end_line: number;
  code: string;
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
// ─────────────────────────────────────────────
function collectSnippet(): Snippet | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('열려 있는 편집기가 없습니다.');
    return null;
  }
  if (editor.selection.isEmpty) {
    vscode.window.showWarningMessage('저장할 코드를 먼저 선택하세요.');
    return null;
  }

  const doc = editor.document;
  const sel = editor.selection;
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
    project_name: vscode.workspace.getWorkspaceFolder(doc.uri)?.name ?? null,
    file_path: vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/'),
    absolute_path: doc.uri.fsPath,
    language: doc.languageId,
    function_name: findFunctionName(doc, sel.start.line),
    start_line: sel.start.line + 1,   // VS Code 는 0부터 센다 → 사람 기준 1부터로
    end_line: endLine + 1,
    code,
  };
}

// ─────────────────────────────────────────────
// 4. 백엔드 전송 — POST /snippets
//    mock 설정이 켜져 있으면 서버 없이 가짜 응답
// ─────────────────────────────────────────────
async function postSnippet(snippet: Snippet): Promise<{ id: number }> {
  const config = vscode.workspace.getConfiguration('codeMemory');

  if (config.get<boolean>('mock', true)) {
    await new Promise((resolve) => setTimeout(resolve, 200));   // 네트워크 흉내
    return { id: Date.now() };
  }

  const baseUrl = config.get<string>('apiUrl', 'http://localhost:8000');
  const res = await fetch(`${baseUrl}/snippets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snippet),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as { id: number };
}

// ─────────────────────────────────────────────
// 5. 확장 시작점 — package.json 의 명령·패널 ID 와 실제 동작을 연결
// ─────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  const command = vscode.commands.registerCommand('codeMemory.saveSnippet', async () => {
    const snippet = collectSnippet();
    if (!snippet) {
      return;
    }

    output.appendLine(`[${new Date().toLocaleTimeString()}] 수집한 스니펫`);
    output.appendLine(JSON.stringify(snippet, null, 2));

    try {
      const saved = await postSnippet(snippet);
      const where = snippet.function_name ?? snippet.file_path;
      vscode.window.showInformationMessage(`저장했습니다 (id ${saved.id}) — ${where}`);
      output.appendLine(`→ 저장 완료 id=${saved.id}\n`);
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