import * as vscode from 'vscode';
import {
  AskError, clamp, EvalQuestion, EvalRow, evalToCsv, evalToMarkdown, normalizeFilter, parseEvalQuestions, rankOf, summarizeEval,
} from './logic';
import { askBackend, SearchError, searchSnippets, SearchViewProvider } from './sidebar';

// ─────────────────────────────────────────────
// 성능 평가 (팀용) — 질문 파일로 검색·AI 답변을 재고 편집기 탭에 결과를 보여준다
//   명령 팔레트 "Code Memory: 평가 실행 (팀용)" 으로만 연다. 지금 있는 API(GET /search, POST /ask)만 쓴다.
// ─────────────────────────────────────────────

const EXAMPLE = {
  questions: [
    { id: 'Q1', q: '두 숫자를 더하는 함수', expected: [1] },
    { id: 'Q2', q: '리스트에서 짝수만 고르기', expected: [2] },
    { id: 'Q3', q: '나이순으로 정렬', expected: [3] },
    { id: 'Q4', q: 'JWT 토큰의 서명과 만료를 검증하는 함수', expected: [] },
  ],
  _설명: 'expected 는 정답 코드의 DB ID (검색 결과·저장 알림의 id). 정답이 없는 질문은 [] — AI 답변까지 재면 근거 부족으로 답하는지 본다. 위 ID 는 mock 예시라 실제 DB 로 바꿔야 한다.',
};

type Mode = 'search' | 'ask';
interface LastRun {
  file: vscode.Uri;
  mode: Mode;
}

export class EvaluationRunner {
  private panel: vscode.WebviewPanel | undefined;
  private last: LastRun | undefined;
  private lastResult: { rows: EvalRow[]; meta: string; time: string } | undefined;
  private running = false;

  constructor(private readonly provider: SearchViewProvider) {}

  // 명령 진입점: 질문 파일 고르기 → 무엇을 잴지 → 실행
  async start(): Promise<void> {
    const file = await this.pickFile();
    if (!file) {
      return;
    }
    const mode = await vscode.window.showQuickPick(
      [
        { label: '$(search) 검색 정확도·속도만', description: 'LLM 0회', mode: 'search' as Mode },
        { label: '$(sparkle) 검색 + AI 답변까지', description: '질문마다 LLM 1회 · 비용 발생', mode: 'ask' as Mode },
      ],
      { title: 'Code Memory 평가 — 무엇을 잴까요?' },
    );
    if (!mode) {
      return;
    }
    await this.run({ file, mode: mode.mode });
  }

  private async pickFile(): Promise<vscode.Uri | undefined> {
    const found = await vscode.workspace.findFiles('**/{eval,evals,evaluation}/**/*.json', '**/node_modules/**', 30);
    type Item = vscode.QuickPickItem & { uri?: vscode.Uri; act?: 'browse' | 'example' };
    const items: Item[] = [];
    for (const uri of found) {
      let count = '';
      try {
        count = `질문 ${parseEvalQuestions(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))).length}개`;
      } catch {
        continue;   // 질문 파일 모양이 아니면 목록에서 뺀다
      }
      items.push({ label: `$(file) ${vscode.workspace.asRelativePath(uri)}`, description: count, uri });
    }
    items.push(
      { label: '$(folder-opened) 다른 질문 파일 고르기…', act: 'browse' },
      { label: '$(new-file) 예시 질문 파일 만들기', description: 'eval/questions.json', act: 'example' },
    );
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Code Memory 평가 — 질문 파일',
      placeHolder: '질문 + 정답 코드 ID 가 들어 있는 JSON',
    });
    if (!pick) {
      return undefined;
    }
    if (pick.uri) {
      return pick.uri;
    }
    if (pick.act === 'browse') {
      const sel = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] }, title: '질문 파일 고르기' });
      return sel?.[0];
    }
    // 예시 파일 만들기 → 열어서 보여주고, 이번엔 실행하지 않는다 (ID 를 실제 값으로 바꾸고 다시 실행)
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage('폴더를 먼저 여세요. 예시 파일은 열린 폴더의 eval/questions.json 에 만들어요.');
      return undefined;
    }
    const target = vscode.Uri.joinPath(folder.uri, 'eval', 'questions.json');
    try {
      await vscode.workspace.fs.stat(target);
      vscode.window.showWarningMessage('eval/questions.json 이 이미 있어요. 그 파일을 열게요.');
    } catch {
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(JSON.stringify(EXAMPLE, null, 2) + '\n'));
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
    vscode.window.showInformationMessage('예시 질문 파일을 열었어요. expected 의 ID 를 실제 DB 값으로 바꾼 뒤 다시 "평가 실행" 하세요.');
    return undefined;
  }

  private async run(run: LastRun): Promise<void> {
    if (this.running) {
      vscode.window.showWarningMessage('평가가 이미 진행 중이에요.');
      return;
    }
    let questions: EvalQuestion[];
    try {
      questions = parseEvalQuestions(new TextDecoder().decode(await vscode.workspace.fs.readFile(run.file)));
    } catch (err) {
      vscode.window.showErrorMessage(`질문 파일을 읽을 수 없어요: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.last = run;
    const config = vscode.workspace.getConfiguration('codeMemory');
    const mock = config.get<boolean>('mock', true);
    const limit = clamp(config.get<number>('searchLimit'), 1, 20, 10);
    const credentials = run.mode === 'ask' ? await this.provider.keyForRequest() : undefined;
    if (credentials?.keyBlocked) {
      vscode.window.showWarningMessage('이 서버 주소로는 개인 AI 키를 보낼 수 없어 평가를 중단했어요. localhost/HTTPS 주소를 확인하거나 서버 기본 키를 명시적으로 선택한 뒤 다시 실행하세요.');
      return;
    }
    const keyLabel = mock ? 'mock' : credentials?.keyUsed ?? '서버 기본 키';
    this.running = true;
    const rows: EvalRow[] = [];
    let cancelled = false;

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Code Memory 평가${run.mode === 'ask' ? ' · ' + keyLabel : ''}`, cancellable: true },
        async (progress, token) => {
          const ctrl = new AbortController();
          token.onCancellationRequested(() => { cancelled = true; ctrl.abort(); });
          for (let i = 0; i < questions.length; i++) {
            if (token.isCancellationRequested) {
              break;
            }
            const q = questions[i];
            progress.report({ message: `${i + 1} / ${questions.length} · ${q.id}`, increment: 100 / questions.length });
            const row: EvalRow = { id: q.id, q: q.q, expected: q.expected, rank: null, topIds: [], searchMs: null };

            // 검색 — 정답이 몇 등인지
            const t0 = Date.now();
            try {
              const out = await searchSnippets(q.q, normalizeFilter({ project: q.project, language: q.language }));
              row.searchMs = Date.now() - t0;
              row.topIds = out.results.map((r) => r.id);
              row.rank = q.expected.length ? rankOf(q.expected, row.topIds) : null;
            } catch (err) {
              row.searchError = err instanceof SearchError ? err.title : err instanceof Error ? err.message : String(err);
            }

            // AI 답변 (골랐을 때만) — 자동 재시도 없음
            if (run.mode === 'ask' && !token.isCancellationRequested) {
              const t1 = Date.now();
              try {
                const r = await askBackend(q.q, { key: credentials?.key, history: [], signal: ctrl.signal, onSources: () => undefined, onDelta: () => undefined });
                row.ask = { status: r.status, ms: Date.now() - t1, totalTokens: r.usage?.total_tokens ?? null, citations: r.citations.length };
              } catch (err) {
                if (token.isCancellationRequested) {
                  break;
                }
                row.ask = {
                  status: 'error', ms: Date.now() - t1, totalTokens: null, citations: 0,
                  error: err instanceof AskError ? err.title : err instanceof Error ? err.message : String(err),
                };
              }
            }
            rows.push(row);
          }
        },
      );
    } finally {
      this.running = false;
    }

    if (!rows.length) {
      return;
    }
    const where = mock ? 'mock (서버 호출 안 함 · 샘플 결과)' : `실제 서버 ${config.get<string>('apiUrl', 'http://localhost:8000')}`;
    const meta = `${where} · 질문 ${rows.length}개${cancelled ? ` (취소해서 ${questions.length}개 중 일부)` : ''} · limit ${limit} · `
      + `${run.mode === 'ask' ? `AI 답변 포함 · ${keyLabel}` : '검색만'} · 파일 ${vscode.workspace.asRelativePath(run.file)}`;
    this.lastResult = { rows, meta, time: new Date().toISOString() };
    this.show(mock);
  }

  // 결과 탭 (하나만 쓰고, 다시 실행하면 내용만 바뀐다)
  private show(mock: boolean): void {
    if (!this.lastResult) {
      return;
    }
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('codeMemory.evaluation', 'Code Memory 평가', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      this.panel.webview.html = evalHtml(this.panel.webview);
      this.panel.onDidDispose(() => { this.panel = undefined; });
      this.panel.webview.onDidReceiveMessage(async (msg: { type: string; format?: string; q?: string }) => {
        if (msg.type === 'ready') {
          this.post(mock);
        } else if (msg.type === 'rerun' && this.last) {
          await this.run(this.last);
        } else if (msg.type === 'export' && msg.format) {
          await this.export(msg.format);
        } else if (msg.type === 'search' && msg.q) {
          await this.provider.searchFor(msg.q);
        }
      });
    } else {
      this.post(mock);
      this.panel.reveal();
    }
  }

  private post(mock: boolean): void {
    if (!this.panel || !this.lastResult) {
      return;
    }
    const { rows, meta, time } = this.lastResult;
    this.panel.webview.postMessage({ type: 'result', rows, summary: summarizeEval(rows), meta, time, mock });
  }

  private async export(format: string): Promise<void> {
    if (!this.lastResult) {
      return;
    }
    const { rows, meta, time } = this.lastResult;
    const stamp = time.slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
    const ext = format === 'csv' ? 'csv' : format === 'json' ? 'json' : 'md';
    const content = format === 'csv' ? '﻿' + evalToCsv(rows)   // BOM — 엑셀에서 한글이 안 깨지게
      : format === 'json' ? JSON.stringify({ meta, time, summary: summarizeEval(rows), rows }, null, 2) + '\n'
      : evalToMarkdown(rows, summarizeEval(rows), meta);
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder, 'eval', `result-${stamp}.${ext}`) : undefined,
      filters: { [ext.toUpperCase()]: [ext] },
      title: '평가 결과 내보내기',
    });
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
    const open = await vscode.window.showInformationMessage(`평가 결과를 저장했어요: ${vscode.workspace.asRelativePath(target)}`, '열기');
    if (open) {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
    }
  }
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

// 결과 화면 — 카드(쉬운 이름 + 정식 용어) · 순위 막대 · 질문별 표 · 내보내기
export function evalHtml(webview: vscode.Webview): string {
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { margin: 0; padding: 16px 20px 32px; word-break: keep-all; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  button { font: inherit; cursor: pointer; }
  .top { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 2px; }
  .top h1 { font-size: 16px; margin: 0; }
  .chip { padding: 0 8px; border-radius: 9px; font-size: 11px; border: 1px solid; white-space: nowrap; }
  .chip.real { color: var(--vscode-testing-iconPassed, #73c991); border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 50%, transparent); }
  .chip.mock { color: var(--vscode-editorWarning-foreground); border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground) 50%, transparent); }
  .grow { flex: 1; }
  .btn { padding: 3px 10px; border-radius: 3px; font-size: 12px; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
         background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-button-border, var(--vscode-widget-border, #8886)); }
  .btn.p { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: transparent; }
  .meta { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 4px 0 14px; }
  .warn { margin: 0 0 12px; padding: 6px 10px; font-size: 12px; border-radius: 0 4px 4px 0; border-left: 3px solid var(--vscode-editorWarning-foreground);
          background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 10%, transparent); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; margin-bottom: 16px; }
  .card { padding: 10px 12px; border-radius: 6px; background: var(--vscode-editorWidget-background, color-mix(in srgb, var(--vscode-foreground) 6%, transparent));
          border: 1px solid var(--vscode-widget-border, transparent); }
  .card .k { font-size: 12px; color: var(--vscode-foreground); }
  .card .k small { color: var(--vscode-descriptionForeground); margin-left: 4px; }
  .card .v { font-size: 26px; font-weight: 600; line-height: 1.25; margin-top: 2px; }
  .card .d { font-size: 11.5px; color: var(--vscode-descriptionForeground); }
  h2 { font-size: 13px; margin: 0 0 8px; }
  .bars { display: grid; grid-template-columns: 90px 1fr 34px; gap: 5px 10px; align-items: center; font-size: 12px; margin-bottom: 18px; max-width: 640px; }
  .bars .lb { color: var(--vscode-descriptionForeground); }
  .track { height: 12px; border-radius: 3px; background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); overflow: hidden; }
  .fill { height: 100%; background: var(--vscode-charts-blue, #4daafc); }
  .fill.b2 { opacity: .65; } .fill.b3 { opacity: .35; }
  .fill.miss { background: var(--vscode-charts-red, #f85149); opacity: .8; }
  .tools { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; font-size: 12px; }
  .tools label { display: inline-flex; gap: 5px; align-items: center; color: var(--vscode-descriptionForeground); }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th { text-align: left; font-weight: 600; font-size: 11.5px; color: var(--vscode-descriptionForeground); padding: 5px 8px; border-bottom: 1px solid var(--vscode-widget-border, #8884); white-space: nowrap; }
  td { padding: 5px 8px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 8%, transparent); white-space: nowrap; }
  td.q { white-space: normal; min-width: 180px; }
  tr.row { cursor: pointer; }
  tr.row:hover td { background: var(--vscode-list-hoverBackground); }
  .ok { color: var(--vscode-testing-iconPassed, #73c991); }
  .bad { color: var(--vscode-errorForeground); }
  .mid { color: var(--vscode-foreground); }
  .muted { color: var(--vscode-descriptionForeground); }
  .menu { position: relative; display: inline-block; }
  .menu .list { position: absolute; right: 0; top: calc(100% + 3px); z-index: 5; min-width: 200px; padding: 4px 0; border-radius: 5px;
                background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-widget-border, #8884);
                box-shadow: 0 6px 16px var(--vscode-widget-shadow, #0008); }
  .menu .list button { display: block; width: 100%; padding: 4px 12px; text-align: left; border: 0; background: transparent; color: var(--vscode-foreground); font-size: 12px; }
  .menu .list button:hover { background: var(--vscode-list-hoverBackground); }
  .empty { color: var(--vscode-descriptionForeground); padding: 40px 0; text-align: center; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <div class="top">
    <h1>평가 결과</h1><span id="where" class="chip"></span><span class="grow"></span>
    <button id="rerun" class="btn" type="button">다시 실행</button>
    <span class="menu"><button id="exp" class="btn p" type="button">내보내기 ▾</button>
      <span id="expList" class="list" hidden>
        <button type="button" data-f="md">마크다운 표 (포스터·문서)</button>
        <button type="button" data-f="csv">CSV (엑셀)</button>
        <button type="button" data-f="json">JSON (원자료)</button>
      </span></span>
  </div>
  <div id="meta" class="meta"></div>
  <div id="mockWarn" class="warn" hidden>mock 결과예요. 검색어와 상관없이 같은 샘플이 나와서 숫자에 의미는 없어요. 실제 서버 모드에서 다시 실행하세요.</div>
  <div id="cards" class="cards"></div>
  <h2>정답이 몇 등에 나왔나</h2>
  <div id="bars" class="bars"></div>
  <div class="tools"><h2 style="margin:0">질문별 결과</h2><span class="grow"></span>
    <label><input id="onlyMiss" type="checkbox">못 찾은 질문만</label><span class="muted">줄을 누르면 그 질문으로 검색</span></div>
  <table><thead><tr><th>#</th><th>질문</th><th>정답 ID</th><th>순위</th><th>위 결과 ID</th><th>검색</th><th id="thAi">AI</th><th id="thTok">토큰</th></tr></thead>
    <tbody id="rows"><tr><td colspan="8" class="empty">평가를 불러오는 중…</td></tr></tbody></table>

<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const byId = function (id) { return document.getElementById(id); };
  let data = null;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined) { e.textContent = text; }
    return e;
  }
  function pct(n, d) { return d ? Math.round(n / d * 100) + '%' : '-'; }
  function sec(ms) { return ms === null || ms === undefined ? '-' : (ms / 1000).toFixed(2) + '초'; }
  function card(title, term, value, detail) {
    const c = el('div', 'card');
    const k = el('div', 'k', title);
    if (term) { k.append(el('small', '', term)); }
    c.append(k, el('div', 'v', value), el('div', 'd', detail));
    return c;
  }

  function render() {
    const s = data.summary;
    const where = byId('where');
    where.textContent = data.mock ? 'mock' : '실제 서버';
    where.className = 'chip ' + (data.mock ? 'mock' : 'real');
    byId('meta').textContent = data.meta + ' · ' + new Date(data.time).toLocaleString();
    byId('mockWarn').hidden = !data.mock;

    const cards = byId('cards');
    cards.replaceChildren(
      card('한 번에 찾음', 'Hit@1', pct(s.hit1, s.withAnswer), s.hit1 + ' / ' + s.withAnswer + ' · 첫 번째 결과가 정답'),
      card('3개 안에 찾음', 'Hit@3', pct(s.hit3, s.withAnswer), s.hit3 + ' / ' + s.withAnswer + ' · 위 3개 안에 정답'),
      card('정답 평균 순위', '', s.meanRank === null ? '-' : s.meanRank.toFixed(1) + '등', '못 찾은 질문 ' + s.missed + '개'),
      card('찾는 데 걸린 시간', '', sec(s.searchAvgMs), 'p95 ' + sec(s.searchP95Ms) + (s.searchFailed ? ' · 검색 실패 ' + s.searchFailed : ''))
    );
    if (s.asked) {
      cards.append(
        card('AI 답변 평균 토큰', '', s.askAvgTokens === null ? '-' : Math.round(s.askAvgTokens).toLocaleString(), '평균 ' + sec(s.askAvgMs) + (s.askErrors ? ' · 오류 ' + s.askErrors : '')),
        card('모르는 건 모른다고 함', '', s.noAnswerTotal ? s.noAnswerCorrect + ' / ' + s.noAnswerTotal : '-', '정답 없는 질문에 근거 부족으로 답한 수')
      );
    }

    const bars = byId('bars');
    bars.replaceChildren();
    const total = Math.max(1, s.withAnswer);
    [['1등', s.buckets.first, ''], ['2~3등', s.buckets.top3, ' b2'], ['4등 이하', s.buckets.top10, ' b3'], ['못 찾음', s.buckets.missed, ' miss']].forEach(function (b) {
      const track = el('div', 'track');
      const fill = el('div', 'fill' + b[2]);
      fill.style.width = Math.round(b[1] / total * 100) + '%';
      track.append(fill);
      bars.append(el('span', 'lb', b[0]), track, el('span', '', String(b[1])));
    });

    byId('thAi').hidden = !s.asked;
    byId('thTok').hidden = !s.asked;
    renderRows();
  }

  function renderRows() {
    const body = byId('rows');
    body.replaceChildren();
    const only = byId('onlyMiss').checked;
    const asked = data.summary.asked > 0;
    data.rows.forEach(function (r) {
      const miss = r.expected.length && r.searchMs !== null && r.rank === null;
      if (only && !miss) { return; }
      const tr = el('tr', 'row');
      let rank;
      if (r.searchMs === null) { rank = el('td', 'bad', '검색 실패'); rank.title = r.searchError || ''; }
      else if (!r.expected.length) { rank = el('td', 'muted', '-'); }
      else if (r.rank === null) { rank = el('td', 'bad', '못 찾음'); }
      else { rank = el('td', r.rank === 1 ? 'ok' : 'mid', r.rank + '등'); }
      tr.append(el('td', 'muted', r.id), el('td', 'q', r.q), el('td', '', r.expected.join(', ') || '-'), rank,
        el('td', 'muted', r.topIds.slice(0, 5).join(', ') || '-'), el('td', '', sec(r.searchMs)));
      if (asked) {
        let ai = '-';
        let cls = 'muted';
        if (r.ask) {
          if (r.ask.status === 'error') { ai = '오류'; cls = 'bad'; }
          else if (r.ask.status === 'answered') { ai = '답변 · 인용 ' + r.ask.citations; cls = ''; }
          else { ai = '근거 부족'; cls = r.expected.length ? 'mid' : 'ok'; }
        }
        const td = el('td', cls, ai);
        if (r.ask && r.ask.error) { td.title = r.ask.error; }
        tr.append(td, el('td', '', r.ask && r.ask.totalTokens !== null ? r.ask.totalTokens.toLocaleString() : '-'));
      }
      tr.title = '눌러서 사이드바에서 "' + r.q + '" 검색';
      tr.addEventListener('click', function () { vscode.postMessage({ type: 'search', q: r.q }); });
      body.append(tr);
    });
    if (!body.firstChild) {
      const tr = el('tr');
      const td = el('td', 'empty', only ? '못 찾은 질문이 없어요' : '결과가 없어요');
      td.colSpan = 8;
      tr.append(td);
      body.append(tr);
    }
  }

  byId('onlyMiss').addEventListener('change', function () { if (data) { renderRows(); } });
  byId('rerun').addEventListener('click', function () { vscode.postMessage({ type: 'rerun' }); });
  byId('exp').addEventListener('click', function () { byId('expList').hidden = !byId('expList').hidden; });
  byId('expList').querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () { byId('expList').hidden = true; vscode.postMessage({ type: 'export', format: b.dataset.f }); });
  });
  document.addEventListener('mousedown', function (e) {
    if (!e.target.closest || !e.target.closest('.menu')) { byId('expList').hidden = true; }
  });
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'result') { data = e.data; render(); }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
