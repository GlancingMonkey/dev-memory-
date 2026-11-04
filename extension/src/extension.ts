import * as vscode from 'vscode';
import { COMPARE_SCHEME, compareDocs, SaveRecord, SearchViewProvider } from './sidebar';
import {
  adjustEndLine, clamp, EmbeddingStatus, findFunctionNameByRegex, formatSeconds, parseSaveResponse, pickSymbol, SimpleSymbol,
} from './logic';
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
// 2. 함수 찾기
//    1순위: VS Code 가 알고 있는 코드 구조(개요 창에 나오는 기호). 언어 확장이 있으면 거의 정확하다.
//    2순위: 기호를 못 받으면(언어 확장 없음 등) 예전 정규식 방식 (logic.ts)
// ─────────────────────────────────────────────
function kindOf(kind: vscode.SymbolKind): SimpleSymbol['kind'] {
  switch (kind) {
    case vscode.SymbolKind.Function:
    case vscode.SymbolKind.Method:
    case vscode.SymbolKind.Constructor:
      return 'function';
    case vscode.SymbolKind.Class:
    case vscode.SymbolKind.Interface:
    case vscode.SymbolKind.Struct:
      return 'class';
    default:
      return 'other';
  }
}

function toSimpleSymbol(s: vscode.DocumentSymbol | vscode.SymbolInformation): SimpleSymbol {
  if ('children' in s) {
    return {
      name: s.name, kind: kindOf(s.kind),
      startLine: s.range.start.line, endLine: s.range.end.line,
      children: s.children.map(toSimpleSymbol),
    };
  }
  return {
    name: s.name, kind: kindOf(s.kind),
    startLine: s.location.range.start.line, endLine: s.location.range.end.line,
    children: [],
  };
}

async function getSymbols(doc: vscode.TextDocument): Promise<SimpleSymbol[]> {
  try {
    const result = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>(
      'vscode.executeDocumentSymbolProvider', doc.uri,
    );
    return (result ?? []).map(toSimpleSymbol);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────
// 3. 정보 수집 — 선택한 코드(없으면 커서가 있는 함수 전체) + 그 코드가 어디서 왔는지
//    저장하면 안 되는 경우(새 파일, 폴더 밖 파일, 빈 선택)는 여기서 막는다.
// ─────────────────────────────────────────────
async function collectSnippet(): Promise<Collected | null> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('열려 있는 편집기가 없습니다.');
    return null;
  }

  const doc = editor.document;

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

  const symbols = await getSymbols(doc);
  let sel: vscode.Selection = editor.selection;

  // 선택이 없으면 커서가 있는 함수 전체를 저장 대상으로 잡는다
  if (sel.isEmpty) {
    const { fn } = pickSymbol(symbols, sel.active.line);
    if (!fn) {
      vscode.window.showWarningMessage(
        symbols.length
          ? '커서가 함수 안에 있지 않습니다. 저장할 코드를 선택하거나 함수 안에 커서를 두세요.'
          : '저장할 코드를 먼저 선택하세요. (이 파일은 함수 자동 인식을 지원하지 않습니다)',
      );
      return null;
    }
    const endLine = Math.min(fn.endLine, doc.lineCount - 1);
    sel = new vscode.Selection(fn.startLine, 0, endLine, doc.lineAt(endLine).text.length);
    // 무엇을 저장했는지 보이게 에디터에서도 그 범위를 선택해 준다
    editor.selection = sel;
    editor.revealRange(sel, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  const code = doc.getText(sel);
  if (code.trim().length === 0) {
    vscode.window.showWarningMessage('공백만 선택되었습니다.');
    return null;
  }

  // 함수 이름: 코드 구조가 있으면 그걸 믿고(함수 → 없으면 클래스), 없으면 정규식
  const picked = pickSymbol(symbols, sel.start.line);
  const functionName = symbols.length
    ? (picked.fn?.name ?? picked.cls?.name ?? null)
    : findFunctionNameByRegex((i) => doc.lineAt(i).text, doc.languageId, sel.start.line);

  const endLine = adjustEndLine(sel.start.line, sel.end.line, sel.end.character);

  return {
    snippet: {
      project_name: folder.name,
      file_path: vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/'),
      language: doc.languageId,
      function_name: functionName,
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
//    제한 시간은 설정 codeMemory.saveTimeoutSeconds (팀이 실제 측정 후 정함). 걸린 시간을 출력에 남긴다.
// ─────────────────────────────────────────────
interface SaveResult {
  id: number;
  mock: boolean;                 // true 면 실제 저장이 아니다
  detail: string;                // 출력 패널에 남길 근거 (주소, HTTP 상태, 응답 원문)
  elapsedMs: number;             // 요청~응답까지 걸린 시간
  embedding?: EmbeddingStatus;   // 서버가 알려준 검색 준비 상태 (pending / ready / failed)
  embeddingError?: string;
}

async function postSnippet(snippet: Snippet): Promise<SaveResult> {
  const config = vscode.workspace.getConfiguration('codeMemory');
  const started = Date.now();

  if (config.get<boolean>('mock', true)) {
    await new Promise((resolve) => setTimeout(resolve, 200));   // 네트워크 흉내
    return { id: Date.now(), mock: true, detail: 'mock=true — 서버 호출 안 함', elapsedMs: Date.now() - started };
  }

  const baseUrl = config.get<string>('apiUrl', 'http://localhost:8000').replace(/\/+$/, '');
  const url = `${baseUrl}/snippets`;
  const timeoutSec = clamp(config.get<number>('saveTimeoutSeconds'), 1, 300, 10);

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
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
  } catch (err) {
    // 시간 초과: 서버는 이미 저장했을 수 있다 → 다시 보내지 말고 확인부터 하게 안내
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(
        `응답 시간 초과 (${timeoutSec}초). 서버에는 저장됐을 수 있으니 다시 누르지 말고 서버 로그·DB 를 먼저 확인하세요.`
      );
    }
    // 서버가 꺼져 있음 / 주소 틀림
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`서버에 연결할 수 없습니다: ${url} (${reason})`);
  }

  const text = await res.text();
  const elapsedMs = Date.now() - started;
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${formatSeconds(elapsedMs)}): ${text}`);
  }

  // 성공 응답인데 id 가 없으면 성공으로 치지 않는다 (logic.ts)
  const parsed = parseSaveResponse(text);
  return {
    id: parsed.id,
    mock: false,
    detail: `POST ${url} → HTTP ${res.status} ${text} (${formatSeconds(elapsedMs)})`,
    elapsedMs,
    embedding: parsed.embedding,
    embeddingError: parsed.embeddingError,
  };
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

    saving = true;
    try {
      const collected = await collectSnippet();
      if (!collected) {
        return;
      }
      const { snippet, absolutePath } = collected;

      // 설정이 켜져 있으면 저장 전에 함수 이름 확인 (자동 추출이 틀릴 수 있다)
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
      const offer = (show: typeof vscode.window.showInformationMessage, text: string) => {
        // await 하지 않는다 — 알림이 떠 있는 동안 다음 저장이 막히지 않게
        void show(text, '검색에서 확인').then((choice) => {
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
          offer(vscode.window.showInformationMessage, `[mock] 저장 흉내만 냈습니다 — ${where}`);
          await searchProvider.addSaveRecord({ ...base, status: 'mock', elapsedMs: saved.elapsedMs });
        } else {
          // 팀 합의: 원문 저장은 성공했어도 검색 준비(임베딩)는 실패할 수 있다 → 따로 안내
          const ready = saved.embedding === 'ready' ? ' · 검색 준비 완료'
            : saved.embedding === 'pending' ? ' · 검색 준비 중'
            : '';
          output.appendLine(`→ 저장 완료 id=${saved.id}${saved.embedding ? ` (검색 준비: ${saved.embedding})` : ''}\n`);
          if (saved.embedding === 'failed') {
            const why = saved.embeddingError ? ` — ${saved.embeddingError}` : '';
            offer(vscode.window.showWarningMessage,
              `저장은 됐지만 검색 준비에 실패했습니다 (id ${saved.id})${why}. 원문은 남아 있고, 재처리 후 검색됩니다.`);
          } else {
            offer(vscode.window.showInformationMessage, `저장했습니다 (id ${saved.id}) — ${where}${ready}`);
          }
          await searchProvider.addSaveRecord({
            ...base, status: 'ok', id: saved.id, elapsedMs: saved.elapsedMs,
            embedding: saved.embedding, error: saved.embeddingError?.slice(0, 120),
          });
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

  // 비교 화면(vscode.diff)에 띄울 읽기 전용 문서
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(COMPARE_SCHEME, compareDocs));

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
    // 결과 카드의 "비교"에서 왼쪽에 보여줄 원래 코드 (줄바꿈 그대로)
    searchProvider.setCompareSource(editor.document.getText(editor.selection), editor.document.languageId);
    await searchProvider.searchFor(query);
  });

  // 시작하기 안내 (VS Code 시작 화면의 단계별 안내)
  const walkthrough = vscode.commands.registerCommand('codeMemory.openWalkthrough', () =>
    vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#start`, false),
  );
  context.subscriptions.push(walkthrough);
  context.subscriptions.push(switchMode, findSimilar);

  // 단축키(Ctrl+Alt+F) → 검색창에 커서
  const focusCommand = vscode.commands.registerCommand('codeMemory.focusSearch', () => searchProvider.focusSearch());

  context.subscriptions.push(command, focusCommand, output);
}

export function deactivate() {}