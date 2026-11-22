import * as assert from 'assert';
import { Script } from 'vm';
import type * as Vscode from 'vscode';
import { ProjectLocations, ProjectRoot, relativeSourceParts } from '../projectLocations';

class MemoryState {
  readonly values = new Map<string, unknown>();
  keys(): readonly string[] { return [...this.values.keys()]; }
  get<T>(key: string): T | undefined;
  get<T>(key: string, fallback: T): T;
  get<T>(key: string, fallback?: T): T | undefined { return (this.values.has(key) ? this.values.get(key) : fallback) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, JSON.parse(JSON.stringify(value))); }
}

suite('원본 프로젝트 위치 — 프로젝트를 닫아도 다시 열기', () => {
  test('처음 연 위치를 기억하고 다른 프로젝트로 이동한 뒤에도 찾는다', async () => {
    const state = new MemoryState();
    let open: ProjectRoot[] = [{ name: 'first', uri: 'file:///C:/dev/first' }];
    const locations = new ProjectLocations(state, () => open);
    await locations.rememberOpen();
    open = [{ name: 'second', uri: 'file:///C:/dev/second' }];
    await locations.rememberOpen();
    assert.strictEqual(locations.rootFor('first'), 'file:///C:/dev/first');
    assert.strictEqual(locations.rootFor('second'), 'file:///C:/dev/second');
  });

  test('새 확장 세션에서도 기억한 위치를 읽는다', async () => {
    const state = new MemoryState();
    await new ProjectLocations(state, () => [{ name: 'sample', uri: 'file:///C:/dev/sample' }]).rememberOpen();
    const reopened = new ProjectLocations(state, () => []);
    assert.strictEqual(reopened.rootFor('sample'), 'file:///C:/dev/sample');
  });

  test('같은 이름의 프로젝트가 여러 위치에 있으면 임의로 고르지 않는다', async () => {
    const state = new MemoryState();
    let open = [{ name: 'sample', uri: 'file:///C:/first/sample' }];
    const locations = new ProjectLocations(state, () => open);
    await locations.rememberOpen();
    open = [{ name: 'sample', uri: 'file:///D:/second/sample' }];
    await locations.rememberOpen();
    assert.strictEqual(locations.rootFor('sample'), 'file:///D:/second/sample');
    open = [];
    assert.strictEqual(locations.rootFor('sample'), null);
  });

  test('사용자가 한 번 연결한 위치는 폴더를 열지 않고도 사용한다', async () => {
    const locations = new ProjectLocations(new MemoryState(), () => []);
    await locations.connect('old-project-name', 'file:///D:/renamed-project');
    assert.strictEqual(locations.rootFor('old-project-name'), 'file:///D:/renamed-project');
  });

  test('이동한 프로젝트를 다시 연결하면 사용자가 선택한 새 위치를 쓴다', async () => {
    const state = new MemoryState();
    const locations = new ProjectLocations(state, () => []);
    await locations.connect('sample', 'file:///C:/old/sample');
    await locations.connect('sample', 'file:///D:/new/sample');
    assert.strictEqual(locations.rootFor('sample'), 'file:///D:/new/sample');
  });

  test('로컬과 원격 확장 환경의 위치 기록을 구분한다', async () => {
    const state = new MemoryState();
    const local = new ProjectLocations(state, () => [], 'local');
    const remote = new ProjectLocations(state, () => [], 'dev-container');
    await local.connect('sample', 'file:///C:/dev/sample');
    await remote.connect('sample', 'file:///workspaces/sample');
    assert.strictEqual(local.rootFor('sample'), 'file:///C:/dev/sample');
    assert.strictEqual(remote.rootFor('sample'), 'file:///workspaces/sample');
  });

  test('폴더 이벤트와 수동 연결이 겹쳐도 두 기록을 보존한다', async () => {
    const locations = new ProjectLocations(new MemoryState(), () => [{ name: 'first', uri: 'file:///first' }]);
    await Promise.all([locations.rememberOpen(), locations.connect('second', 'file:///second')]);
    assert.strictEqual(locations.rootFor('first'), 'file:///first');
    assert.strictEqual(locations.rootFor('second'), 'file:///second');
  });

  test('깨진 기록과 웹 URL을 원본 프로젝트로 사용하지 않는다', () => {
    const state = new MemoryState();
    state.values.set('codeMemory.projectLocations.v1.local', [null, {},
      { name: 'sample', uri: 'https://example.com/project' },
      { name: 'sample', uri: 'file:///tmp/sample', preferred: 'yes' }]);
    assert.strictEqual(new ProjectLocations(state, () => []).rootFor('sample'), null);
  });

  test('프로젝트를 벗어나는 경로나 절대 경로는 상대 경로로 사용하지 않는다', () => {
    for (const path of ['../secret.py', 'src/../../secret.py', 'C:\\secret.py', '/tmp/secret.py', '\\\\server\\share\\x.py']) {
      assert.strictEqual(relativeSourceParts(path), null, path);
    }
    assert.deepStrictEqual(relativeSourceParts('src/utils.py'), ['src', 'utils.py']);
    assert.deepStrictEqual(relativeSourceParts('src\\utils.py'), ['src', 'utils.py']);
  });
});

type Loader = (id: string, parent?: { filename?: string }, isMain?: boolean) => unknown;

function navigationFixture(fileText: string) {
  class Uri {
    constructor(readonly value: string) {}
    static parse(value: string) { return new Uri(value); }
    static joinPath(root: Uri, ...parts: string[]) {
      const value = new URL(root.value);
      value.pathname = value.pathname.replace(/\/?$/, '/') + parts.join('/');
      return new Uri(value.toString());
    }
    get fsPath() { return decodeURIComponent(new URL(this.value).pathname); }
    toString() { return this.value; }
  }
  class Range {
    constructor(readonly startLine: number, readonly startCharacter: number,
      readonly endLine: number, readonly endCharacter: number) {}
  }
  class Emitter {
    readonly event = () => ({ dispose() {} });
    fire() {}
  }
  const opened: string[] = [];
  const selections: Range[] = [];
  const vscode = {
    Uri, Range, EventEmitter: Emitter,
    SymbolKind: { Function: 11, Method: 5, Constructor: 8 },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({ get: (name: string, fallback: unknown) => name === 'mock' ? false : name === 'apiUrl' ? 'http://ui.test' : fallback }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      fs: { readFile: async () => Buffer.from(fileText) },
      openTextDocument: async (uri: Uri) => {
        opened.push(uri.toString());
        const lines = fileText.split('\n');
        return { lineCount: lines.length, lineAt: (n: number) => ({ text: lines[n] }) };
      },
    },
    window: {
      showOpenDialog: async () => [Uri.parse('file:///D:/remembered/sample')],
      showTextDocument: async (_doc: unknown, options: { selection: Range }) => { selections.push(options.selection); },
      showWarningMessage: async () => undefined,
    },
  };
  const modules = require('module') as { _load: Loader };
  const original = modules._load;
  let sidebar: typeof import('../sidebar');
  const previous = require.cache[require.resolve('../sidebar')];
  try {
    modules._load = (id, parent, isMain) => id === 'vscode' ? vscode : original.call(modules, id, parent, isMain);
    delete require.cache[require.resolve('../sidebar')];
    sidebar = require('../sidebar') as typeof import('../sidebar');
  } finally {
    modules._load = original;
    if (previous) { require.cache[require.resolve('../sidebar')] = previous; }
    else { delete require.cache[require.resolve('../sidebar')]; }
  }
  const locations = new ProjectLocations(new MemoryState(), () => []);
  sidebar.useProjectLocations(locations);
  const state = new MemoryState();
  const provider = new sidebar.SearchViewProvider(state, new MemoryState(), {} as Vscode.SecretStorage);
  let receive: ((message: unknown) => Promise<void>) | undefined;
  let dispose = () => {};
  const messages: { type?: string; reqId?: number }[] = [];
  const webview = {
    html: '', cspSource: 'vscode-webview:', options: {},
    postMessage: async (message: { type?: string; reqId?: number }) => { messages.push(message); return true; },
    onDidReceiveMessage: (callback: (message: unknown) => Promise<void>) => { receive = callback; },
  };
  provider.resolveWebviewView({ webview, onDidDispose: (callback: () => void) => { dispose = callback; } } as unknown as Vscode.WebviewView);
  return { provider, locations, opened, selections, state, messages, html: webview.html, dispose: () => dispose(),
    receive: (message: unknown) => { assert.ok(receive); return receive(message); } };
}

const source = { id: 12, project_name: 'sample', file_path: 'sample.py', language: 'python',
  function_name: 'multiply', start_line: 1, end_line: 2, code: 'def multiply(a, b):\n    return a * b', score: 0.8 };

suite('원본 이동 연결 — 실제 확장 핸들러', () => {
  test('열린 프로젝트가 없어도 기억한 위치에서 파일과 줄 범위를 연다', async () => {
    const f = navigationFixture(source.code);
    await f.locations.connect('sample', 'file:///D:/remembered/sample');
    await f.receive({ type: 'open', result: source });
    assert.deepStrictEqual(f.opened, ['file:///D:/remembered/sample/sample.py']);
    assert.strictEqual(f.selections[0].startLine, 0);
    assert.strictEqual(f.selections[0].endLine, 1);
  });

  test('한 번 위치를 연결하면 작업 영역을 추가하지 않고 이동한 코드의 새 줄을 연다', async () => {
    const f = navigationFixture('# added line\n' + source.code);
    await f.provider.connectSourceProject(source);
    assert.strictEqual(f.locations.rootFor('sample'), 'file:///D:/remembered/sample');
    assert.deepStrictEqual(f.opened, ['file:///D:/remembered/sample/sample.py']);
    assert.strictEqual(f.selections[0].startLine, 1);
    assert.strictEqual(f.selections[0].endLine, 2);
  });

  test('원본 연결을 포함한 실제 웹뷰 스크립트의 문법이 유효하다', () => {
    const f = navigationFixture(source.code);
    const scripts = [...f.html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length > 0);
    for (const script of scripts) { assert.doesNotThrow(() => new Script(script[1])); }
  });
});

async function withPendingSearches(run: (f: ReturnType<typeof navigationFixture>, requests: {
  resolve: (response: Response) => void; reject: (error: Error) => void;
}[]) => Promise<void>) {
  const original = globalThis.fetch;
  const requests: { resolve: (response: Response) => void; reject: (error: Error) => void }[] = [];
  globalThis.fetch = (() => new Promise<Response>((resolve, reject) => { requests.push({ resolve, reject }); })) as typeof fetch;
  try { await run(navigationFixture(source.code), requests); }
  finally { globalThis.fetch = original; }
}

async function waitForRequests(requests: unknown[], count: number) {
  for (let i = 0; i < 100 && requests.length < count; i++) { await new Promise<void>((resolve) => setImmediate(resolve)); }
  assert.strictEqual(requests.length, count);
}

function searchResponse() { return new Response(JSON.stringify({ results: [source], filters: { project: null, language: null } }), { status: 200 }); }

suite('검색 응답 순서 — 화면과 재로드 상태', () => {
  test('늦은 이전 응답은 최신 검색의 저장 상태를 덮어쓰지 않는다', async () => {
    await withPendingSearches(async (f, requests) => {
      const first = f.receive({ type: 'search', query: 'first', reqId: 1 });
      await waitForRequests(requests, 1);
      const second = f.receive({ type: 'search', query: 'second', reqId: 2 });
      await waitForRequests(requests, 2);
      requests[1].resolve(searchResponse()); await second;
      requests[0].resolve(searchResponse()); await first;
      assert.strictEqual(f.state.get<{ query: string }>('codeMemory.lastSearch')?.query, 'second');
    });
  });

  test('이전 요청의 늦은 오류를 최신 검색 화면에 보내지 않는다', async () => {
    await withPendingSearches(async (f, requests) => {
      const first = f.receive({ type: 'search', query: 'first', reqId: 1 });
      await waitForRequests(requests, 1);
      const second = f.receive({ type: 'search', query: 'second', reqId: 2 });
      await waitForRequests(requests, 2);
      requests[1].resolve(searchResponse()); await second;
      requests[0].reject(new Error('old request failed')); await first;
      assert.ok(!f.messages.some((message) => message.type === 'error' && message.reqId === 1));
    });
  });

  test('뷰를 닫은 뒤 끝난 요청은 복원할 검색 상태를 덮어쓰지 않는다', async () => {
    await withPendingSearches(async (f, requests) => {
      const pending = f.receive({ type: 'search', query: 'old view', reqId: 1 });
      await waitForRequests(requests, 1);
      f.dispose(); requests[0].resolve(searchResponse()); await pending;
      assert.strictEqual(f.state.get('codeMemory.lastSearch'), undefined);
    });
  });
});
