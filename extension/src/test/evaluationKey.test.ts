import * as assert from 'assert';
import type { SearchViewProvider } from '../sidebar';

type Loader = (id: string, parent?: { filename?: string }, isMain?: boolean) => unknown;

function fixture(selected: { key: { provider: 'anthropic'; value: string } | undefined; keyUsed: string | null; keyBlocked: boolean }) {
  const asks: { key?: { provider: string; value: string } }[] = [];
  let searches = 0;
  let keyReads = 0;
  const warnings: string[] = [];
  const titles: string[] = [];
  const config = { get: (name: string, fallback: unknown) => name === 'mock' ? false : name === 'searchLimit' ? 10 : fallback };
  const vscode = {
    workspace: {
      getConfiguration: () => config,
      fs: { readFile: async () => Buffer.from(JSON.stringify({ questions: [
        { id: 'Q1', q: '첫 질문', expected: [1] }, { id: 'Q2', q: '둘째 질문', expected: [1] },
      ] })) },
      asRelativePath: () => 'eval/questions.json',
    },
    ProgressLocation: { Notification: 15 },
    window: {
      showWarningMessage: (message: string) => { warnings.push(message); },
      withProgress: async (options: { title: string }, task: (progress: unknown, token: unknown) => Promise<void>) => {
        titles.push(options.title);
        await task({ report: () => undefined }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) });
      },
    },
  };
  const sidebar = {
    searchSnippets: async () => { searches++; return { results: [{ id: 1 }] }; },
    askBackend: async (_q: string, options: { key?: { provider: string; value: string } }) => {
      asks.push(options); return { status: 'answered', usage: { total_tokens: 7 }, citations: [] };
    },
    SearchError: class extends Error {},
  };
  const modules = require('module') as { _load: Loader };
  const original = modules._load;
  let EvaluationRunner: typeof import('../evaluation').EvaluationRunner;
  try {
    modules._load = (id, parent, isMain) => {
      if (id === 'vscode') { return vscode; }
      if (id === './sidebar' && parent?.filename?.endsWith('evaluation.js')) { return sidebar; }
      return original.call(modules, id, parent, isMain);
    };
    delete require.cache[require.resolve('../evaluation')];
    EvaluationRunner = (require('../evaluation') as typeof import('../evaluation')).EvaluationRunner;
  } finally {
    modules._load = original;
  }
  const provider = { keyForRequest: async () => { keyReads++; return selected; } };
  const runner = new EvaluationRunner(provider as unknown as SearchViewProvider) as unknown as {
    run: (input: { file: unknown; mode: 'search' | 'ask' }) => Promise<void>;
    show: (mock: boolean) => void;
    lastResult?: { meta: string };
    running: boolean;
  };
  runner.show = () => undefined;
  return { runner, asks, warnings, titles, keyReads: () => keyReads, searches: () => searches };
}

suite('팀 평가의 개인 AI 키 연결', () => {
  test('질문마다 선택한 개인 키를 전달하고 제공자만 결과에 표시한다', async () => {
    const key = { provider: 'anthropic' as const, value: 'TEST_ONLY_EVALUATION_KEY' };
    const f = fixture({ key, keyUsed: 'Anthropic (Claude)', keyBlocked: false });
    await f.runner.run({ file: {}, mode: 'ask' });
    assert.strictEqual(f.keyReads(), 1);
    assert.strictEqual(f.asks.length, 2);
    assert.ok(f.asks.every((options) => options.key === key));
    assert.ok(f.runner.lastResult?.meta.includes('Anthropic (Claude)'));
    assert.ok(!f.runner.lastResult?.meta.includes(key.value));
    assert.ok(f.titles[0].includes('Anthropic (Claude)'));
    assert.strictEqual(f.runner.running, false);
  });
  test('서버 기본 키를 선택한 경우 개인 키를 보내지 않는다', async () => {
    const f = fixture({ key: undefined, keyUsed: null, keyBlocked: false });
    await f.runner.run({ file: {}, mode: 'ask' });
    assert.ok(f.asks.every((options) => options.key === undefined));
    assert.ok(f.runner.lastResult?.meta.includes('서버 기본 키'));
  });
  test('검색 전용 평가는 비밀 저장소와 AI 요청을 사용하지 않는다', async () => {
    const f = fixture({ key: undefined, keyUsed: null, keyBlocked: false });
    await f.runner.run({ file: {}, mode: 'search' });
    assert.strictEqual(f.keyReads(), 0);
    assert.strictEqual(f.asks.length, 0);
    assert.strictEqual(f.searches(), 2);
  });
  test('개인 키를 전송할 수 없는 주소는 서버 키로 조용히 전환하지 않고 중단한다', async () => {
    const f = fixture({ key: undefined, keyUsed: null, keyBlocked: true });
    await f.runner.run({ file: {}, mode: 'ask' });
    assert.strictEqual(f.asks.length, 0);
    assert.strictEqual(f.searches(), 0);
    assert.strictEqual(f.warnings.length, 1);
    assert.strictEqual(f.runner.running, false);
  });
});
