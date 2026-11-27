import * as vscode from 'vscode';
import { AskSource, AskTurn, LlmProvider } from './logic';
import { askBackend, insertCode, openSource, SearchResult, SearchViewProvider, searchSnippets, withCodeContext } from './sidebar';
import { normalizeFilter } from './logic';
import { LlmMessage, streamChat } from './llm';

// ─────────────────────────────────────────────
// AI 대화 — 검색창 질문과 따로, 계속 이어지는 대화
//   사이드바 "AI 대화" 칸과 편집기 탭(⤢)이 같은 대화를 함께 본다. 대화 기록은 이 PC 에만 (최근 30개)
//   참고: 저장한 코드 전체(/ask 가 찾음) + 고르면 지금 파일 · 선택 영역을 질문에 붙여 보낸다
// ─────────────────────────────────────────────

const CHATS_KEY = 'codeMemory.chats';
const CHATS_MAX = 30;

interface ChatTurn {
  q: string;
  a: string;
  sources: AskSource[];
  err?: string;
  ctx: string[];          // 붙여 보낸 것 (파일·선택 영역 이름)
  pending?: boolean;
  time: string;
}
interface Chat {
  id: string;
  title: string;
  time: string;
  turns: ChatTurn[];
}

export class ChatController {
  private readonly ports = new Set<(m: unknown) => void>();
  private chats: Chat[];
  private currentId: string;
  private ctrl: AbortController | undefined;
  private lastEditor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly global: vscode.Memento, private readonly search: SearchViewProvider) {
    this.chats = global.get<Chat[]>(CHATS_KEY, []).filter((c) => c && Array.isArray(c.turns));
    this.currentId = this.chats[0]?.id ?? this.newChat(false);
  }

  // 편집기에서 다른 곳(사이드바·대화 탭)으로 가도 "지금 파일"은 마지막 편집기
  watchEditors(): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.window.onDidChangeActiveTextEditor((e) => { if (e && e.document.uri.scheme !== 'output') { this.lastEditor = e; this.broadcastCtx(); } }),
      vscode.window.onDidChangeTextEditorSelection((e) => { if (e.textEditor === this.lastEditor) { this.broadcastCtx(); } }),
    );
  }

  private get current(): Chat {
    let c = this.chats.find((x) => x.id === this.currentId);
    if (!c) { this.currentId = this.newChat(false); c = this.chats[0]; }
    return c;
  }
  private newChat(save = true): string {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.chats.unshift({ id, title: '새 대화', time: new Date().toISOString(), turns: [] });
    // 빈 대화가 여러 개 쌓이지 않게
    this.chats = this.chats.filter((c, i) => i === 0 || c.turns.length).slice(0, CHATS_MAX);
    if (save) { void this.save(); }
    return id;
  }
  private async save(): Promise<void> {
    await this.global.update(CHATS_KEY, this.chats.map((c) => ({ ...c, turns: c.turns.map((t) => ({ ...t, pending: false })) })));
  }

  private ctxInfo(): { file: string | null; selection: number } {
    const e = this.lastEditor;
    if (!e || e.document.isClosed) { return { file: null, selection: 0 }; }
    const name = e.document.isUntitled ? '새 파일' : vscode.workspace.asRelativePath(e.document.uri, false);
    const sel = e.selection.isEmpty ? 0 : e.selection.end.line - e.selection.start.line + 1;
    return { file: name, selection: sel };
  }

  attach(webview: vscode.Webview): vscode.Disposable {
    webview.options = { enableScripts: true };
    webview.html = chatHtml(webview);
    const post = (m: unknown) => { void webview.postMessage(m); };
    this.ports.add(post);
    const sub = webview.onDidReceiveMessage((m: Record<string, unknown>) => { void this.onMessage(m); });
    return new vscode.Disposable(() => { sub.dispose(); this.ports.delete(post); });
  }

  // 다른 화면(Code Memory 탭)이 같은 대화를 쓰게 — 그 화면이 메시지를 감싸서 주고받는다
  attachPort(post: (m: unknown) => void): { receive(m: Record<string, unknown>): void; dispose(): void } {
    this.ports.add(post);
    return {
      receive: (m) => { void this.onMessage(m); },
      dispose: () => { this.ports.delete(post); },
    };
  }

  openPanel(): void {
    if (this.panel) { this.panel.reveal(); return; }
    this.panel = vscode.window.createWebviewPanel('codeMemory.chatPanel', 'Code Memory AI 대화', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    const d = this.attach(this.panel.webview);
    this.panel.onDidDispose(() => { d.dispose(); this.panel = undefined; });
  }

  private post(m: unknown): void {
    this.ports.forEach((post) => post(m));
  }
  private broadcast(): void {
    this.post({ type: 'state', chat: this.current, list: this.chats.map((c) => ({ id: c.id, title: c.title, time: c.time, n: c.turns.length })), ctx: this.ctxInfo(), panel: !!this.panel });
  }
  private broadcastCtx(): void {
    this.post({ type: 'ctx', ctx: this.ctxInfo() });
  }

  private async onMessage(m: Record<string, unknown>): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.broadcast();
        break;
      case 'send':
        await this.send(String(m.text ?? ''), !!m.useFile, !!m.useSel, m.fn && typeof m.fn === 'object' ? m.fn as { label: string; language: string; code: string } : undefined);
        break;
      case 'cancel':
        this.ctrl?.abort();
        break;
      case 'new':
        this.ctrl?.abort();
        this.currentId = this.newChat();
        this.broadcast();
        break;
      case 'pick':
        if (typeof m.id === 'string' && this.chats.some((c) => c.id === m.id)) { this.currentId = m.id; this.broadcast(); }
        break;
      case 'remove':
        if (typeof m.id === 'string') {
          this.chats = this.chats.filter((c) => c.id !== m.id);
          if (this.currentId === m.id) { this.currentId = this.chats[0]?.id ?? this.newChat(false); }
          await this.save();
          this.broadcast();
        }
        break;
      case 'panel':
        this.openPanel();
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(String(m.code ?? ''));
        break;
      case 'insert':
        if (this.lastEditor && !this.lastEditor.document.isClosed) { await vscode.window.showTextDocument(this.lastEditor.document, this.lastEditor.viewColumn); }
        await insertCode(String(m.code ?? ''));
        break;
      case 'diff': {
        // 답의 코드 ↔ 선택 영역(없으면 지금 파일)
        const e = this.lastEditor;
        const left = e ? (e.selection.isEmpty ? e.document.getText() : e.document.getText(e.selection)) : '';
        const a = await vscode.workspace.openTextDocument({ content: left, language: e?.document.languageId });
        const b = await vscode.workspace.openTextDocument({ content: String(m.code ?? ''), language: e?.document.languageId });
        await vscode.commands.executeCommand('vscode.diff', a.uri, b.uri, '내 코드 ↔ AI 답');
        break;
      }
      case 'source': {
        const turn = this.current.turns[Number(m.turn)];
        const src = turn?.sources.find((s) => s.citation_id === m.cite);
        if (src) { await openSource(src as unknown as SearchResult); }
        break;
      }
    }
  }

  private async sendDirect(q: string, items: { label: string; language: string; code: string }[], chat: Chat, turn: ChatTurn, idx: number,
    own: { provider: LlmProvider; value: string }, signal: AbortSignal): Promise<void> {
    // 질문과 비슷한 저장 코드 3개 (mock 이면 샘플) — 못 찾아도 대화는 그대로
    let sources: AskSource[] = [];
    try {
      const found = await searchSnippets(q, normalizeFilter({}));
      sources = found.results.filter((r) => r.score >= 0.3).slice(0, 3).map((r, i) => ({
        citation_id: `S${i + 1}`, id: r.id, project_name: r.project_name, file_path: r.file_path, language: r.language,
        function_name: r.function_name, start_line: r.start_line, end_line: r.end_line, code: r.code, score: r.score,
      }));
    } catch {
      sources = [];
    }
    turn.sources = sources;
    this.post({ type: 'sources', chatId: chat.id, turn: idx, sources });
    const blocks: string[] = [];
    items.forEach((i) => blocks.push(`[참고 코드: ${i.label}]\n\`\`\`${i.language}\n${i.code.slice(0, 6000)}\n\`\`\``));
    if (sources.length) {
      blocks.push('[저장한 코드]\n' + sources.map((s) => `[${s.citation_id}] ${s.function_name ?? '(이름 없음)'} — ${s.file_path}:${s.start_line}\n\`\`\`${s.language}\n${s.code.slice(0, 2000)}\n\`\`\``).join('\n\n'));
    }
    const history: LlmMessage[] = [];
    chat.turns.slice(0, -1).filter((t) => t.a && !t.err).slice(-10).forEach((t) => {
      history.push({ role: 'user', content: t.q }, { role: 'assistant', content: t.a });
    });
    const content = blocks.length ? `${blocks.join('\n\n')}\n\n질문: ${q}` : q;
    turn.a = await streamChat({
      provider: own.provider, key: own.value, system: CHAT_SYSTEM, signal,
      messages: [...history, { role: 'user', content }],
      onDelta: (t) => { turn.a += t; this.post({ type: 'delta', chatId: chat.id, turn: idx, text: t }); },
    }) || turn.a;
    if (!turn.a.trim()) { turn.a = '(빈 답이 왔어요. 다시 물어봐 주세요.)'; }
  }

  private async send(text: string, useFile: boolean, useSel: boolean, fn?: { label: string; language: string; code: string }): Promise<void> {
    const q = text.trim();
    const chat = this.current;
    if (!q || chat.turns.some((t) => t.pending)) { return; }
    const items: { label: string; language: string; code: string }[] = [];
    const e = this.lastEditor && !this.lastEditor.document.isClosed ? this.lastEditor : undefined;
    if (e && useSel && !e.selection.isEmpty) {
      items.push({ label: `${vscode.workspace.asRelativePath(e.document.uri, false)}:${e.selection.start.line + 1}-${e.selection.end.line + 1}`, language: e.document.languageId, code: e.document.getText(e.selection) });
    } else if (e && useFile) {
      items.push({ label: vscode.workspace.asRelativePath(e.document.uri, false), language: e.document.languageId, code: e.document.getText() });
    }
    // Code Memory 탭에서 보고 있는 함수
    if (fn && typeof fn.code === 'string' && fn.code.trim() && !items.some((i) => i.code.includes(fn.code))) {
      items.push({ label: String(fn.label || '함수').slice(0, 120), language: String(fn.language || ''), code: fn.code.slice(0, 8000) });
    }
    const history: AskTurn[] = chat.turns.filter((t) => t.a && !t.err).slice(-2).map((t) => ({ q: t.q, answer: t.a }));
    const turn: ChatTurn = { q, a: '', sources: [], ctx: items.map((i) => i.label), pending: true, time: new Date().toISOString() };
    chat.turns.push(turn);
    if (chat.title === '새 대화') { chat.title = q.slice(0, 40); }
    chat.time = turn.time;
    this.chats = [chat, ...this.chats.filter((c) => c.id !== chat.id)];
    this.broadcast();
    this.ctrl?.abort();
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    const idx = chat.turns.length - 1;
    try {
      // 🔑 AI 키에 내 키가 있으면 그 회사 API 를 직접 — 일반 질문도 되고, 저장한 코드는 /search 로 찾아 [S1] 로 붙인다
      const own = await this.search.ownKey();
      if (own) {
        await this.sendDirect(q, items, chat, turn, idx, own, ctrl.signal);
        return;
      }
      const { key } = await this.search.keyForRequest(false);
      const r = await askBackend(withCodeContext(q, items), {
        history, signal: ctrl.signal, key,
        onSources: (sources) => { turn.sources = sources; this.post({ type: 'sources', chatId: chat.id, turn: idx, sources }); },
        onDelta: (t) => { turn.a += t; this.post({ type: 'delta', chatId: chat.id, turn: idx, text: t }); },
      });
      turn.a = r.answer || turn.a || (r.status === 'insufficient_context' ? '저장한 코드에서 근거를 찾지 못했어요.' : '');
      turn.sources = r.sources;
    } catch (err) {
      turn.err = err instanceof Error ? (err.message + ('detail' in err && typeof (err as { detail?: unknown }).detail === 'string' ? ' — ' + (err as { detail: string }).detail : '')) : String(err);
    } finally {
      turn.pending = false;
      await this.save();
      this.broadcast();
    }
  }
}

export const CHAT_SYSTEM = [
  '너는 VS Code 확장 "Code Memory" 의 AI 도우미야. 상대는 코드를 처음 배우는 사람일 수도 있어.',
  '한국어 존댓말(~요)로 짧고 정확하게 답해. 전문 용어는 되도록 피하고, 꼭 쓰면 바로 쉬운 말로 풀어 줘.',
  '코드는 ``` 블록으로. 마크다운 제목은 쓰지 마.',
  '[참고 코드] 로 붙은 것은 사용자가 지금 보고 있는 코드야. [S1] 같은 번호가 붙은 [저장한 코드] 를 근거로 쓸 때는 문장 끝에 [S1] 처럼 표시하고, 관련 없으면 무시해.',
  '코드와 상관없는 일반 질문에도 그냥 답해.',
].join('\n');

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'codeMemory.chatView';
  constructor(private readonly controller: ChatController) {}
  resolveWebviewView(view: vscode.WebviewView): void {
    const d = this.controller.attach(view.webview);
    view.onDidDispose(() => d.dispose());
  }
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) { s += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return s;
}

export function chatHtml(webview: { cspSource: string }): string {
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  html, body { height: 100%; }
  body { margin: 0; padding: 0; display: flex; flex-direction: column; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; }
  button { font: inherit; cursor: pointer; }
  .head { display: flex; align-items: center; gap: 2px; padding: 4px 8px; border-bottom: 1px solid var(--vscode-widget-border, #8884); }
  .head .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .ib { padding: 2px 6px; border: 0; border-radius: 4px; background: none; color: var(--vscode-foreground); font-size: 12px; }
  .ib:hover, .ib.on { background: var(--vscode-toolbar-hoverBackground, #8883); }
  .list { border-bottom: 1px solid var(--vscode-widget-border, #8884); max-height: 45%; overflow: auto; }
  .li { display: flex; align-items: center; gap: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
  .li:hover { background: var(--vscode-list-hoverBackground); }
  .li.on { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .li .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .li .m { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .li .x { opacity: .5; border: 0; background: none; color: inherit; }
  .ctx { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-widget-border, #8884); }
  .cx { padding: 1px 8px; border-radius: 10px; font-size: 11px; border: 1px dashed color-mix(in srgb, var(--vscode-descriptionForeground) 55%, transparent); background: none; color: var(--vscode-descriptionForeground); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cx.on { border-style: solid; border-color: color-mix(in srgb, var(--vscode-textLink-foreground) 60%, transparent); color: var(--vscode-textLink-foreground); }
  .cx:disabled { opacity: .45; cursor: default; }
  .cx.fixed { border-style: solid; cursor: default; }
  .msgs { flex: 1; overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
  .empty { margin: auto; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.7; }
  .me { align-self: flex-end; max-width: 88%; padding: 6px 10px; border-radius: 10px 10px 2px 10px; white-space: pre-wrap; word-break: break-word;
        background: color-mix(in srgb, var(--vscode-focusBorder) 22%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 45%, transparent); }
  .me .att { display: block; margin-top: 3px; font-size: 10.5px; color: var(--vscode-descriptionForeground); }
  .ai { align-self: flex-start; max-width: 96%; animation: arrive .35s ease both; }
  @keyframes arrive { from { opacity: 0; transform: translateY(6px); } }
  .who { font-size: 11px; color: var(--vscode-textLink-foreground); margin-bottom: 2px; }
  .body { padding: 6px 10px; border-radius: 10px 10px 10px 2px; border: 1px solid var(--vscode-widget-border, #8884); line-height: 1.55; word-break: break-word; }
  .body p { margin: 0 0 6px; } .body p:last-child { margin-bottom: 0; }
  .body code { font-family: var(--vscode-editor-font-family); font-size: 12px; padding: 0 3px; border-radius: 3px; background: var(--vscode-textCodeBlock-background); }
  .cb { margin: 6px 0; border-radius: 4px; background: var(--vscode-textCodeBlock-background); overflow: hidden; }
  .cb pre { margin: 0; padding: 6px 8px; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 1.5; }
  .cb .tools { display: flex; gap: 10px; justify-content: flex-end; padding: 2px 8px; font-size: 11px; border-top: 1px solid var(--vscode-widget-border, #8883); }
  .lk { padding: 0; border: 0; background: none; color: var(--vscode-textLink-foreground); font-size: 11px; }
  .lk:hover { text-decoration: underline; }
  .cite { padding: 0 4px; margin: 0 1px; border-radius: 3px; font-size: 10.5px; border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 50%, transparent); background: none; color: var(--vscode-textLink-foreground); }
  .err { color: var(--vscode-errorForeground); }
  .acts { display: flex; gap: 10px; margin-top: 3px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .typing span { display: inline-block; width: 5px; height: 5px; margin-right: 3px; border-radius: 50%; background: var(--vscode-descriptionForeground); animation: blink 1.2s infinite; }
  .typing span:nth-child(2) { animation-delay: .2s; } .typing span:nth-child(3) { animation-delay: .4s; }
  @keyframes blink { 50% { opacity: .2; } }
  .sugg { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 8px 6px; }
  .sg { padding: 2px 8px; border-radius: 10px; font-size: 11.5px; border: 1px solid var(--vscode-widget-border, #8886); background: none; color: var(--vscode-foreground); }
  .sg:hover { background: var(--vscode-list-hoverBackground); }
  .inp { padding: 8px; border-top: 1px solid var(--vscode-widget-border, #8884); }
  textarea { width: 100%; box-sizing: border-box; min-height: 52px; max-height: 180px; resize: vertical; padding: 6px 8px; border-radius: 6px; font: inherit; font-size: 12.5px;
             color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8886); }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  .foot { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .foot .sp { flex: 1; }
  .send { padding: 3px 12px; border-radius: 3px; border: 0; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-size: 12px; }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; } }
</style>
</head>
<body>
<div class="head"><span class="title" id="title">✦ AI 대화</span>
  <button class="ib" id="newBtn" title="새 대화">＋</button><button class="ib" id="histBtn" title="대화 기록">🕘</button><button class="ib" id="bigBtn" title="편집기 옆에 크게">⤢</button></div>
<div class="list" id="list" hidden></div>
<div class="ctx" id="ctx"></div>
<div class="msgs" id="msgs"></div>
<div class="sugg" id="sugg"></div>
<div class="inp"><textarea id="q" placeholder="AI 에게 물어보세요… (Enter 보내기 · Shift+Enter 줄바꿈)"></textarea>
  <div class="foot"><span id="foot">저장한 코드에서 찾아서 답해요</span><span class="sp"></span><button class="send" id="send">보내기</button></div></div>
<script nonce="${n}">
(function () {
  const vscode = acquireVsCodeApi();
  const $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) { e.className = cls; } if (text !== undefined) { e.textContent = text; } return e; }
  const saved = vscode.getState() || {};
  let useFile = saved.useFile !== false, useSel = saved.useSel !== false;
  let chat = null, list = [], ctx = { file: null, selection: 0 }, isPanel = false;
  const BT = String.fromCharCode(96);
  const FENCE = BT + BT + BT;

  // 답변 — 코드 블록(복사·삽입·비교) · 인라인 코드 · [S1] 인용
  function render(text, turnIdx, sources) {
    const body = el('div', 'body');
    const parts = String(text || '').split(FENCE);
    parts.forEach(function (part, i) {
      if (i % 2 === 1) {
        const nl = part.indexOf('\\n');
        const code = (nl >= 0 ? part.slice(nl + 1) : part).replace(/\\n$/, '');
        const cb = el('div', 'cb');
        cb.append(el('pre', '', code));
        const tools = el('div', 'tools');
        [['복사', 'copy'], ['편집기에 삽입', 'insert'], ['내 코드와 비교', 'diff']].forEach(function (b) {
          const x = el('button', 'lk', b[0]);
          x.type = 'button';
          x.addEventListener('click', function () { vscode.postMessage({ type: b[1], code: code }); if (b[1] === 'copy') { x.textContent = '복사됨'; } });
          tools.append(x);
        });
        cb.append(tools);
        body.append(cb);
        return;
      }
      part.split(/\\n{2,}/).forEach(function (para) {
        if (!para.trim()) { return; }
        const p = el('p', '');
        para.split(new RegExp('(' + BT + '[^' + BT + ']+' + BT + '|\\\\[S\\\\d+\\\\])')).forEach(function (seg) {
          if (!seg) { return; }
          if (seg.charAt(0) === BT && seg.length > 1) { p.append(el('code', '', seg.slice(1, -1))); }
          else if (/^\\[S\\d+\\]$/.test(seg)) {
            const id = seg.slice(1, -1);
            const known = (sources || []).some(function (s) { return s.citation_id === id; });
            const c = el('button', 'cite', id);
            c.type = 'button';
            c.disabled = !known;
            c.title = known ? '참고 코드 열기' : '참고 목록에 없는 번호';
            c.addEventListener('click', function () { vscode.postMessage({ type: 'source', turn: turnIdx, cite: id }); });
            p.append(c);
          } else { p.append(document.createTextNode(seg)); }
        });
        body.append(p);
      });
    });
    return body;
  }

  function renderCtx() {
    const box = $('ctx');
    box.replaceChildren();
    const f = el('button', 'cx' + (useFile && ctx.file ? ' on' : ''), '📄 ' + (ctx.file ? ctx.file.split('/').pop() : '열린 파일 없음'));
    f.type = 'button';
    f.disabled = !ctx.file;
    f.title = ctx.file ? '지금 파일 전체를 질문에 붙여 보내기 (' + ctx.file + ')' : '';
    f.addEventListener('click', function () { useFile = !useFile; keep(); renderCtx(); });
    const s = el('button', 'cx' + (useSel && ctx.selection ? ' on' : ''), '▭ 선택 영역' + (ctx.selection ? ' ' + ctx.selection + '줄' : ''));
    s.type = 'button';
    s.disabled = !ctx.selection;
    s.title = '선택한 부분만 붙여 보내기 (켜져 있으면 파일보다 먼저)';
    s.addEventListener('click', function () { useSel = !useSel; keep(); renderCtx(); });
    const all = el('span', 'cx fixed on', '🔍 저장한 코드 전체');
    all.title = '질문과 비슷한 저장 코드를 찾아 근거로 써요 (항상)';
    box.append(f, s, all);
  }
  function keep() { vscode.setState({ useFile: useFile, useSel: useSel }); }

  function renderList() {
    const box = $('list');
    box.replaceChildren();
    list.forEach(function (c) {
      const row = el('div', 'li' + (chat && c.id === chat.id ? ' on' : ''));
      row.append(el('span', 't', c.title || '새 대화'), el('span', 'm', c.n + '개 · ' + new Date(c.time).toLocaleDateString()));
      const x = el('button', 'x', '✕');
      x.type = 'button';
      x.title = '이 대화 지우기';
      x.addEventListener('click', function (e) { e.stopPropagation(); vscode.postMessage({ type: 'remove', id: c.id }); });
      row.append(x);
      row.addEventListener('click', function () { vscode.postMessage({ type: 'pick', id: c.id }); box.hidden = true; $('histBtn').classList.remove('on'); });
      box.append(row);
    });
    if (!list.length) { box.append(el('div', 'li', '대화 기록이 없어요')); }
  }

  function renderMsgs() {
    const box = $('msgs');
    box.replaceChildren();
    $('title').textContent = '✦ ' + (chat && chat.turns.length ? chat.title : 'AI 대화');
    if (!chat || !chat.turns.length) {
      const e = el('div', 'empty');
      e.append(el('div', '', '저장한 코드를 근거로 이어서 대화해요.'), el('div', '', '📄 지금 파일 · ▭ 선택 영역을 켜면 그 코드도 같이 봐요.'));
      box.append(e);
    } else {
      chat.turns.forEach(function (t, i) {
        const me = el('div', 'me', t.q);
        if (t.ctx && t.ctx.length) { me.append(el('span', 'att', '📎 ' + t.ctx.join(', '))); }
        box.append(me);
        const ai = el('div', 'ai');
        ai.append(el('div', 'who', '✦ AI' + (t.sources && t.sources.length ? ' · 저장한 코드 ' + t.sources.length + '개 참고' : '')));
        if (t.err) { ai.append(el('div', 'body err', t.err)); }
        else if (t.pending && !t.a) { const d = el('div', 'body typing'); d.append(el('span'), el('span'), el('span')); ai.append(d); }
        else { ai.append(render(t.a, i, t.sources)); }
        if (!t.pending && t.a) {
          const acts = el('div', 'acts');
          const cp = el('button', 'lk', '답 복사');
          cp.type = 'button';
          cp.addEventListener('click', function () { vscode.postMessage({ type: 'copy', code: t.a }); cp.textContent = '복사됨'; });
          acts.append(cp);
          ai.append(acts);
        }
        box.append(ai);
      });
    }
    box.scrollTop = box.scrollHeight;
    const busy = chat && chat.turns.some(function (t) { return t.pending; });
    $('send').textContent = busy ? '멈추기' : '보내기';
    // 제안
    const sg = $('sugg');
    sg.replaceChildren();
    const last = chat && chat.turns.length ? chat.turns[chat.turns.length - 1] : null;
    const ideas = last && last.a ? ['더 쉽게 설명해줘', '예시 코드 보여줘', '테스트 코드 만들어줘'] : (ctx.selection ? ['이 코드 설명해줘', '버그 있어?', '더 짧게 쓸 수 있어?'] : ['저장한 코드 중 정렬하는 거 있어?', '날짜 다루는 코드 찾아줘']);
    ideas.forEach(function (q) {
      const b = el('button', 'sg', q);
      b.type = 'button';
      b.addEventListener('click', function () { send(q); });
      sg.append(b);
    });
  }

  function send(text) {
    const q = String(text || '').trim();
    if (!q) { return; }
    vscode.postMessage({ type: 'send', text: q, useFile: useFile, useSel: useSel });
    $('q').value = '';
  }
  $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($('q').value); } });
  $('send').addEventListener('click', function () {
    if (chat && chat.turns.some(function (t) { return t.pending; })) { vscode.postMessage({ type: 'cancel' }); return; }
    send($('q').value);
  });
  $('newBtn').addEventListener('click', function () { vscode.postMessage({ type: 'new' }); $('q').focus(); });
  $('histBtn').addEventListener('click', function () { const l = $('list'); l.hidden = !l.hidden; $('histBtn').classList.toggle('on', !l.hidden); renderList(); });
  $('bigBtn').addEventListener('click', function () { vscode.postMessage({ type: 'panel' }); });

  window.addEventListener('message', function (e) {
    const m = e.data;
    if (m.type === 'state') {
      chat = m.chat; list = m.list || []; ctx = m.ctx || ctx; isPanel = !!m.panel;
      renderCtx(); renderMsgs(); if (!$('list').hidden) { renderList(); }
    } else if (m.type === 'ctx') {
      ctx = m.ctx || ctx; renderCtx();
    } else if (m.type === 'delta' && chat && m.chatId === chat.id) {
      const t = chat.turns[m.turn];
      if (t) { t.a += m.text; renderMsgs(); }
    } else if (m.type === 'sources' && chat && m.chatId === chat.id) {
      const t = chat.turns[m.turn];
      if (t) { t.sources = m.sources; }
    }
  });
  renderCtx();
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
