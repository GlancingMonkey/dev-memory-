import * as vscode from 'vscode';
import { SaveRecord, SearchViewProvider } from './sidebar';
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
// 저장 요청 제한 시간. 첫 저장은 모델 준비로 오래 걸릴 수 있어 팀 합의(3쪽) 후 조정한다.
const SAVE_TIMEOUT_MS = 10000;

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
      signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
    });
  } catch (err) {
    // 시간 초과: 서버는 이미 저장했을 수 있다 → 다시 보내지 말고 확인부터 하게 안내
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(
        `응답 시간 초과 (${SAVE_TIMEOUT_MS / 1000}초). 서버에는 저장됐을 수 있으니 다시 누르지 말고 서버 로그·DB 를 먼저 확인하세요.`
      );
    }
    // 서버가 꺼져 있음 / 주소 틀림
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
// 저장 요청이 진행 중인지 — 기다리는 동안 또 눌러서 중복 저장되는 걸 막는다
let saving = false;

export function activate(context: vscode.ExtensionContext) {
  const searchProvider = new SearchViewProvider(context.workspaceState);

  const command = vscode.commands.registerCommand('codeMemory.saveSnippet', async () => {
    if (saving) {
      vscode.window.showWarningMessage('이전 저장이 아직 진행 중입니다. 끝난 뒤 다시 시도하세요.');
      return;
    }

    const collected = collectSnippet();
    if (!collected) {
      return;
    }
    const { snippet, absolutePath } = collected;

    saving = true;
    try {
      // 설정이 켜져 있으면 저장 전에 함수 이름 확인 (정규식 자동 추출이 틀릴 수 있다)
      if (vscode.workspace.getConfiguration('codeMemory').get<boolean>('confirmFunctionName', false)) {
        const name = await vscode.window.showInputBox({
          title: 'Code Memory: 함수 이름 확인',
          value: snippet.function_name ?? '',
          prompt: '자동으로 찾은 이름입니다. 고치거나 그대로 Enter — 비우면 이름 없이 저장, Esc 는 저장 취소',
          placeHolder: '함수 이름 (비워도 됨)',
        });
        if (name === undefined) {
          vscode.window.setStatusBarMessage('Code Memory: 저장 취소', 3000);
          return;
        }
        snippet.function_name = name.trim() || null;
      }

      output.appendLine(`[${new Date().toLocaleTimeString()}] 보낼 스니펫 (원본: ${absolutePath})`);
      output.appendLine(JSON.stringify(snippet, null, 2));

      const where = snippet.function_name ?? snippet.file_path;
      // "검색에서 확인" 버튼: 함수 이름(없으면 파일 이름)으로 바로 검색
      const query = snippet.function_name ?? snippet.file_path.split('/').pop() ?? snippet.file_path;
      const offerSearch = (text: string) => {
        // await 하지 않는다 — 알림이 떠 있는 동안 다음 저장이 막히지 않게
        void vscode.window.showInformationMessage(text, '검색에서 확인').then((choice) => {
          if (choice) {
            void searchProvider.searchFor(query);
          }
        });
      };
      // 사이드바 "저장 기록"에 남길 공통 정보
      const base: Omit<SaveRecord, 'status'> = {
        time: new Date().toISOString(),
        function_name: snippet.function_name,
        file_path: snippet.file_path,
        start_line: snippet.start_line,
        end_line: snippet.end_line,
      };

      try {
        const saved = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Code Memory: 저장 중…' },
          () => postSnippet(snippet)
        );
        output.appendLine(`→ ${saved.detail}`);

        if (saved.mock) {
          output.appendLine(`→ [mock] 실제 저장 아님 (가짜 id=${saved.id})\n`);
          offerSearch(`[mock] 저장 흉내만 냈습니다 — ${where}`);
          await searchProvider.addSaveRecord({ ...base, status: 'mock' });
        } else {
          output.appendLine(`→ 저장 완료 id=${saved.id}\n`);
          offerSearch(`저장했습니다 (id ${saved.id}) — ${where}`);
          await searchProvider.addSaveRecord({ ...base, status: 'ok', id: saved.id });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`→ 저장 실패: ${message}\n`);
        vscode.window.showErrorMessage(`저장 실패: ${message}`);
        await searchProvider.addSaveRecord({ ...base, status: 'fail', error: message.slice(0, 120) });
      }

      output.show(true);
    } finally {
      saving = false;
    }
  });

  // 사이드바 검색 패널 등록
  // retainContextWhenHidden: 다른 사이드바 탭 갔다 와도 검색 결과가 안 날아가게
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SearchViewProvider.viewId,
      searchProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ─────────────────────────────────────────────
  // 상태 표시줄: mock 인지, 실제 서버면 연결됐는지 (GET /health) 항상 보이게.
  // 누르면 mock / 실제 서버 / 주소 바꾸기를 고르는 창이 뜬다.
  // ─────────────────────────────────────────────
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.command = 'codeMemory.switchMode';
  let healthSeq = 0;   // 확인 요청이 겹치면 마지막 것만 반영

  const updateStatus = async () => {
    const config = vscode.workspace.getConfiguration('codeMemory');
    const seq = ++healthSeq;
    if (config.get<boolean>('mock', true)) {
      status.text = '$(beaker) Code Memory: mock';
      status.tooltip = 'mock 모드 — 서버를 호출하지 않습니다 (가짜 저장·샘플 검색). 눌러서 모드 바꾸기';
      status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }
    const apiUrl = config.get<string>('apiUrl', 'http://localhost:8000').replace(/\/+$/, '');
    const host = apiUrl.replace(/^https?:\/\//, '');
    status.text = `$(sync~spin) Code Memory: ${host}`;
    status.tooltip = `${apiUrl} 연결 확인 중…`;
    status.backgroundColor = undefined;

    let ok = false;
    let reason = '';
    try {
      const res = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(3000) });
      ok = res.ok;
      reason = ok ? '' : `HTTP ${res.status}`;
    } catch (err) {
      reason = err instanceof Error && err.name === 'TimeoutError' ? '3초 동안 응답 없음' : '연결할 수 없음';
    }
    if (seq !== healthSeq) {
      return;   // 그 사이 설정이 바뀌었으면 이 결과는 버린다
    }
    if (ok) {
      status.text = `$(pass-filled) Code Memory: ${host}`;
      status.tooltip = `실제 서버 ${apiUrl} 연결됨 (/health 응답 정상 — DB 저장 성공까지 뜻하지는 않음). 눌러서 모드 바꾸기`;
      status.backgroundColor = undefined;
    } else {
      status.text = `$(error) Code Memory: ${host} 연결 안 됨`;
      status.tooltip = `${apiUrl}/health 확인 실패 (${reason}). 서버 실행·주소·포트 전달을 확인하세요. 눌러서 모드 바꾸기`;
      status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
  };

  void updateStatus();
  status.show();
  const healthTimer = setInterval(() => {
    if (!vscode.workspace.getConfiguration('codeMemory').get<boolean>('mock', true)) {
      void updateStatus();   // 실제 서버 모드일 때만 30초마다 다시 확인
    }
  }, 30000);
  context.subscriptions.push(
    status,
    { dispose: () => clearInterval(healthTimer) },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codeMemory')) {
        void updateStatus();
      }
    })
  );

  // 모드 빠르게 바꾸기 (상태 표시줄 클릭)
  const switchMode = vscode.commands.registerCommand('codeMemory.switchMode', async () => {
    const config = vscode.workspace.getConfiguration('codeMemory');
    const mock = config.get<boolean>('mock', true);
    const apiUrl = config.get<string>('apiUrl', 'http://localhost:8000');
    // 워크스페이스에 값이 따로 있으면 거기를, 아니면 사용자 설정을 바꾼다
    const targetOf = (key: string) =>
      config.inspect(key)?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

    type Item = vscode.QuickPickItem & { id: 'mock' | 'real' | 'url' | 'health' | 'settings' };
    const items: Item[] = [
      { id: 'mock', label: '$(beaker) mock', description: mock ? '현재' : '', detail: '서버를 호출하지 않음 — 가짜 저장, 샘플 검색' },
      { id: 'real', label: '$(plug) 실제 서버', description: mock ? '' : '현재', detail: apiUrl },
      { id: 'url', label: '$(edit) 서버 주소 바꾸기…' },
      { id: 'health', label: '$(refresh) 연결 다시 확인' },
      { id: 'settings', label: '$(gear) 설정 열기' },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: 'Code Memory 모드' });
    if (!pick) {
      return;
    }
    switch (pick.id) {
      case 'mock':
        await config.update('mock', true, targetOf('mock'));
        break;
      case 'real':
        await config.update('mock', false, targetOf('mock'));
        break;
      case 'url': {
        const value = await vscode.window.showInputBox({
          title: '백엔드 서버 주소',
          value: apiUrl,
          prompt: '예: http://127.0.0.1:8000',
          validateInput: (v) => (/^https?:\/\/[^\s]+$/.test(v.trim()) ? undefined : 'http:// 또는 https:// 로 시작하는 주소를 입력하세요'),
        });
        if (value) {
          await config.update('apiUrl', value.trim().replace(/\/+$/, ''), targetOf('apiUrl'));
        }
        break;
      }
      case 'health':
        await updateStatus();
        break;
      case 'settings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'codeMemory');
        break;
    }
  });

  // 선택한 코드로 비슷한 코드 찾기 (우클릭 메뉴) — 기존 검색 API 를 그대로 쓰고 코드 자체를 질문으로 보낸다
  const findSimilar = vscode.commands.registerCommand('codeMemory.findSimilar', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showWarningMessage('비교할 코드를 먼저 선택하세요.');
      return;
    }
    // 줄바꿈·연속 공백은 한 칸으로, 너무 길면 앞부분만 (주소 길이 제한·모델 입력 제한)
    const query = editor.document.getText(editor.selection).replace(/\s+/g, ' ').trim().slice(0, 1000);
    if (!query) {
      vscode.window.showWarningMessage('공백만 선택되었습니다.');
      return;
    }
    await searchProvider.searchFor(query);
  });
  context.subscriptions.push(switchMode, findSimilar);

  // 단축키(Ctrl+Alt+F) → 검색창에 커서
  const focusCommand = vscode.commands.registerCommand('codeMemory.focusSearch', () => searchProvider.focusSearch());

  context.subscriptions.push(command, focusCommand, output);
}

export function deactivate() {}