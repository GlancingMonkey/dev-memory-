import * as vscode from 'vscode';
import { ChatController } from './chat';
import { EditorFollower, FollowTarget, LocalRunError, LocalRunner } from './follow';
import { ConceptMapPanel } from './conceptMap';
import { StudyMode, TraceResult } from './study';
import { AiConceptCache, fetchAiConcepts, fetchStudy, readStudy, STUDY_KEY, StudyAiError, StudyCache } from './studyHost';
import { insertCode, openSource, resolveUri, SearchResult } from './sidebar';
import { LlmProvider } from './logic';
import { studyDirect } from './llm';
import { parseAiConcepts, parseStudyResult, STUDY_CONCEPTS } from './study';

// ─────────────────────────────────────────────
// Code Memory 탭 — 공부 · 실행 과정 · AI 대화 · 개념 지도를 코드 옆 편집기 탭 하나에서
//   VS Code 1.85+ 는 "창으로 떼기"로 따로 뜬 창이 된다 (📌 로 다시 붙임). 마지막 위치를 기억한다
//   화면 코드는 src/web/hub.js (esbuild 로 dist/hub.js), 모양은 media/hub.css
//   사이드바는 검색 · 오늘 복습만 (설정 codeMemory.studyLocation = sidebar 면 예전처럼 사이드바에서)
// ─────────────────────────────────────────────

export type HubTab = 'study' | 'trace' | 'chat' | 'map';
// 공부할 코드 — 검색 결과 · 편집기 선택 · 복습 카드가 모두 이 모양
export type HubItem = Partial<SearchResult> & { _uri?: string; _follow?: { call?: string } };

const WINDOW_KEY = 'codeMemory.hubWindow';
const AI_MODES: StudyMode[] = ['translate', 'explain', 'why', 'review', 'task', 'bug', 'plain', 'lines', 'narrate', 'distractors'];

interface Deps {
  global: vscode.Memento;
  extensionUri: vscode.Uri;
  chat: ChatController;
  keyForRequest: () => Promise<{ key: { provider: LlmProvider; value: string } | undefined }>;
  ownKey: () => Promise<{ provider: LlmProvider; value: string } | undefined>;   // 🔑 AI 키 — 있으면 공부 AI 도 그 회사로 직접
  follower: () => EditorFollower;
  studyChanged: () => void;            // 사이드바 오늘 복습 · 개념 지도 다시 그리기
  log: (line: string) => void;         // 출력 > Code Memory
  demoDone: (id: string) => void;      // 시연 모드 순서 자동 체크
  searchConcept: (name: string, id: string) => Promise<void>;   // 사이드바 검색을 그 개념 범위로
}

export class CodeMemoryHub {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private queue: unknown[] = [];
  private item: HubItem | undefined;
  private tab: HubTab = 'study';
  private win: boolean;
  private chatPort: { receive(m: Record<string, unknown>): void; dispose(): void } | undefined;
  private readonly traces = new Map<number, { data: TraceResult; target: FollowTarget }>();
  private followingId: number | undefined;
  private runner: LocalRunner | undefined;
  private cache: StudyCache | undefined;
  private aiConcepts: AiConceptCache | undefined;
  private snap: unknown;               // 붙일 때 새로 만든 탭에 되살릴 화면

  constructor(private readonly d: Deps) {
    this.win = d.global.get<boolean>(WINDOW_KEY, false);
  }

  get tracing(): boolean {
    return this.followingId !== undefined;
  }

  // 공부 · 실행 과정 · 대화 · 지도 열기. item 이 없으면 지금 화면 그대로
  async open(item: HubItem | undefined, tab: HubTab): Promise<void> {
    if (item) { this.item = item; }
    this.tab = tab;
    const fresh = !this.panel;
    if (!this.panel) { this.create(); } else { this.panel.reveal(undefined, true); }
    this.post({ type: 'open', item: this.item ?? null, tab, follow: item?._follow ?? null });
    // 지난번에 따로 뜬 창에서 썼으면 이번에도 떼어 준다
    if (fresh && this.win && await this.hasCommand('workbench.action.moveEditorToNewWindow')) {
      this.panel?.reveal(undefined, false);
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    }
  }

  // 편집기 F10 · Esc
  followCmd(cmd: 'next' | 'prev' | 'stop'): void {
    this.d.log(`실행 과정 ${cmd === 'next' ? '다음 단계' : cmd === 'prev' ? '이전 단계' : '멈춤'}`);
    if (cmd === 'stop') { this.stopFollow(); }
    this.post({ type: 'traceCmd', cmd });
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private create(): void {
    const panel = vscode.window.createWebviewPanel('codeMemory.hub', 'Code Memory', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.d.extensionUri, 'dist'), vscode.Uri.joinPath(this.d.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(this.d.extensionUri, 'media', 'icon.svg');
    this.panel = panel;
    this.ready = false;
    panel.webview.html = this.html(panel.webview);
    this.chatPort = this.d.chat.attachPort((m) => this.post({ type: 'chat', m }));
    panel.webview.onDidReceiveMessage((m: Record<string, unknown>) => { void this.onMessage(m); });
    panel.onDidDispose(() => {
      this.chatPort?.dispose();
      this.chatPort = undefined;
      this.stopFollow();
      this.panel = undefined;
      this.ready = false;
      this.queue = [];
    });
  }

  private post(m: unknown): void {
    if (!this.panel) { return; }
    if (!this.ready) { this.queue.push(m); return; }
    void this.panel.webview.postMessage(m);
  }

  private async hasCommand(id: string): Promise<boolean> {
    return (await vscode.commands.getCommands(true)).includes(id);
  }

  private async env(): Promise<Record<string, unknown>> {
    const config = vscode.workspace.getConfiguration('codeMemory');
    return {
      mock: config.get<boolean>('mock', true),
      localRun: config.get<boolean>('localRun', true),
      aiDirect: !!(await this.d.ownKey()),
      win: this.win,
    };
  }

  private async onMessage(m: Record<string, unknown>): Promise<void> {
    const id = Number(m.id);
    const reply = (data: unknown) => this.post({ type: 'reply', id, data });
    const fail = (err: unknown) => this.post({
      type: 'reply', id, error: err instanceof Error ? err.message : String(err),
      kind: err instanceof StudyAiError ? err.kind : err instanceof LocalRunError ? err.kind : 'server',
    });
    switch (m.type) {
      case 'ready': {
        this.ready = true;
        const q = this.queue;
        this.queue = [];
        void this.panel?.webview.postMessage({
          type: 'init', env: { ...(await this.env()), canPopout: await this.hasCommand('workbench.action.moveEditorToNewWindow') },
          study: readStudy(this.d.global.get(STUDY_KEY)),
          snap: this.snap,
        });
        this.snap = undefined;
        q.forEach((x) => { void this.panel?.webview.postMessage(x); });
        if (!q.length) { this.post({ type: 'open', item: this.item ?? null, tab: this.tab, follow: null }); }
        break;
      }
      case 'chat':
        if (m.m && typeof m.m === 'object') { this.chatPort?.receive(m.m as Record<string, unknown>); }
        break;
      case 'study': {
        await this.d.global.update(STUDY_KEY, readStudy(m.study));
        ConceptMapPanel.refresh();
        this.d.studyChanged();
        break;
      }
      case 'ai': {
        const mode = String(m.mode);
        const req = (m.req && typeof m.req === 'object' ? m.req : {}) as Record<string, unknown>;
        const base = { ...req, code: String(req.code ?? '').slice(0, 8000), language: String(req.language ?? ''), function_name: (req.function_name as string | null) ?? null };
        const mock = vscode.workspace.getConfiguration('codeMemory').get<boolean>('mock', true);
        try {
          // 🔑 AI 키가 있으면 그 회사 API 로 바로 (Backend 의 /study 와 같은 모양으로 받아 같은 검사)
          const own = await this.d.ownKey();
          if (own && (mode === 'concepts' || AI_MODES.includes(mode as StudyMode))) {
            const known = STUDY_CONCEPTS.map((c) => `${c.id}: ${c.name}`);
            const raw = await studyDirect(mode, mode === 'concepts' ? { ...base, known } : base, own);
            reply(mode === 'concepts' ? parseAiConcepts(raw, STUDY_CONCEPTS.map((c) => c.id)) : parseStudyResult(mode as StudyMode, raw));
            break;
          }
          const { key } = await this.d.keyForRequest();
          if (mode === 'concepts') {
            if (!this.aiConcepts) { this.aiConcepts = new AiConceptCache(this.d.global); }
            const hit = m.fresh ? undefined : this.aiConcepts.get(base, mock);
            if (hit) { reply(hit); break; }
            const list = await fetchAiConcepts(base, key);
            await this.aiConcepts.put(base, mock, list);
            reply(list);
            break;
          }
          if (!AI_MODES.includes(mode as StudyMode)) { throw new Error('알 수 없는 요청'); }
          if (!this.cache) { this.cache = new StudyCache(this.d.global); }
          const hit = m.fresh ? undefined : this.cache.get(mode as StudyMode, base, mock);
          if (hit !== undefined) { reply(hit); break; }
          const data = await fetchStudy(mode as StudyMode, base, key);
          await this.cache.put(mode as StudyMode, base, mock, data);
          reply(data);
        } catch (err) { fail(err); }
        break;
      }
      case 'run': {
        // Python 은 내 PC 에서 (설정 codeMemory.localRun), 아니면 서버의 격리 실행 (POST /study/run)
        const item = (m.item ?? {}) as HubItem;
        const calls = Array.isArray(m.calls) ? (m.calls as unknown[]).map(String).slice(0, 20) : [];
        const tests = Array.isArray(m.tests) ? (m.tests as { call: string; expected: string }[]).slice(0, 20) : [];
        try {
          const src = typeof m.code === 'string' ? { code: m.code } : await this.runSource(item);
          if (LocalRunner.supports(String(item.language ?? ''))) {
            reply(await this.localRunner.run(src.code, calls, tests));
          } else {
            const { key } = await this.d.keyForRequest();
            reply(await fetchStudy('run', { code: src.code, language: String(item.language ?? ''), function_name: item.function_name ?? null, calls, tests }, key));
          }
        } catch (err) { fail(err); }
        break;
      }
      case 'trace': {
        const item = (m.item ?? {}) as HubItem;
        const call = String(m.call ?? '');
        try {
          const src = await this.runSource(item);
          let data: TraceResult;
          if (LocalRunner.supports(String(item.language ?? ''))) {
            data = await this.localRunner.trace(src.code, call);
          } else {
            const { key } = await this.d.keyForRequest();
            data = await fetchStudy('trace', { code: src.code, language: String(item.language ?? ''), function_name: item.function_name ?? null, call }, key) as TraceResult;
          }
          this.traces.set(id, { data, target: src.target });
          if (this.traces.size > 5) { this.traces.delete(this.traces.keys().next().value as number); }
          reply({ ...data, code: src.code });
        } catch (err) { fail(err); }
        break;
      }
      case 'source': {
        // JavaScript 는 화면(Worker)에서 실행 — 도우미 함수까지 있게 파일 전체를 준다
        try { reply((await this.runSource((m.item ?? {}) as HubItem)).code); } catch (err) { fail(err); }
        break;
      }
      case 'adopt': {
        // 화면에서 실행한 JavaScript 기록 — 확인하고 편집기 따라가기용으로 맡아 둔다
        try {
          const data = parseStudyResult('trace', m.data) as TraceResult;
          const src = await this.runSource((m.item ?? {}) as HubItem);
          this.traces.set(id, { data, target: src.target });
          if (this.traces.size > 5) { this.traces.delete(this.traces.keys().next().value as number); }
          reply({ ...data, id });
        } catch (err) { fail(err); }
        break;
      }
      case 'step': {
        // 실행 과정 단계가 바뀔 때마다 편집기에도 지금 줄 · 값 · 횟수
        const t = this.traces.get(Number(m.trace));
        if (!t) { break; }
        const f = this.d.follower();
        if (this.followingId !== Number(m.trace) || !f.active) {
          this.followingId = Number(m.trace);
          if (!(await f.start(t.data, t.target))) {
            this.d.log('실행 과정: 편집기에서 코드를 찾지 못해 탭에서만 보여 줌');
            this.followingId = undefined;
            this.post({ type: 'followFail' });
            break;
          }
        }
        f.show(Number(m.step));
        break;
      }
      case 'followStop':
        this.stopFollow();
        break;
      case 'open':
        if (m.item) { await openSource(m.item as SearchResult); }
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(String(m.text ?? ''));
        vscode.window.setStatusBarMessage('Code Memory: 복사했어요', 2000);
        break;
      case 'insert':
        await insertCode(String(m.text ?? ''));
        break;
      case 'diff': {
        const left = await vscode.workspace.openTextDocument({ content: String(m.left ?? ''), language: String(m.language ?? '') || undefined });
        const right = await vscode.workspace.openTextDocument({ content: String(m.right ?? ''), language: String(m.language ?? '') || undefined });
        await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, String(m.title ?? '내 코드 ↔ 제안'));
        break;
      }
      case 'url':
        if (typeof m.url === 'string' && /^https:\/\//.test(m.url)) { await vscode.env.openExternal(vscode.Uri.parse(m.url)); }
        break;
      case 'searchConcept':
        // 개념 지도 → 그 개념을 쓴 저장 코드를 사이드바에서 (GET /search?concept=)
        if (typeof m.id === 'string' && typeof m.name === 'string') { await this.d.searchConcept(m.name, m.id); }
        break;
      case 'popout':
        if (await this.hasCommand('workbench.action.moveEditorToNewWindow')) {
          this.panel?.reveal(undefined, false);
          await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
          this.win = true;
          await this.d.global.update(WINDOW_KEY, true);
          this.post({ type: 'env', env: await this.env() });
        } else {
          vscode.window.showInformationMessage('창으로 떼기는 VS Code 1.85 이상에서 돼요.');
        }
        break;
      case 'dock': {
        // 떼어 낸 창을 닫고 코드 옆에 새로 연다 — 보던 화면(snap)은 새 탭에서 되살린다
        this.win = false;
        await this.d.global.update(WINDOW_KEY, false);
        this.snap = m.snap;
        const item = this.item;
        const tab = this.tab;
        this.panel?.dispose();
        await new Promise((resolve) => setTimeout(resolve, 200));
        await this.open(item, tab);
        break;
      }
      case 'demo':
        if (typeof m.id === 'string') { this.d.demoDone(m.id); }
        break;
      case 'saveSnippet':
        await vscode.commands.executeCommand('codeMemory.saveSnippet');
        break;
    }
  }

  private stopFollow(): void {
    this.followingId = undefined;
    this.d.follower().stop();
  }

  private get localRunner(): LocalRunner {
    if (!this.runner) { this.runner = new LocalRunner(this.d.global); }
    return this.runner;
  }

  // 실행할 코드 — 원본 파일이 열려 있거나 찾을 수 있고 그 자리에 같은 코드가 있으면 파일 전체(도우미 함수까지),
  //               아니면 저장한 코드 조각만. 편집기 따라가기 위치도 같이
  private async runSource(item: HubItem): Promise<{ code: string; target: FollowTarget }> {
    const code = String(item.code ?? '');
    const first = code.replace(/\r\n/g, '\n').split('\n')[0].trim();
    let doc: vscode.TextDocument | undefined;
    try {
      if (item._uri) {
        doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(item._uri));
      } else if (item.file_path) {
        const uri = resolveUri(item as SearchResult);
        if (uri) { doc = await vscode.workspace.openTextDocument(uri); }
      }
    } catch {
      doc = undefined;
    }
    if (doc && first) {
      const text = doc.getText().replace(/\r\n/g, '\n');
      if (text.split('\n').some((l) => l.trim() === first)) {
        return { code: text, target: { uri: doc.uri.toString(), start_line: 1, code: text } };
      }
    }
    return { code, target: { uri: item._uri, file_path: item.file_path, start_line: item.start_line ?? 1, code } };
  }

  private html(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.d.extensionUri, 'dist', 'hub.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.d.extensionUri, 'media', 'hub.css'));
    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; worker-src blob:; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Code Memory</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
