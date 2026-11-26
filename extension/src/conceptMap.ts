import * as vscode from 'vscode';
import { buildConceptGraph, learningPath, STUDY_CONCEPTS } from './study';
import { StudySnapshot } from './studyHost';

// ─────────────────────────────────────────────
// 개념 지도 크게 보기 — 편집기 탭. 세로 줄 = 수준(기초 → 중급 → 심화), 선 = 먼저 알 것 → 다음
//   데이터는 확장 본체가 넘겨준다 (공부 기록·개념별 전체 코드 수). 이 탭은 보여주기·고르기만 한다.
// ─────────────────────────────────────────────

export interface ConceptMapHost {
  snapshot(): StudySnapshot;
  counts(): { at: string; counts: Record<string, number> } | undefined;
  openCard(key: string): Promise<void>;
  countAll(progress: (done: number, total: number) => void): Promise<void>;
  cancelCount(): void;
}

export class ConceptMapPanel {
  private static current: ConceptMapPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private counting = false;

  static show(host: ConceptMapHost, focusId?: string): void {
    if (ConceptMapPanel.current) {
      ConceptMapPanel.current.panel.reveal();
      ConceptMapPanel.current.post(focusId);
      return;
    }
    ConceptMapPanel.current = new ConceptMapPanel(host, focusId);
  }
  // 공부 기록이 바뀌면 열려 있는 지도도 다시 그린다
  static refresh(): void {
    ConceptMapPanel.current?.post();
  }

  private constructor(private readonly host: ConceptMapHost, focusId?: string) {
    this.panel = vscode.window.createWebviewPanel('codeMemory.conceptMap', 'Code Memory 개념 지도', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
    });
    this.panel.webview.html = mapHtml(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.host.cancelCount();
      ConceptMapPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage(async (msg: { type: string; key?: string; url?: string }) => {
      switch (msg.type) {
        case 'ready':
          this.post(focusId);
          break;
        case 'openCard':
          if (msg.key) { await this.host.openCard(msg.key); }
          break;
        case 'openUrl':
          if (typeof msg.url === 'string' && /^https:\/\//.test(msg.url)) { await vscode.env.openExternal(vscode.Uri.parse(msg.url)); }
          break;
        case 'countAll':
          if (this.counting) { return; }
          this.counting = true;
          try {
            await this.host.countAll((done, total) => { void this.panel.webview.postMessage({ type: 'countProgress', done, total }); });
          } finally {
            this.counting = false;
            this.post();
          }
          break;
        case 'cancelCount':
          this.host.cancelCount();
          break;
      }
    });
  }

  private post(focusId?: string): void {
    void this.panel.webview.postMessage({ type: 'data', snapshot: this.host.snapshot(), counts: this.host.counts() ?? null, focus: focusId ?? null });
  }
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) { s += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return s;
}
function conceptsJson(): string {
  return JSON.stringify(STUDY_CONCEPTS).replace(/`/g, '\\u0060').replace(/\$/g, '\\u0024').replace(/</g, '\\u003c');
}

export function mapHtml(webview: { cspSource: string }): string {
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { margin: 0; padding: 14px 18px 24px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; }
  .top { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-bottom: 10px; }
  h1 { font-size: 16px; margin: 0; }
  .stat { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .stat b { color: var(--vscode-foreground); }
  .grow { flex: 1; }
  button { font: inherit; cursor: pointer; }
  .btn { padding: 3px 10px; border-radius: 3px; font-size: 12px; border: 1px solid var(--vscode-button-secondaryBackground, #8886); background: transparent; color: var(--vscode-foreground); }
  .btn.p { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  .btn:disabled { opacity: .5; cursor: default; }
  .link { padding: 0; border: 0; background: none; color: var(--vscode-textLink-foreground); font-size: 12px; }
  .link:hover { text-decoration: underline; }
  .growth { font-size: 12px; margin: 0 0 10px; padding: 6px 10px; border-radius: 6px; background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 9%, transparent); }
  .growth b { color: var(--vscode-testing-iconPassed, #73c991); }
  .wrap { display: flex; gap: 16px; align-items: flex-start; }
  .graph { position: relative; flex: 1; min-width: 520px; display: grid; grid-template-columns: repeat(3, minmax(150px, 1fr)); column-gap: 70px; }
  .colh { font-size: 11px; margin-bottom: 2px; font-weight: 600; color: var(--vscode-descriptionForeground); }
  .col { display: flex; flex-direction: column; gap: 9px; align-items: flex-start; position: relative; z-index: 1; }
  .node { padding: 3px 10px; border-radius: 12px; font-size: 12px; white-space: nowrap; border: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 50%, transparent);
          background: var(--vscode-editor-background); color: var(--vscode-foreground); max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .node i { font-style: normal; color: var(--vscode-descriptionForeground); margin-left: 4px; font-size: 11px; }
  .node.ok { border-color: var(--vscode-testing-iconPassed, #73c991); color: var(--vscode-testing-iconPassed, #73c991); }
  .node.weak { border-color: var(--vscode-editorWarning-foreground); color: var(--vscode-editorWarning-foreground); }
  .node.new { border-color: var(--vscode-textLink-foreground); color: var(--vscode-textLink-foreground); }
  .node.next { border-style: dashed; border-color: var(--vscode-testing-iconPassed, #73c991); background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 8%, transparent); }
  .node.todo { border-style: dashed; color: var(--vscode-descriptionForeground); background: transparent; }
  .node.sel { box-shadow: 0 0 0 2px var(--vscode-focusBorder); }
  .node.dim { opacity: .3; }
  .node { transition: opacity .3s, border-color .5s, color .5s, box-shadow .3s; }
  .node.pop { animation: mpop .4s cubic-bezier(.3,1.6,.5,1) both; }
  .node.next { animation: mbreathe 2.6s ease-in-out infinite; }
  .node.glow { animation: mglow 1.4s ease-out 2; }
  @keyframes mpop { from { opacity: 0; transform: scale(.5); } }
  @keyframes mbreathe { 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 22%, transparent); } }
  @keyframes mglow { from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 80%, transparent); } to { box-shadow: 0 0 0 14px transparent; } }
  .node .step { transform: scale(0); animation: mpop .35s cubic-bezier(.3,1.6,.5,1) forwards; }
  svg.edges path.draw { animation: mdraw .7s ease-out both; }
  svg.edges path.flow { stroke-dasharray: 6 6; animation: mflow .8s linear infinite; }
  @keyframes mdraw { from { stroke-dashoffset: var(--len); } }
  @keyframes mflow { to { stroke-dashoffset: -12; } }
  .toast { position: fixed; right: 18px; top: 14px; z-index: 5; padding: 6px 12px; border-radius: 6px; font-size: 12px; pointer-events: none;
           border: 1px solid var(--vscode-testing-iconPassed, #73c991); color: var(--vscode-testing-iconPassed, #73c991); background: var(--vscode-editor-background);
           opacity: 0; transform: translateY(-8px); transition: opacity .35s, transform .35s; }
  .toast.in { opacity: 1; transform: none; }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; } }
  .node .step { display: inline-block; min-width: 15px; margin-right: 4px; border-radius: 8px; font-size: 10px; text-align: center; background: var(--vscode-focusBorder); color: #fff; }
  svg.edges { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 0; overflow: visible; }
  svg.edges path { fill: none; stroke: color-mix(in srgb, var(--vscode-descriptionForeground) 45%, transparent); stroke-width: 1.2; }
  svg.edges path.on { stroke: var(--vscode-focusBorder); stroke-width: 2; }
  svg.edges path.dim { opacity: .2; }
  .detail { width: 280px; flex: none; position: sticky; top: 10px; border-left: 1px solid var(--vscode-widget-border, #8884); padding-left: 14px; font-size: 12.5px; }
  .detail h2 { font-size: 14px; margin: 0 0 4px; }
  .lv { font-size: 10.5px; padding: 0 6px; border-radius: 8px; border: 1px solid; }
  .lv1 { color: var(--vscode-testing-iconPassed, #73c991); } .lv2 { color: var(--vscode-textLink-foreground); } .lv3 { color: var(--vscode-editorWarning-foreground); }
  .muted { color: var(--vscode-descriptionForeground); font-size: 11.5px; }
  .sec { font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); margin: 10px 0 3px; }
  .box { padding: 5px 8px; border-radius: 0 4px 4px 0; margin-top: 4px; border-left: 3px solid; }
  .box.mis { border-color: var(--vscode-editorWarning-foreground); background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 8%, transparent); }
  .box.con { border-color: var(--vscode-textLink-foreground); background: color-mix(in srgb, var(--vscode-textLink-foreground) 7%, transparent); }
  .row { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; border-top: 1px solid var(--vscode-widget-border, #8883); }
  .row button { padding: 0; border: 0; background: none; color: var(--vscode-foreground); font-family: var(--vscode-editor-font-family); font-size: 12px; text-align: left; }
  .row button:hover { color: var(--vscode-textLink-foreground); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { padding: 0 7px; border-radius: 8px; font-size: 11.5px; border: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 45%, transparent); background: none; color: var(--vscode-foreground); }
  .chip.ok { color: var(--vscode-testing-iconPassed, #73c991); }
  .acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 14px; font-size: 11.5px; color: var(--vscode-descriptionForeground); }
  .legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 50%; border: 1px solid; margin-right: 4px; vertical-align: -1px; }
  .legend .ok::before { border-color: var(--vscode-testing-iconPassed, #73c991); } .legend .weak::before { border-color: var(--vscode-editorWarning-foreground); }
  .legend .new::before { border-color: var(--vscode-textLink-foreground); } .legend .next::before { border-color: var(--vscode-testing-iconPassed, #73c991); border-style: dashed; }
  .legend .todo::before { border-style: dashed; }
  .pathbar { margin: 0 0 10px; padding: 6px 10px; border-radius: 6px; font-size: 12px; border: 1px solid var(--vscode-focusBorder); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .pathbar[hidden], .growth[hidden] { display: none; }
  select { font: inherit; font-size: 12px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, #8886); border-radius: 3px; }
  label { font-size: 12px; color: var(--vscode-descriptionForeground); display: inline-flex; gap: 4px; align-items: center; }
</style>
</head>
<body>
<div class="top">
  <h1>📘 개념 지도</h1>
  <span class="stat" id="stat"></span>
  <span class="grow"></span>
  <label>언어 <select id="lang"><option value="all">전체</option><option value="py">Python</option><option value="js">JavaScript · TypeScript</option></select></label>
  <label><input type="checkbox" id="hideTodo"> 안 배운 개념 숨기기</label>
  <button class="btn" id="countBtn" type="button">내 전체 코드에서 세기</button>
</div>
<div class="growth" id="growth" hidden></div>
<div class="toast" id="toast"></div>
<div class="pathbar" id="pathbar" hidden></div>
<div class="wrap">
  <div class="graph" id="graph"></div>
  <div class="detail" id="detail"></div>
</div>
<div class="legend"><span class="ok">탄탄 (모두 알겠음)</span><span class="weak">약함 (모름·헷갈림)</span><span class="new">처음 봄</span><span class="next">다음 추천 (먼저 알 것을 다 앎)</span><span class="todo">아직 안 배움</span><span>✦ AI 가 찾은 개념 · 숫자 = 공부한 코드 수 / 전체 코드 수</span></div>
<script nonce="${n}">
(function () {
  const vscode = acquireVsCodeApi();
  const CONCEPTS = ${conceptsJson()};
  const buildConceptGraph = ${buildConceptGraph.toString()};
  const learningPath = ${learningPath.toString()};
  const LEVEL = { 1: '기초', 2: '중급', 3: '심화' };
  const STATUS = { ok: '탄탄', weak: '약함', new: '처음 봄', next: '다음 추천', todo: '아직 안 배움' };
  const GRADE = { again: '모름', hard: '헷갈림', good: '알겠음' };
  const STATUS_ORDER = { weak: 0, new: 1, ok: 2, next: 3, todo: 4 };
  let snap = { cards: {}, known: {}, mastered: {} };
  let counts = null;
  let nodes = [];
  let sel = '';
  let path = [];
  let counting = false;
  let langPicked = false;
  let firstDraw = true;          // 처음 그릴 때만 튀어나오고 선이 그려진다
  let prevMastered = null;       // 새로 탄탄해진 개념을 반짝이게
  let glowIds = [];
  // 공부한 코드에서 가장 많이 쓴 언어를 기본으로 — 같은 이름(클래스·async)이 언어별로 두 번 나오지 않게
  function defaultLang() {
    let py = 0, js = 0;
    cards().forEach(function (c) { const l = String(c.language || '').toLowerCase(); if (l === 'python') { py++; } else if (/script|^js|^ts/.test(l)) { js++; } });
    return py && js ? 'all' : js ? 'js' : 'py';
  }
  function inLang(n, lang) {
    if (lang === 'all' || n.ai) { return true; }
    const c = conceptOf(n.id);
    if (!c) { return true; }
    return lang === 'py' ? c.langs.indexOf('py') >= 0 : (c.langs.indexOf('js') >= 0 || c.langs.indexOf('ts') >= 0);
  }
  const byId = function (id) { return document.getElementById(id); };
  const graph = byId('graph'), detail = byId('detail');
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) { e.className = cls; } if (text !== undefined) { e.textContent = text; } return e; }
  function nodeOf(id) { return nodes.find(function (x) { return x.id === id; }); }
  function conceptOf(id) { return CONCEPTS.find(function (c) { return c.id === id; }); }
  function cards() { return Object.keys(snap.cards).map(function (k) { return snap.cards[k]; }); }
  function untilText(iso) {
    if (!iso) { return ''; }
    const d = new Date(iso), t = new Date();
    const n = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
    return n <= 0 ? '오늘' : n === 1 ? '내일' : n + '일 뒤';
  }
  function aiInfo(n) {
    // AI 개념의 흔한 오해·비교는 그 개념을 준 카드에서 꺼낸다
    let found = null;
    cards().forEach(function (c) { (c.ai || []).forEach(function (a) { if (!found && ('ai:' + a.name === n.id || a.id === n.id)) { found = a; } }); });
    return found;
  }

  function render() {
    if (!langPicked) { byId('lang').value = defaultLang(); }
    const lang = byId('lang').value;
    nodes = buildConceptGraph(cards(), snap.known || {}, CONCEPTS).filter(function (n) { return inLang(n, lang); });
    const hide = byId('hideTodo').checked;
    const studied = nodes.filter(function (n) { return n.count > 0; });
    const nexts = nodes.filter(function (n) { return n.status === 'next'; });
    byId('stat').innerHTML = '';
    byId('stat').append('공부한 코드 ', el('b', '', String(cards().length)), ' · 배운 개념 ', el('b', '', String(studied.length)),
      ' · 약함 ', el('b', '', String(nodes.filter(function (n) { return n.status === 'weak'; }).length)), ' · 다음 추천 ', el('b', '', String(nexts.length)));
    // 성장 — 이번 달 새로 탄탄해진 개념
    const m = snap.mastered || {};
    const now = new Date();
    const month = Object.keys(m).filter(function (id) { const d = new Date(m[id]); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); });
    const g = byId('growth');
    g.hidden = !month.length;
    if (month.length) {
      g.replaceChildren(el('span', '', '이번 달 새로 익힌 개념 '), el('b', '', month.length + '개'),
        el('span', '', ' · ' + month.map(function (id) { const x = nodeOf(id) || conceptOf(id); return x ? x.name : id; }).join(', ')));
    }
    const btn = byId('countBtn');
    btn.textContent = counting ? '세는 중… (취소)' : counts ? '전체 코드 다시 세기' : '내 전체 코드에서 세기';
    btn.title = counts ? '마지막으로 센 때: ' + new Date(counts.at).toLocaleString() : '개념마다 검색해서 저장한 코드 전체에서 쓰인 수를 셉니다 (AI 0회)';

    // 마디
    graph.replaceChildren();
    const cols = {};
    [1, 2, 3].forEach(function (lv) {
      cols[lv] = el('div', 'col');
      cols[lv].append(el('div', 'colh', LEVEL[lv]));
      graph.append(cols[lv]);
    });
    const onPath = {};
    path.forEach(function (id, i) { onPath[id] = i + 1; });
    const related = {};
    if (sel) {
      related[sel] = true;
      const s = nodeOf(sel);
      if (s) { s.prereq.forEach(function (p) { related[p] = true; }); }
      nodes.forEach(function (n) { if (n.prereq.indexOf(sel) >= 0) { related[n.id] = true; } });
    }
    nodes.slice().sort(function (a, b) { return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.count - a.count || a.name.localeCompare(b.name); })
      .forEach(function (n) {
        if (hide && n.status === 'todo' && !onPath[n.id] && n.id !== sel) { return; }
        const b = el('button', 'node ' + n.status + (sel === n.id ? ' sel' : '') + ((sel && !related[n.id]) || (path.length && !onPath[n.id]) ? ' dim' : '')
          + (firstDraw ? ' pop' : '') + (glowIds.indexOf(n.id) >= 0 ? ' glow' : ''));
        b.type = 'button';
        b.dataset.id = n.id;
        if (firstDraw) { b.style.animationDelay = ((n.level - 1) * 260 + (cols[n.level].childElementCount - 1) * 45) + 'ms'; }
        if (onPath[n.id]) { const st = el('span', 'step', String(onPath[n.id])); st.style.animationDelay = (onPath[n.id] * 280) + 'ms'; b.append(st); }
        b.append(document.createTextNode(n.name + (n.ai ? ' ✦' : '')));
        const all = counts && counts.counts && typeof counts.counts[n.id] === 'number' ? counts.counts[n.id] : null;
        if (n.count || all !== null) { b.append(el('i', '', n.count + (all !== null ? ' / ' + all : ''))); }
        b.title = STATUS[n.status] + ' · ' + n.summary;
        b.addEventListener('click', function () { sel = sel === n.id ? '' : n.id; render(); });
        cols[n.level].append(b);
      });
    const draw = firstDraw;
    firstDraw = false;
    glowIds = [];
    requestAnimationFrame(function () { drawEdges(draw); });
    renderDetail();
  }

  function drawEdges(drawIn) {
    const old = graph.querySelector('svg.edges');
    if (old) { old.remove(); }
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'edges');
    const box = graph.getBoundingClientRect();
    const pos = {};
    graph.querySelectorAll('.node').forEach(function (b) { pos[b.dataset.id] = b.getBoundingClientRect(); });
    nodes.forEach(function (n) {
      n.prereq.forEach(function (p) {
        const a = pos[p], c = pos[n.id];
        if (!a || !c) { return; }
        const x1 = a.right - box.left, y1 = a.top + a.height / 2 - box.top;
        const x2 = c.left - box.left, y2 = c.top + c.height / 2 - box.top;
        const same = Math.abs(x2 - (a.left - box.left)) < 5;   // 같은 수준끼리는 왼쪽에서 휘게
        const d = same
          ? 'M' + (a.left - box.left) + ' ' + y1 + ' C' + (a.left - box.left - 30) + ' ' + y1 + ' ' + (x2 - 30) + ' ' + y2 + ' ' + x2 + ' ' + y2
          : 'M' + x1 + ' ' + y1 + ' C' + (x1 + 35) + ' ' + y1 + ' ' + (x2 - 35) + ' ' + y2 + ' ' + x2 + ' ' + y2;
        const path1 = document.createElementNS(NS, 'path');
        path1.setAttribute('d', d);
        const isOn = (sel && (p === sel || n.id === sel)) || (path.indexOf(p) >= 0 && path.indexOf(n.id) >= 0);
        const dim = (sel || path.length) && !isOn;
        path1.setAttribute('class', isOn ? 'on flow' : dim ? 'dim' : '');
        svg.append(path1);
        if (drawIn) {
          const len = path1.getTotalLength ? path1.getTotalLength() : 200;
          path1.style.setProperty('--len', String(len));
          path1.style.strokeDasharray = String(len);
          path1.classList.add('draw');
          path1.style.animationDelay = (420 + (nodeOf(n.id) ? (nodeOf(n.id).level - 1) * 260 : 0)) + 'ms';
          path1.addEventListener('animationend', function () { path1.style.strokeDasharray = ''; path1.classList.remove('draw'); }, { once: true });
        }
      });
    });
    graph.prepend(svg);
  }

  function renderDetail() {
    detail.replaceChildren();
    const n = sel ? nodeOf(sel) : null;
    if (!n) {
      const nexts = nodes.filter(function (x) { return x.status === 'next'; });
      const weak = nodes.filter(function (x) { return x.status === 'weak'; });
      detail.append(el('h2', '', '개념을 눌러 보세요'), el('div', 'muted', '설명 · 먼저 알 것 · 다음에 배울 것 · 내 코드가 여기에 나와요.'));
      if (weak.length) { detail.append(el('div', 'sec', '약한 개념')); detail.append(chipList(weak)); }
      if (nexts.length) { detail.append(el('div', 'sec', '다음에 배우면 좋은 것')); detail.append(chipList(nexts)); }
      return;
    }
    const c = conceptOf(n.id);
    const ai = n.ai ? aiInfo(n) : null;
    const h = el('h2', '', n.name + (n.ai ? ' ✦' : ''));
    const meta = el('div', '');
    meta.append(el('span', 'lv lv' + n.level, LEVEL[n.level]), el('span', 'muted', '  ' + STATUS[n.status] + (n.ai ? ' · AI 가 찾은 개념' : '')));
    detail.append(h, meta, el('p', '', n.summary || (ai && ai.summary) || ''));
    const mis = (ai && ai.misconception) || (c && c.misconception);
    const con = (ai && ai.contrast) || (c && c.contrast);
    if (mis) { const b = el('div', 'box mis'); b.append(el('b', '', '흔한 오해 '), document.createTextNode(mis)); detail.append(b); }
    if (con) { const b = el('div', 'box con'); b.append(el('b', '', '비슷하지만 다른 것 '), document.createTextNode(con)); detail.append(b); }
    if (n.prereq.length) {
      detail.append(el('div', 'sec', '먼저 알 것'));
      detail.append(chipList(n.prereq.map(nodeOf).filter(Boolean), true));
    }
    const after = nodes.filter(function (x) { return x.prereq.indexOf(n.id) >= 0; });
    if (after.length) { detail.append(el('div', 'sec', '이걸 알면 다음')); detail.append(chipList(after, true)); }
    detail.append(el('div', 'sec', '내 코드 ' + n.cards.length + '개' + (counts && counts.counts && typeof counts.counts[n.id] === 'number' ? ' · 저장한 전체 코드 중 ' + counts.counts[n.id] + '개' : '')));
    if (!n.cards.length) { detail.append(el('div', 'muted', '아직 이 개념을 공부한 코드가 없어요.')); }
    n.cards.forEach(function (k) {
      const card = snap.cards[k];
      if (!card) { return; }
      const r = el('div', 'row');
      const b = el('button', '', card.name);
      b.type = 'button';
      b.title = '사이드바에서 다시 공부';
      b.addEventListener('click', function () { vscode.postMessage({ type: 'openCard', key: k }); });
      r.append(b, el('span', 'muted', (GRADE[card.last] || '-') + ' · 다음 ' + untilText(card.due)));
      detail.append(r);
    });
    const acts = el('div', 'acts');
    const pathBtn = el('button', 'btn p', '여기까지 학습 경로');
    pathBtn.type = 'button';
    pathBtn.addEventListener('click', function () { showPath(n.id); });
    acts.append(pathBtn);
    if (n.cards.length) {
      const rv = el('button', 'btn', '이 개념 복습');
      rv.type = 'button';
      rv.title = '약한 코드부터 사이드바에서 열어요';
      rv.addEventListener('click', function () {
        const list = n.cards.map(function (k) { return snap.cards[k]; }).filter(Boolean)
          .sort(function (a, b) { const w = function (x) { return x.last === 'again' ? 0 : x.last === 'hard' ? 1 : 2; }; return w(a) - w(b) || (a.due < b.due ? -1 : 1); });
        if (list[0]) { vscode.postMessage({ type: 'openCard', key: list[0].key }); }
      });
      acts.append(rv);
    }
    if (c && c.doc) {
      const d = el('button', 'link', '📄 공식 문서');
      d.type = 'button';
      d.addEventListener('click', function () { vscode.postMessage({ type: 'openUrl', url: c.doc }); });
      acts.append(d);
    }
    detail.append(acts);
  }
  function chipList(list, mark) {
    const box = el('div', 'chips');
    list.forEach(function (x) {
      const b = el('button', 'chip' + (mark && x.status === 'ok' ? ' ok' : ''), x.name + (mark && x.status === 'ok' ? ' ✓' : ''));
      b.type = 'button';
      b.addEventListener('click', function () { sel = x.id; path = []; renderPath(); render(); });
      box.append(b);
    });
    return box;
  }

  function showPath(id) {
    path = learningPath(id, nodes).map(function (n) { return n.id; });
    renderPath();
    render();
  }
  function renderPath() {
    const bar = byId('pathbar');
    bar.hidden = !path.length;
    bar.replaceChildren();
    if (!path.length) { return; }
    const target = nodeOf(path[path.length - 1]);
    const left = path.filter(function (id) { const n = nodeOf(id); return n && n.status !== 'ok'; }).length;
    bar.append(el('b', '', '학습 경로 → ' + (target ? target.name : '')), el('span', 'muted', '  ' + path.length + '단계 · 남은 ' + left + '개 · '));
    path.forEach(function (id, i) {
      const n = nodeOf(id);
      if (!n) { return; }
      bar.append(el('span', n.status === 'ok' ? 'muted' : '', (i ? '→ ' : '') + n.name + (n.status === 'ok' ? ' ✓' : '')));
    });
    const close = el('button', 'link', '닫기');
    close.type = 'button';
    close.addEventListener('click', function () { path = []; renderPath(); render(); });
    bar.append(close);
  }

  byId('hideTodo').addEventListener('change', render);
  byId('lang').addEventListener('change', function () { langPicked = true; render(); });
  byId('countBtn').addEventListener('click', function () {
    if (counting) { vscode.postMessage({ type: 'cancelCount' }); return; }
    counting = true;
    render();
    vscode.postMessage({ type: 'countAll' });
  });
  window.addEventListener('resize', function () { requestAnimationFrame(function () { drawEdges(false); }); });
  window.addEventListener('message', function (e) {
    const msg = e.data;
    if (msg.type === 'data') {
      snap = msg.snapshot || snap;
      const nowM = Object.keys(snap.mastered || {});
      if (prevMastered) {
        glowIds = nowM.filter(function (id) { return prevMastered.indexOf(id) < 0; });
        if (glowIds.length) {
          const t = byId('toast');
          t.textContent = '🎉 새로 익힌 개념 · ' + glowIds.map(function (id) { const c = conceptOf(id); return c ? c.name : id.replace(/^ai:/, ''); }).join(', ');
          t.classList.add('in');
          setTimeout(function () { t.classList.remove('in'); }, 2800);
        }
      }
      prevMastered = nowM;
      counts = msg.counts;
      counting = false;
      if (msg.focus) { sel = msg.focus; path = []; renderPath(); }
      render();
    } else if (msg.type === 'countProgress') {
      byId('countBtn').textContent = '세는 중… ' + msg.done + '/' + msg.total + ' (취소)';
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
