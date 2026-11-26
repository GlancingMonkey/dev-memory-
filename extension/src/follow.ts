import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { parseStudyResult, RunResult, TraceResult } from './study';

// ─────────────────────────────────────────────
// 내 PC 에서 직접 실행 (Python) — 실행 따라가기 기록 · 깨뜨려 보기 · 바꿔 보기 채점을 Backend 없이
//   처음 실행할 때 확인창. 5초 넘으면 멈춘다. 기록 모양은 POST /study/trace · run 과 같다
// 편집기에서 따라가기 — 지금 줄 강조 · 줄 끝 값 · 줄별 실행 횟수 · 상태 표시줄 · F10 / Esc
// ─────────────────────────────────────────────

const RUN_OK_KEY = 'codeMemory.localRunOk';
const TIMEOUT_MS = 5000;

// 기록용 파이썬 스크립트 — stdin 으로 {mode, code, call, calls, tests} 를 받아 stdout 마지막 줄에 JSON
const TRACER = String.raw`
import sys, json, io, contextlib, reprlib, traceback
data = json.loads(sys.stdin.read())
code = data.get('code', '')
mode = data.get('mode', 'trace')
MAX = int(data.get('max_steps', 400))
rp = reprlib.Repr(); rp.maxlist = 12; rp.maxstring = 40; rp.maxother = 40; rp.maxdict = 8; rp.maxlevel = 3
def r(v):
    try: return rp.repr(v)
    except Exception: return '<?>'
def keep(k, v):
    return not k.startswith('__') and not callable(v) and type(v).__name__ != 'module'
g = {'__name__': '__codememory__'}
out = io.StringIO()
result = {}
try:
    with contextlib.redirect_stdout(out):
        exec(compile(code, '<cm>', 'exec'), g)
except Exception as e:
    print(json.dumps({'error': 'SyntaxError/로드 실패: ' + type(e).__name__ + ': ' + str(e)}))
    sys.exit(0)

if mode == 'run':
    cases = []
    items = [{'call': c, 'expected': ''} for c in data.get('calls', [])] or data.get('tests', [])
    for t in items[:20]:
        call = t.get('call', '')
        exp = t.get('expected', '')
        try:
            with contextlib.redirect_stdout(out):
                v = eval(compile(call, '<call>', 'eval'), g)
            o = repr(v)
            ok = (o.replace(' ', '') == exp.replace(' ', '')) if exp else None
            cases.append({'call': call, 'output': o[:500], 'error': '', 'expected': exp, 'ok': ok})
        except Exception as e:
            cases.append({'call': call, 'output': '', 'error': (type(e).__name__ + ': ' + str(e))[:500], 'expected': exp, 'ok': False if exp else None})
    print(json.dumps({'cases': cases}, ensure_ascii=False))
    sys.exit(0)

call = data.get('call', '')
steps = []
class Stop(Exception): pass
def frames_of(f):
    fs = []
    while f is not None:
        fn = f.f_code.co_filename
        if fn == '<cm>':
            name = f.f_code.co_name
            vars_ = {k: r(v) for k, v in list(f.f_locals.items()) if keep(k, v)}
            fs.append({'name': name, 'vars': vars_, '_locals': f.f_locals})
        elif fn == '<call>':
            fs.append({'name': '부른 곳', 'vars': {}, '_locals': {}})
        f = f.f_back
    fs.reverse()
    return fs
def snapshot(frame, ret=''):
    fs = frames_of(frame)
    objs = []
    if fs:
        top = fs[-1]['_locals']
        for k, v in list(top.items()):
            if isinstance(v, (list, tuple)) and keep(k, v):
                objs.append({'label': k, 'items': [r(x) for x in list(v)[:40]], 'look': -1, 'marks': []})
    for f in fs: f.pop('_locals', None)
    return {'line': frame.f_lineno, 'say': '', 'frames': fs, 'objects': objs[:4], 'ret': ret}
def tr(frame, event, arg):
    if frame.f_code.co_filename != '<cm>':
        return tr
    if len(steps) >= MAX:
        raise Stop()
    if event == 'line':
        steps.append(snapshot(frame))
    elif event == 'return':
        s = snapshot(frame, frame.f_code.co_name + '() = ' + r(arg))
        s['say'] = frame.f_code.co_name + ' 이(가) ' + r(arg) + ' 을(를) 돌려줘요'
        steps.append(s)
    return tr
err = ''
value = None
truncated = False
try:
    sys.settrace(tr)
    with contextlib.redirect_stdout(out):
        value = eval(compile(call, '<call>', 'eval'), g)
except Stop:
    truncated = True
except Exception as e:
    err = type(e).__name__ + ': ' + str(e)
finally:
    sys.settrace(None)
# 줄마다 무엇이 바뀌었는지 한 줄 설명
prev = {}
for s in steps:
    if s['say']: continue
    top = s['frames'][-1]['vars'] if s['frames'] else {}
    ch = [k + ' = ' + v for k, v in top.items() if prev.get(k) != v]
    s['say'] = (', '.join(ch[:3]) if ch else '') or (str(s['line']) + '번째 줄')
    prev = top
if err:
    steps.append({'line': steps[-1]['line'] if steps else 1, 'say': '오류로 멈췄어요: ' + err, 'frames': [], 'objects': [], 'ret': err})
print(json.dumps({'call': call, 'steps': steps, 'truncated': truncated, 'value': r(value), 'stdout': out.getvalue()[-500:]}, ensure_ascii=False))
`;

export class LocalRunError extends Error {
  constructor(public readonly kind: 'nopython' | 'timeout' | 'declined' | 'failed', message: string) {
    super(message);
  }
}

function pythonCandidates(): string[] {
  const set = vscode.workspace.getConfiguration('codeMemory').get<string>('pythonPath', '').trim();
  if (set) { return [set]; }
  return process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
}

function runPython(cmd: string, payload: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, ['-I', '-c', TRACER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    } catch (err) {
      reject(err);
      return;
    }
    let out = '';
    let errText = '';
    const timer = setTimeout(() => { child.kill(); reject(new LocalRunError('timeout', `${TIMEOUT_MS / 1000}초가 넘어서 멈췄어요. 무한 반복이 있는지 보세요.`)); }, TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); if (out.length > 4_000_000) { child.kill(); } });
    child.stderr.on('data', (d: Buffer) => { errText += d.toString('utf8'); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', () => {
      clearTimeout(timer);
      const last = out.trim().split('\n').pop() ?? '';
      if (!last.startsWith('{')) {
        reject(new LocalRunError('failed', ('실행 결과를 읽지 못했어요 ' + errText.trim().split('\n').pop()).trim()));
        return;
      }
      resolve(last);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export class LocalRunner {
  private python: string | undefined;
  constructor(private readonly global: vscode.Memento) {}

  static supports(language: string): boolean {
    return String(language || '').toLowerCase() === 'python'
      && vscode.workspace.getConfiguration('codeMemory').get<boolean>('localRun', true);
  }

  // 처음 실행할 때만 확인 (프로젝트별). "다시 묻지 않기"는 globalState 에
  private async confirm(what: string): Promise<void> {
    const project = vscode.workspace.workspaceFolders?.[0]?.name ?? '(폴더 없음)';
    const ok = this.global.get<string[]>(RUN_OK_KEY, []);
    if (ok.includes(project)) { return; }
    const pick = await vscode.window.showWarningMessage('이 코드를 내 PC 에서 실행할까요?', {
      modal: true,
      detail: `${what} 을(를) 이 PC 의 Python 으로 실행해요. 파일을 지우거나 네트워크를 쓰는 코드라면 실행하지 마세요. ${TIMEOUT_MS / 1000}초 넘으면 멈춰요.`,
    }, '실행', '실행하고 이 프로젝트에서는 다시 묻지 않기');
    if (!pick) { throw new LocalRunError('declined', '실행을 취소했어요'); }
    if (pick !== '실행') { await this.global.update(RUN_OK_KEY, [...ok, project].slice(-50)); }
  }

  private async exec(payload: Record<string, unknown>): Promise<unknown> {
    const tried = this.python ? [this.python] : pythonCandidates();
    let lastErr: unknown;
    for (const cmd of tried) {
      try {
        const text = await runPython(cmd, payload);
        this.python = cmd;
        const data = JSON.parse(text) as Record<string, unknown>;
        if (typeof data.error === 'string') { throw new LocalRunError('failed', data.error); }
        return data;
      } catch (err) {
        if (err instanceof LocalRunError) { throw err; }
        lastErr = err;   // 실행 파일이 없으면 다음 후보
      }
    }
    throw new LocalRunError('nopython', 'Python 을 찾지 못했어요. 설정 codeMemory.pythonPath 에 python 실행 파일 경로를 넣어 주세요. '
      + (lastErr instanceof Error ? `(${lastErr.message})` : ''));
  }

  async trace(code: string, call: string): Promise<TraceResult> {
    await this.confirm(call || '이 코드');
    const data = await this.exec({ mode: 'trace', code, call });
    return parseStudyResult('trace', data) as TraceResult;
  }

  async run(code: string, calls: string[], tests: { call: string; expected: string }[]): Promise<RunResult> {
    await this.confirm(tests.length ? `테스트 ${tests.length}개` : calls.join(', '));
    const data = await this.exec({ mode: 'run', code, calls, tests });
    return parseStudyResult('run', data) as RunResult;
  }
}

// ── 편집기에서 따라가기
export interface FollowTarget {
  uri?: string;          // 편집기에서 시작했으면 그 파일
  file_path?: string;    // 검색 결과에서 시작했으면 상대 경로
  start_line: number;    // 코드가 파일에서 시작하는 줄 (1부터)
  code: string;
}

export class EditorFollower {
  private readonly current = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
    borderWidth: '0 0 0 3px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('focusBorder'),
    overviewRulerColor: new vscode.ThemeColor('focusBorder'), overviewRulerLane: vscode.OverviewRulerLane.Full,
  });
  private readonly values = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 2.5em', color: new vscode.ThemeColor('editorInlayHint.foreground'), fontStyle: 'italic' },
  });
  private readonly heat = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 1.5em', color: new vscode.ThemeColor('editorCodeLens.foreground') },
  });
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 200);
  private trace: TraceResult | undefined;
  private target: FollowTarget | undefined;
  private editor: vscode.TextEditor | undefined;
  private offset = 0;   // 기록의 줄 → 문서 줄 (0부터)

  constructor() {
    this.status.command = 'codeMemory.followStop';
  }

  dispose(): void {
    this.stop();
    this.current.dispose();
    this.values.dispose();
    this.heat.dispose();
    this.status.dispose();
  }

  get active(): boolean {
    return !!this.trace;
  }

  // 새 기록 — 편집기에서 그 코드를 찾는다. 못 찾으면 false (사이드바에서만 따라감)
  async start(trace: TraceResult, target: FollowTarget): Promise<boolean> {
    this.stop();
    this.trace = trace;
    this.target = target;
    const editor = await this.findEditor(target);
    if (!editor) {
      this.trace = undefined;
      return false;
    }
    this.editor = editor;
    await vscode.commands.executeCommand('setContext', 'codeMemory.following', true);
    return true;
  }

  private async findEditor(t: FollowTarget): Promise<vscode.TextEditor | undefined> {
    let doc: vscode.TextDocument | undefined;
    try {
      if (t.uri) {
        doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(t.uri));
      } else if (t.file_path) {
        const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.path.endsWith('/' + t.file_path!.replace(/^\/+/, '')));
        if (open) {
          doc = open;
        } else {
          const found = await vscode.workspace.findFiles('**/' + t.file_path.replace(/^\/+/, ''), '**/node_modules/**', 1);
          if (found[0]) { doc = await vscode.workspace.openTextDocument(found[0]); }
        }
      }
    } catch {
      doc = undefined;
    }
    if (!doc) { return undefined; }
    // 코드가 그 줄에 그대로 있는지 확인, 옮겨졌으면 첫 줄로 다시 찾기
    const first = t.code.replace(/\r\n/g, '\n').split('\n')[0].trim();
    let start = Math.max(0, t.start_line - 1);
    if (start >= doc.lineCount || doc.lineAt(start).text.trim() !== first) {
      start = -1;
      for (let i = 0; i < doc.lineCount; i++) {
        if (first && doc.lineAt(i).text.trim() === first) { start = i; break; }
      }
      if (start < 0) { return undefined; }
    }
    this.offset = start;
    return vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true, viewColumn: vscode.ViewColumn.One });
  }

  // 사이드바 플레이어가 단계를 바꿀 때마다
  show(step: number): void {
    const ed = this.editor;
    const tr = this.trace;
    if (!ed || !tr) { return; }
    if (step < 0 || step >= tr.steps.length) {
      ed.setDecorations(this.current, []);
      ed.setDecorations(this.values, []);
      ed.setDecorations(this.heat, []);
      this.status.text = '$(debug-start) 따라가기 준비 · F10 한 단계 · Esc 멈춤';
      this.status.show();
      return;
    }
    const cur = tr.steps[step];
    const line = this.offset + cur.line - 1;
    if (line < 0 || line >= ed.document.lineCount) { return; }
    const range = new vscode.Range(line, 0, line, ed.document.lineAt(line).text.length);
    ed.setDecorations(this.current, [range]);
    const top = cur.frames[cur.frames.length - 1];
    const text = top ? Object.keys(top.vars).slice(0, 4).map((k) => `${k} = ${top.vars[k]}`).join(' · ') : '';
    ed.setDecorations(this.values, text || cur.ret ? [{ range, renderOptions: { after: { contentText: '  ' + (cur.ret || text) } } }] : []);
    // 지금까지 실행된 횟수
    const counts = new Map<number, number>();
    tr.steps.slice(0, step + 1).forEach((s) => counts.set(s.line, (counts.get(s.line) ?? 0) + 1));
    const heat: vscode.DecorationOptions[] = [];
    counts.forEach((n, l) => {
      const dl = this.offset + l - 1;
      if (dl === line || dl < 0 || dl >= ed.document.lineCount) { return; }
      const r = new vscode.Range(dl, ed.document.lineAt(dl).text.length, dl, ed.document.lineAt(dl).text.length);
      heat.push({ range: r, renderOptions: { after: { contentText: '×' + n } } });
    });
    ed.setDecorations(this.heat, heat);
    ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.status.text = `$(debug-step-over) 따라가는 중 ${step + 1} / ${tr.steps.length} · F10 한 단계 · Esc 멈춤`;
    this.status.show();
  }

  stop(): void {
    if (this.editor) {
      this.editor.setDecorations(this.current, []);
      this.editor.setDecorations(this.values, []);
      this.editor.setDecorations(this.heat, []);
    }
    this.editor = undefined;
    this.trace = undefined;
    this.target = undefined;
    this.status.hide();
    void vscode.commands.executeCommand('setContext', 'codeMemory.following', false);
  }
}
