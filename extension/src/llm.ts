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
