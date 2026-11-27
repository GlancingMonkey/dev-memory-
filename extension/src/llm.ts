import * as vscode from 'vscode';
import { LlmProvider } from './logic';

// ─────────────────────────────────────────────
// AI 대화를 내 키로 바로 — 🔑 AI 키에 넣은 OpenAI · Anthropic · Gemini 키로 그 회사 API 를 직접 부른다
//   키가 없으면 지금처럼 Backend /ask (chat.ts). 답은 흘러나오는 대로(스트리밍) 보낸다
//   모델은 설정 codeMemory.chatModel (비우면 회사별 가볍고 싼 모델)
// ─────────────────────────────────────────────

export interface LlmMessage { role: 'user' | 'assistant'; content: string }

// 2026-11 기준 각 회사 문서의 가볍고 싼 기본 모델
export const DEFAULT_MODELS: Record<LlmProvider, string> = {
  openai: 'gpt-6-luna',
  anthropic: 'claude-haiku-5-5',
  google: 'gemini-3.5-flash-lite',
};

export class LlmError extends Error {
  constructor(public readonly kind: 'key' | 'model' | 'limit' | 'connect' | 'server', message: string) {
    super(message);
  }
}

export function chatModel(provider: LlmProvider): string {
  const set = vscode.workspace.getConfiguration('codeMemory').get<string>('chatModel', '').trim();
  return set || DEFAULT_MODELS[provider];
}

// 서버가 보내는 "data: …" 줄을 하나씩
async function* sseData(res: Response): AsyncGenerator<string> {
  if (!res.body) { return; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) { break; }
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) { yield line.slice(5).trim(); }
    }
  }
  if (buf.startsWith('data:')) { yield buf.slice(5).trim(); }
}

function parse(s: string): Record<string, unknown> | undefined {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return undefined; }
}

async function failure(res: Response, provider: LlmProvider, model: string): Promise<LlmError> {
  const text = await res.text().catch(() => '');
  const body = parse(text);
  const err = body && typeof body.error === 'object' && body.error ? body.error as Record<string, unknown> : undefined;
  const msg = String(err?.message ?? (typeof body?.error === 'string' ? body.error : '') ?? '').slice(0, 300);
  const who = provider === 'openai' ? 'OpenAI' : provider === 'anthropic' ? 'Anthropic' : 'Gemini';
  if (res.status === 401 || res.status === 403) { return new LlmError('key', `${who} 키가 맞지 않아요. 🔑 AI 키에서 확인해 주세요. ${msg}`.trim()); }
  if (res.status === 404 || (res.status === 400 && /model/i.test(msg))) {
    return new LlmError('model', `${who} 에서 모델 ${model} 을(를) 쓸 수 없어요. 설정 codeMemory.chatModel 에 다른 모델을 넣어 보세요. ${msg}`.trim());
  }
  if (res.status === 429) { return new LlmError('limit', `${who} 사용량 한도에 걸렸어요. 잠시 뒤 다시 하거나 요금제를 확인해 주세요. ${msg}`.trim()); }
  return new LlmError('server', `${who} 가 답하지 못했어요 (HTTP ${res.status}). ${msg}`.trim());
}

export async function streamChat(opts: {
  provider: LlmProvider;
  key: string;
  system: string;
  messages: LlmMessage[];
  signal: AbortSignal;
  onDelta: (text: string) => void;
}): Promise<string> {
  const { provider, key, system, messages, signal, onDelta } = opts;
  const model = chatModel(provider);
  let res: Response;
  let out = '';
  const add = (t: unknown) => { if (typeof t === 'string' && t) { out += t; onDelta(t); } };
  try {
    if (provider === 'openai') {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, stream: true, messages: [{ role: 'system', content: system }, ...messages] }),
      });
    } else if (provider === 'anthropic') {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 2000, stream: true, system, messages }),
      });
    } else {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        }),
      });
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') { throw err; }
    throw new LlmError('connect', 'AI 회사 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.');
  }
  if (!res.ok) { throw await failure(res, provider, model); }
  for await (const data of sseData(res)) {
    if (data === '[DONE]') { break; }
    const j = parse(data);
    if (!j) { continue; }
    if (provider === 'openai') {
      const ch = Array.isArray(j.choices) ? j.choices[0] as Record<string, unknown> : undefined;
      add((ch?.delta as Record<string, unknown> | undefined)?.content);
    } else if (provider === 'anthropic') {
      if (j.type === 'content_block_delta') { add((j.delta as Record<string, unknown> | undefined)?.text); }
      if (j.type === 'error') { throw new LlmError('server', String((j.error as Record<string, unknown> | undefined)?.message ?? 'Anthropic 오류')); }
    } else {
      const cand = Array.isArray(j.candidates) ? j.candidates[0] as Record<string, unknown> : undefined;
      const parts = (cand?.content as Record<string, unknown> | undefined)?.parts;
      if (Array.isArray(parts)) { parts.forEach((p) => add((p as Record<string, unknown>).text)); }
    }
  }
  return out;
}

// ── 공부 AI 를 내 키로 — Backend POST /study/{mode} 와 같은 JSON 모양을 직접 받는다
async function complete(provider: LlmProvider, key: string, system: string, user: string, signal?: AbortSignal): Promise<string> {
  const model = chatModel(provider);
  let res: Response;
  try {
    if (provider === 'openai') {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
    } else if (provider === 'anthropic') {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] }),
      });
    } else {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { responseMimeType: 'application/json' } }),
      });
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') { throw err; }
    throw new LlmError('connect', 'AI 회사 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.');
  }
  if (!res.ok) { throw await failure(res, provider, model); }
  const j = parse(await res.text()) ?? {};
  if (provider === 'openai') {
    const ch = Array.isArray(j.choices) ? j.choices[0] as Record<string, unknown> : undefined;
    return String((ch?.message as Record<string, unknown> | undefined)?.content ?? '');
  }
  if (provider === 'anthropic') {
    return (Array.isArray(j.content) ? j.content : []).map((c) => String((c as Record<string, unknown>).text ?? '')).join('');
  }
  const cand = Array.isArray(j.candidates) ? j.candidates[0] as Record<string, unknown> : undefined;
  const parts = (cand?.content as Record<string, unknown> | undefined)?.parts;
  return Array.isArray(parts) ? parts.map((p) => String((p as Record<string, unknown>).text ?? '')).join('') : '';
}

// 답에서 JSON 만 꺼내기 (```json 울타리 · 앞뒤 말 허용)
export function pickJson(text: string): unknown {
  const t = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try { return JSON.parse(t); } catch { /* 아래에서 다시 */ }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch { /* 형식 오류 */ }
  }
  throw new LlmError('server', 'AI 답을 읽지 못했어요 (JSON 형식이 아님). 다시 눌러 주세요.');
}

const STUDY_SYSTEM = [
  '너는 코딩 공부 도우미야. 상대는 코드를 처음 배우는 사람일 수도 있어.',
  '설명은 한국어 존댓말(~요)로 짧고 정확하게, 전문 용어는 쉬운 말로 풀어서. 코드 안 식별자는 그대로.',
  '반드시 요청한 JSON 객체 하나만 답해. 다른 말이나 마크다운은 쓰지 마.',
].join('\n');

const SHAPES: Record<string, string> = {
  plain: '{"one_line":"이 코드가 하는 일 한 문장 (전문 용어 없이)","analogy":"일상 비유 한 문장","use":"어디에 쓰는지 한 문장"}',
  lines: '{"lines":[{"line":코드 안 줄 번호(1부터),"plain":"그 줄의 쉬운 설명 한두 문장"}]} (빈 줄은 빼)',
  narrate: '{"summary":"전체 실행을 쉬운 말로 두세 문장","steps":["1단계 해설","2단계 해설"]} (steps 는 기록의 단계 수와 정확히 같게, 각 1~2문장: 그 줄이 무엇을 하고 값이 어떻게 바뀌는지)',
  explain: '{"points":[{"verdict":"ok" 또는 "partial" 또는 "wrong","text":"짚을 점 한 문장","lines":[관련 줄 번호]}]}',
  why: '{"alternatives":[{"label":"다른 방법 이름","code":"코드","speed":"빠름/같음/느림","memory":"적음/같음/많음","readability":"쉬움/보통/어려움","note":"이 코드와 비교한 장단점"}],"complexity":{"time":"O(...)","space":"O(...)","note":"쉬운 설명"},"deeper":[{"title":"한 단계 더","text":"안에서 일어나는 일","doc":"https 공식 문서 주소 또는 빈 문자열"}]}',
  translate: '{"language":"바꾼 언어","code":"옮긴 코드","notes":[{"from":"원래 조각","to":"바꾼 조각","why":"왜 다른지"}]}',
  review: '{"items":[{"kind":"good" 또는 "fix" 또는 "warn","title":"짧은 제목","text":"설명","lines":[줄 번호]}],"improved_code":"고친 전체 코드 (함수 이름과 동작 유지)"}',
  task: '{"task":"과제 설명 두세 문장","starter":"고치기 시작할 코드","tests":[{"call":"호출식","expected":"기대 결과 (Python 은 repr, JavaScript 는 JSON.stringify 결과)"}]} (테스트 3~5개)',
  bug: '{"code":"틀린 곳 하나를 넣은 전체 코드","line":틀린 줄 번호(1부터),"explain":"무엇이 왜 틀렸는지","fixed_line":"고친 줄"}',
  concepts: '{"concepts":[{"id":"아래 목록의 id 또는 null","name":"개념 이름","level":1 또는 2 또는 3,"summary":"설명","in_this_code":"이 코드의 어디서 어떻게 쓰였는지","lines":[줄 번호],"prereq":["먼저 알 개념 이름"],"misconception":"흔한 오해","contrast":"비슷하지만 다른 것"}]} (3~6개)',
  distractors: '{"choices":["헷갈리는 오답 1","오답 2","오답 3"]} (정답과 다르고, 흔한 착각에서 나올 법한 실행 결과 모양으로)',
};

export function studyPrompt(mode: string, req: Record<string, unknown>): { system: string; user: string } {
  const lang = String(req.language || '');
  const code = String(req.code || '');
  const numbered = code.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
  const parts: string[] = [];
  const task: Record<string, string> = {
    plain: '이 코드를 코드를 한 번도 본 적 없는 사람에게 설명해.',
    lines: '이 코드를 한 줄씩, 코드를 처음 보는 사람도 알 수 있게 풀어 줘.',
    narrate: '아래는 이 코드를 실제로 실행한 기록이야. 각 단계의 값은 그 줄을 실행하기 "직전" 값이야. 단계마다 쉬운 해설을 써. 일상 비유는 처음 한두 단계에만.',
    explain: '학생이 이 코드를 자기 말로 설명했어. 맞은 곳, 부족한 곳, 틀린 곳을 짚어 채점해.',
    why: '이 코드가 왜 이렇게 짜였는지, 같은 일을 하는 다른 방법 2~3개와 비교해.',
    translate: `이 코드를 ${String(req.target || 'javascript')} 로 같은 동작이 되게, 그 언어다운 방식으로 옮겨. 두 언어가 다른 부분을 짚어.`,
    review: '선배 개발자처럼 이 코드를 리뷰해. 잘한 점, 고칠 점, 주의할 점.',
    task: '이 코드를 바탕으로 학생이 직접 고쳐 보는 작은 과제 하나를 내. 기능 하나를 바꾸거나 더하는 정도.',
    bug: '이 코드에 그럴듯한 버그를 딱 한 줄만 넣어. 문법 오류 말고 결과가 틀리는 버그(경계값, 조건, 연산자 등).',
    concepts: '이 코드를 이해하려면 알아야 하는 프로그래밍 개념을 찾아. 아래 목록에 있는 개념이면 그 id 를 쓰고, 없으면 id 는 null.',
    distractors: `이 코드에서 ${String(req.call || '')} 의 진짜 결과는 ${String(req.answer || '')} 야. 퀴즈 보기로 쓸 그럴듯한 오답 3개를 만들어.`,
  };
  parts.push(task[mode] ?? '이 코드를 설명해.');
  parts.push(`언어: ${lang}${req.function_name ? ` · 함수: ${String(req.function_name)}` : ''}`);
  parts.push('코드(줄 번호 포함):\n```\n' + numbered + '\n```');
  if (mode === 'explain') { parts.push('학생 설명: ' + String(req.answer || '')); }
  if (mode === 'narrate') {
    parts.push('호출: ' + String(req.call || ''));
    parts.push('실행 기록:\n' + (Array.isArray(req.steps) ? (req.steps as unknown[]).map(String).join('\n') : ''));
  }
  if (mode === 'concepts' && Array.isArray(req.known)) { parts.push('개념 목록(id: 이름): ' + (req.known as unknown[]).map(String).join(', ')); }
  parts.push('JSON 모양: ' + (SHAPES[mode] ?? '{}'));
  return { system: STUDY_SYSTEM, user: parts.join('\n\n') };
}

export async function studyDirect(mode: string, req: Record<string, unknown>, own: { provider: LlmProvider; value: string }): Promise<unknown> {
  const p = studyPrompt(mode, req);
  return pickJson(await complete(own.provider, own.value, p.system, p.user, AbortSignal.timeout(90_000)));
}
