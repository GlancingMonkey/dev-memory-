// ─────────────────────────────────────────────
// VS Code 없이도 돌아가는 순수 로직 모음
//   → src/test/logic.test.ts 에서 단위 테스트한다 (npm run test:unit)
//   여기에는 'vscode' 를 import 하지 않는다.
// ─────────────────────────────────────────────

// ── 1. 함수 이름 찾기 (정규식 — 코드 구조 정보를 못 받을 때 쓰는 예비 방법)
//    선택한 줄에서 위로 올라가며 가장 가까운 함수/클래스 선언을 찾는다. 못 찾으면 null.
const DECL_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /\bfunction\s+(\w+)/,
    /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/,
    /^\s*(?:(?:public|private|protected|static|async)\s+)*(\w+)\s*\([^)]*\)\s*(?::\s*[^={]+)?\{/,
    /\bclass\s+(\w+)/,
  ],
  javascript: [
    /\bfunction\s+(\w+)/,
    /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/,
    /^\s*(?:(?:static|async)\s+)*(\w+)\s*\([^)]*\)\s*\{/,
    /\bclass\s+(\w+)/,
  ],
  python: [
    /^\s*(?:async\s+)?def\s+(\w+)/,
    /^\s*class\s+(\w+)/,
  ],
  java: [
    /^\s*(?!return\b|new\b|else\b|throw\b)(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)*[\w<>\[\]]+\s+(\w+)\s*\(/,
    /\bclass\s+(\w+)/,
  ],
};

// if (...) { 같은 걸 함수로 착각하지 않게 걸러낸다
const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'else']);

export function findFunctionNameByRegex(
  getLine: (i: number) => string,
  languageId: string,
  fromLine: number,
): string | null {
  const patterns = DECL_PATTERNS[languageId];
  if (!patterns) {
    return null;   // 지원 안 하는 언어
  }
  for (let i = fromLine; i >= 0 && i > fromLine - 80; i--) {
    const text = getLine(i);
    for (const re of patterns) {
      const m = text.match(re);
      if (m?.[1] && !NOT_NAMES.has(m[1])) {
        return m[1];
      }
    }
  }
  return null;
}

// ── 2. 코드 구조(문서 기호)에서 커서를 감싸는 함수 고르기
//    VS Code 가 주는 기호를 단순한 모양으로 바꿔서 넘긴다 (extension.ts 의 toSimpleSymbol)
export interface SimpleSymbol {
  name: string;
  kind: 'function' | 'class' | 'other';
  startLine: number;   // 0부터
  endLine: number;     // 0부터, 포함
  children: SimpleSymbol[];
}

// line 을 감싸는 가장 안쪽 함수와 가장 안쪽 클래스
export function pickSymbol(symbols: SimpleSymbol[], line: number): { fn?: SimpleSymbol; cls?: SimpleSymbol } {
  let fn: SimpleSymbol | undefined;
  let cls: SimpleSymbol | undefined;
  const walk = (list: SimpleSymbol[]) => {
    for (const s of list) {
      if (line < s.startLine || line > s.endLine) {
        continue;
      }
      if (s.kind === 'function') {
        fn = s;
      } else if (s.kind === 'class') {
        cls = s;
      }
      walk(s.children);   // 더 안쪽이 있으면 덮어쓴다 → 결국 가장 안쪽
    }
  };
  walk(symbols);
  return { fn, cls };
}

// ── 3. 줄 번호 보정
//    여러 줄을 끌어서 선택하면 커서가 "다음 줄 맨 앞"에서 끝나는 경우가 많다.
//    그대로 두면 end_line 이 실제보다 한 줄 커지므로 한 줄 뺀다. (0부터 센 값으로 받는다)
export function adjustEndLine(startLine: number, endLine: number, endCharacter: number): number {
  if (endCharacter === 0 && endLine > startLine) {
    return endLine - 1;
  }
  return endLine;
}

// ── 4. 삽입할 때 들여쓰기 맞추기
//    저장된 코드의 공통 들여쓰기를 걷어내고, 둘째 줄부터 커서 위치의 들여쓰기(prefix)를 붙인다.
//    첫 줄은 커서 자리에 그대로 들어가므로 붙이지 않는다. 끝의 줄바꿈 하나는 뺀다.
export function reindent(code: string, prefix: string, eol: string): string {
  const lines = code.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const widths = lines.filter((l) => l.trim().length > 0).map((l) => l.length - l.trimStart().length);
  const common = widths.length ? Math.min(...widths) : 0;
  return lines
    .map((l, i) => {
      const body = l.trim().length === 0 ? '' : l.slice(common);
      if (i === 0 || body === '') {
        return body;
      }
      return prefix + body;
    })
    .join(eol);
}

// ── 5. API_CONTRACT.md에 확정된 저장 응답 읽기
// pending은 기존 저장 기록에서만 사용한다. 현재 POST 응답은 ready / failed / null이다.
export type EmbeddingStatus = 'pending' | 'ready' | 'failed';

export interface SaveResponse {
  id: number;
  embedding: EmbeddingStatus | null;
  embeddingError: string | null;
}

// 요청 실패와 저장 여부를 확인하지 못한 경우를 구분한다. 자동 재전송하지 않는다.
export class SaveUnconfirmedError extends Error {
  constructor(reason: string) {
    super(`${reason}. 같은 요청을 다시 보내지 말고 서버 로그·DB를 먼저 확인하세요.`);
    this.name = 'SaveUnconfirmedError';
  }
}

const EMBEDDING_ERROR_CODES = new Set([
  'embedding_input_invalid',
  'embedding_generation_failed',
  'embedding_storage_failed',
]);

export function parseSaveResponse(text: string, httpStatus = 200): SaveResponse {
  if (httpStatus === 422) {
    throw new Error('HTTP 422: 저장 요청의 필수 필드와 입력값을 확인하세요.');
  }
  if (httpStatus !== 200 && httpStatus !== 503) {
    throw new SaveUnconfirmedError(`HTTP ${httpStatus}: 저장 완료 여부를 확인하지 못했습니다`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SaveUnconfirmedError(`HTTP ${httpStatus}: 응답이 JSON이 아니어서 저장 여부를 확인하지 못했습니다`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SaveUnconfirmedError(`HTTP ${httpStatus}: 저장 응답 형식을 확인할 수 없습니다`);
  }
  const data = value as Record<string, unknown>;
  if (typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || data.id <= 0
      || data.message !== 'snippet saved') {
    throw new SaveUnconfirmedError(`HTTP ${httpStatus}: 저장된 ID와 완료 메시지를 확인하지 못했습니다`);
  }

  // 503이어도 이 응답은 원문 저장이 확인됐다. ID를 유지하고 검색 준비만 미확정으로 표시한다.
  if (httpStatus === 503 && data.embedding_status === null
      && data.embedding_error === 'embedding_storage_failed') {
    return { id: data.id, embedding: null, embeddingError: data.embedding_error };
  }
  if (httpStatus === 200 && data.embedding_status === 'ready' && data.embedding_error === null) {
    return { id: data.id, embedding: 'ready', embeddingError: null };
  }
  if (httpStatus === 200 && data.embedding_status === 'failed'
      && typeof data.embedding_error === 'string' && EMBEDDING_ERROR_CODES.has(data.embedding_error)) {
    return { id: data.id, embedding: 'failed', embeddingError: data.embedding_error };
  }
  throw new SaveUnconfirmedError(`HTTP ${httpStatus}: ID ${data.id}의 응답이 저장 API 계약과 다릅니다`);
}

// ── 6. AI 질문 응답 읽기 — POST /ask (이슈 #42 제안안. 공식 계약 확정 전이라 여기 한 곳에서만 읽는다)
//    요청: { q, limit } / 응답: status · answer · sources · model · usage
//    sources 는 Backend 가 실제 DB 검색 행으로 조립한 참고 코드. 답변의 [S1] 은 요청 안의 참고 자료 이름이며 DB id 가 아니다.
export type AskStatus = 'answered' | 'insufficient_context';

export interface AskSource {
  citation_id: string;          // S1, S2 …
  id: number;                   // 실제 DB id
  project_name: string | null;
  file_path: string;
  language: string;
  function_name: string | null;
  start_line: number;
  end_line: number;
  code: string;
  score: number;
}

export interface AskUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface AskResponse {
  status: AskStatus;
  answer: string;               // 근거 부족이면 빈 문자열일 수 있다
  sources: AskSource[];
  model: string | null;         // LLM 을 안 불렀으면 null
  usage: AskUsage | null;
  citations: string[];          // 답변에 나온 인용 순서대로 (중복 제거)
  unknownCitations: string[];   // 답변에는 있는데 sources 에 없는 인용 → 열 수 없게 표시
  historyUsed: number | null;   // 서버가 반영한 이전 대화 수. 서버가 이 필드를 안 주면 null (= 이전 대화를 모름)
}

// timeout(기다리면 될 수 있음) / input(질문 문제) / unavailable(모델·DB·LLM 준비 실패)
// bad_answer(인용 오류·미완료) / connect(서버 연결 안 됨) / server(그 밖의 HTTP 오류) / format(응답 모양이 계약과 다름)
// cancelled(사용자가 기다리기를 취소함)
// key(사용자가 넣은 AI 키가 틀림·한도 초과)
export type AskErrorKind = 'timeout' | 'input' | 'unavailable' | 'bad_answer' | 'connect' | 'server' | 'format' | 'cancelled' | 'key';

export class AskError extends Error {
  constructor(
    public readonly kind: AskErrorKind,
    public readonly title: string,
    public readonly detail: string,
  ) {
    super(`${title}: ${detail}`);
    this.name = 'AskError';
  }
}

// 답변 속 [S1] 같은 인용을 나온 순서대로 (같은 건 한 번만)
export function extractCitations(answer: string): string[] {
  const seen: string[] = [];
  for (const m of answer.matchAll(/\[(S\d+)\]/g)) {
    if (!seen.includes(m[1])) {
      seen.push(m[1]);
    }
  }
  return seen;
}

// HTTP 오류 → 사용자에게 보여줄 구분
export function askErrorFor(httpStatus: number, detail: string): AskError {
  const d = detail.trim();
  switch (httpStatus) {
    case 422:
      return new AskError('input', '질문을 확인하세요', d || '빈 질문이거나 너무 깁니다 (E5 입력 512토큰 한도).');
    case 503:
      return new AskError('unavailable', 'AI 답변을 준비할 수 없습니다', d || '모델·DB·LLM 연결 상태를 확인하세요.');
    case 504:
      return new AskError('timeout', '서버 응답 시간 초과', d || '답변 생성이 서버 제한 시간을 넘었습니다. 자동으로 다시 보내지 않습니다.');
    case 502:
      return new AskError('bad_answer', '답변을 검증하지 못했습니다', d || '인용이 잘못됐거나 답변이 끝나지 않았습니다.');
    case 401:
    case 403:
      return new AskError('key', 'AI 키를 확인하세요', d || '넣은 AI 키가 맞지 않거나 사용 한도를 넘었어요.');
    default:
      return new AskError('server', `서버 오류 (HTTP ${httpStatus})`, d || '서버 로그를 확인하세요.');
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

// 오류 응답의 detail → 보여줄 글자
//   문자열 / {code, message} (POST /ask 계약) / FastAPI 검증 오류 배열 [{msg}] 모두 받는다
export function errorDetailText(body: unknown): string {
  const d = body && typeof body === 'object' ? (body as { detail?: unknown }).detail : undefined;
  if (typeof d === 'string') {
    return d;
  }
  if (d && typeof d === 'object' && !Array.isArray(d) && typeof (d as { message?: unknown }).message === 'string') {
    return (d as { message: string }).message;
  }
  if (Array.isArray(d)) {
    return d.map((x) => (x && typeof x === 'object' && typeof (x as { msg?: unknown }).msg === 'string' ? (x as { msg: string }).msg : ''))
      .filter(Boolean).join(' / ');
  }
  return '';
}
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

function readSource(v: unknown, i: number): AskSource {
  const bad = (why: string) => new AskError('format', '응답 형식 오류', `sources[${i}] ${why}`);
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw bad('가 객체가 아닙니다');
  }
  const s = v as Record<string, unknown>;
  if (typeof s.citation_id !== 'string' || !/^S\d+$/.test(s.citation_id)) {
    throw bad('의 citation_id 가 S1 같은 형식이 아닙니다');
  }
  if (!isInt(s.id) || s.id <= 0) {
    throw bad('의 id 가 양의 정수가 아닙니다');
  }
  if (typeof s.file_path !== 'string' || typeof s.language !== 'string' || typeof s.code !== 'string'
      || !isStrOrNull(s.project_name) || !isStrOrNull(s.function_name)) {
    throw bad('의 저장 필드(경로·언어·코드·프로젝트·함수 이름) 타입이 다릅니다');
  }
  if (!isInt(s.start_line) || !isInt(s.end_line) || s.start_line < 1 || s.end_line < s.start_line) {
    throw bad('의 줄 번호가 올바르지 않습니다');
  }
  if (typeof s.score !== 'number' || !Number.isFinite(s.score)) {
    throw bad('의 score 가 숫자가 아닙니다');
  }
  return {
    citation_id: s.citation_id, id: s.id, project_name: s.project_name, file_path: s.file_path,
    language: s.language, function_name: s.function_name, start_line: s.start_line, end_line: s.end_line,
    code: s.code, score: s.score,
  };
}

export function parseAskResponse(text: string, httpStatus = 200): AskResponse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (httpStatus !== 200) {
    throw askErrorFor(httpStatus, errorDetailText(value));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AskError('format', '응답 형식 오류', `JSON 객체가 아닙니다: ${text.slice(0, 200)}`);
  }
  const data = value as Record<string, unknown>;

  if (data.status !== 'answered' && data.status !== 'insufficient_context') {
    throw new AskError('format', '응답 형식 오류', `status 가 answered / insufficient_context 가 아닙니다: ${String(data.status)}`);
  }
  const status = data.status;
  const answer = typeof data.answer === 'string' ? data.answer : '';
  if (status === 'answered' && answer.trim().length === 0) {
    throw new AskError('format', '응답 형식 오류', 'answered 인데 답변이 비어 있습니다');
  }
  if (!Array.isArray(data.sources)) {
    throw new AskError('format', '응답 형식 오류', 'sources 배열이 없습니다');
  }
  const sources = data.sources.map(readSource);
  const ids = sources.map((s) => s.citation_id);
  if (new Set(ids).size !== ids.length) {
    throw new AskError('format', '응답 형식 오류', 'sources 에 같은 citation_id 가 두 번 있습니다');
  }

  if (!isStrOrNull(data.model)) {
    throw new AskError('format', '응답 형식 오류', 'model 이 문자열 또는 null 이 아닙니다');
  }
  let usage: AskUsage | null = null;
  if (data.usage !== null && data.usage !== undefined) {
    const u = data.usage as Record<string, unknown>;
    if (typeof u !== 'object' || !isInt(u.input_tokens) || !isInt(u.output_tokens) || !isInt(u.total_tokens)) {
      throw new AskError('format', '응답 형식 오류', 'usage 의 토큰 수가 정수가 아닙니다');
    }
    usage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens, total_tokens: u.total_tokens };
  }

  let historyUsed: number | null = null;
  if (data.history_used !== undefined && data.history_used !== null) {
    if (!isInt(data.history_used) || data.history_used < 0) {
      throw new AskError('format', '응답 형식 오류', 'history_used 가 0 이상의 정수가 아닙니다');
    }
    historyUsed = data.history_used;
  }

  const citations = extractCitations(answer);
  return {
    status, answer, sources, model: data.model, usage, citations,
    unknownCitations: citations.filter((c) => !ids.includes(c)),
    historyUsed,
  };
}

// ── 7. 검색인지 AI 질문인지 (LLM 없이 규칙으로만)
//    끝에 ? (전각 ？ 포함) → Enter 가 바로 AI 질문. 사람이 일부러 붙이는 표시라 "직접 실행" 조건을 지킨다.
//    중간의 ? 는 보지 않는다 — "a ? b : c 삼항 연산자", "?. 옵셔널 체이닝" 같은 검색어가 있다.
//    이 두 함수는 사이드바 웹페이지에도 그대로(toString) 들어간다 → 바깥 변수를 쓰면 안 된다.
export function endsWithQuestionMark(q: string): boolean {
  return /[?？]\s*$/.test(q);
}

//    ? 는 없지만 질문처럼 생긴 문장 → 자동으로 묻지는 않고, 검색 결과 위에 "AI에게 물어볼까요?" 제안만
export function looksLikeQuestion(q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) {
    return false;
  }
  if (/[?？]/.test(s)) {
    return true;
  }
  return /(설명|알려\s?줘|알려\s?주|왜|어떻게|뭐야|뭔가요|뭔지|무엇|무슨|차이|어떤 역할|언제|인가요|나요\s*$|까요\s*$|할까|인지\s*$)/.test(s)
    || /\b(how|why|what|explain|difference)\b/.test(s);
}

// ── 9. AI 질문 부가 기능 (이어서 묻기 · 한 글자씩 받기 · 저장된 답변 · 사용량 · 복사 · 애매한 질문)

// 이어서 묻기 — 앞 대화 한 턴
export interface AskTurn {
  q: string;
  answer: string;
}
export const HISTORY_SEND_MAX = 2;          // 서버로 보내는 이전 대화 수
const HISTORY_ANSWER_MAX = 1500;            // 이전 답변은 앞부분만 (요청이 너무 커지지 않게)

// POST /ask 요청 본문. history 는 있을 때만, stream 은 true 일 때만 넣는다 (예전 서버와 그대로 호환)
export function buildAskRequest(q: string, limit: number, history: AskTurn[] = [], stream = false): Record<string, unknown> {
  const body: Record<string, unknown> = { q, limit };
  const recent = history.slice(-HISTORY_SEND_MAX).map((h) => ({ q: h.q, answer: h.answer.slice(0, HISTORY_ANSWER_MAX) }));
  if (recent.length) {
    body.history = recent;
  }
  if (stream) {
    body.stream = true;
  }
  return body;
}

// 한 글자씩 받기 — 서버가 text/event-stream(SSE)로 보낼 때 조각을 이벤트로 자른다
//   event: sources {sources:[…]} → event: delta {text:"…"} 여러 번 → event: done {일반 응답과 같은 JSON} / event: error {status, detail}
//   rest: 아직 덜 온 마지막 조각 (다음 조각과 이어 붙인다)
export interface SseEvent {
  event: string;
  data: string;
}
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: SseEvent[] = [];
  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        continue;   // 주석(연결 유지용)
      }
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? '' : line.slice(i + 1);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
      if (field === 'event') {
        event = value;
      } else if (field === 'data') {
        data.push(value);
      }
    }
    if (data.length) {
      events.push({ event, data: data.join('\n') });
    }
  }
  return { events, rest };
}

// 저장된 답변을 찾을 때 쓰는 키 — 띄어쓰기·대소문자·끝의 ? 차이는 같은 질문으로 본다
export function askCacheKey(q: string): string {
  return q.trim().replace(/[?？\s]+$/, '').replace(/\s+/g, ' ').toLowerCase();
}

// 오늘 AI 사용량 — 내 PC 기준 날짜가 바뀌면 0부터
export interface UsageDay {
  date: string;     // YYYY-MM-DD (내 PC 시간)
  count: number;    // 질문 수 (저장된 답변 다시 보기·mock 은 세지 않음)
  tokens: number;   // total_tokens 합 (서버가 usage 를 안 주면 0)
}
export function localDateKey(d: Date): string {
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function todayUsage(stat: UsageDay | undefined, today: string): UsageDay {
  return stat && stat.date === today ? stat : { date: today, count: 0, tokens: 0 };
}
export function addUsage(stat: UsageDay | undefined, today: string, tokens: number): UsageDay {
  const base = todayUsage(stat, today);
  return { date: today, count: base.count + 1, tokens: base.tokens + Math.max(0, tokens) };
}

// 답변 복사 — 마크다운. 웹페이지에도 그대로(toString) 들어가서 바깥 변수를 쓰면 안 된다
export function answerToMarkdown(
  q: string,
  answer: string,
  sources: { citation_id: string; function_name: string | null; file_path: string; start_line: number; end_line: number; language: string }[],
): string {
  const lines = ['**Q. ' + q + '**', '', answer && answer.trim() ? answer.trim() : '(답변 없음 — 근거 부족)'];
  if (sources.length) {
    lines.push('');
    sources.forEach(function (s) {
      lines.push('- [' + s.citation_id + '] ' + (s.function_name || '(이름 없음)') + ' — '
        + s.file_path + ':' + s.start_line + '-' + s.end_line + ' (' + s.language + ')');
    });
  }
  return lines.join('\n');
}

// 애매한 질문 — 너무 짧거나("함수 ?") 내용 없는 말만 있으면 보내기 전에 한 번 멈춘다
//   웹페이지에도 그대로(toString) 들어가서 바깥 변수를 쓰면 안 된다
export function isVagueQuestion(q: string): boolean {
  const compact = q.replace(/[?？!.,~\s]/g, '');
  if (compact.length === 0) {
    return false;   // 빈 질문은 따로 막는다
  }
  if (compact.length <= 4) {
    return true;
  }
  const filler = ['코드', '함수', '이거', '이것', '저거', '그거', '이', '그', '뭐', '뭐야', '뭐임', '설명', '설명해줘', '알려줘',
    '해줘', '어떻게', '좀', 'code', 'function', 'this', 'that', 'it', 'is', 'the', 'what', 'explain', 'how', 'does'];
  const words = q.toLowerCase().replace(/[?？!.,~]/g, ' ').split(/\s+/).filter(function (w) { return w.length > 0; });
  return words.every(function (w) { return filler.indexOf(w) >= 0; });
}

// ── 10. 검색 필터 — GET /search?project=&language= · GET /filters (팀 합의 #38 #39 #40)
//    project: 저장된 이름 그대로(대소문자 구분) · language: 소문자 · 빈 값 = 조건 없음 · 둘 다면 AND
//    서버는 실제 적용한 조건을 응답 filters 로 돌려준다. 없으면 옛 서버라 조건이 무시된 것
export interface SearchFilter {
  project: string;
  language: string;
}
export const FILTER_MAX_LENGTH = 200;

export function normalizeFilter(f: Partial<SearchFilter> | null | undefined): SearchFilter {
  const project = typeof f?.project === 'string' ? f.project.trim() : '';
  const language = typeof f?.language === 'string' ? f.language.trim().toLowerCase() : '';
  return { project, language };
}
export function hasFilter(f: SearchFilter): boolean {
  return f.project !== '' || f.language !== '';
}

// GET /search 주소. 조건은 있을 때만 붙인다 (없으면 예전 주소와 똑같다)
export function buildSearchUrl(baseUrl: string, q: string, limit: number, filter: SearchFilter): string {
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (filter.project) {
    params.set('project', filter.project);
  }
  if (filter.language) {
    params.set('language', filter.language);
  }
  return `${baseUrl.replace(/\/+$/, '')}/search?${params.toString()}`;
}

// 서버가 조건을 진짜 적용했는지
//   applied: 요청한 조건이 응답 filters 와 같음 / none: 조건 없이 검색 / ignored: 조건을 보냈는데 서버가 안 돌려줌(옛 서버)·다름
export type FilterCheck = 'applied' | 'none' | 'ignored';
export function checkAppliedFilter(requested: SearchFilter, responseFilters: unknown): FilterCheck {
  if (!hasFilter(requested)) {
    return 'none';
  }
  if (!responseFilters || typeof responseFilters !== 'object') {
    return 'ignored';
  }
  const got = normalizeFilter({
    project: (responseFilters as { project?: unknown }).project as string | undefined,
    language: (responseFilters as { language?: unknown }).language as string | undefined,
  });
  return got.project === requested.project && got.language === requested.language ? 'applied' : 'ignored';
}

// 서버가 조건을 무시했을 때 화면에서라도 거른다 (표시는 "화면에서만 거름")
export function filterLocally<T extends { project_name: string | null; language: string }>(rows: T[], f: SearchFilter): T[] {
  return rows.filter((r) => (!f.project || r.project_name === f.project) && (!f.language || r.language.toLowerCase() === f.language));
}

// GET /filters → { projects: [{name, count}], languages: [{name, count}] }  (이름 배열만 와도 된다)
export interface FilterOption {
  name: string;
  count: number | null;
}
export interface FilterOptions {
  projects: FilterOption[];
  languages: FilterOption[];
}
export function parseFilterOptions(text: string): FilterOptions {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`JSON 이 아닙니다: ${text.slice(0, 120)}`);
  }
  const read = (key: 'projects' | 'languages'): FilterOption[] => {
    const list = data && typeof data === 'object' ? (data as Record<string, unknown>)[key] : undefined;
    if (!Array.isArray(list)) {
      throw new Error(`${key} 배열이 없습니다`);
    }
    const out: FilterOption[] = [];
    for (const v of list) {
      const name = typeof v === 'string' ? v : v && typeof v === 'object' ? (v as { name?: unknown }).name : undefined;
      const count = v && typeof v === 'object' ? (v as { count?: unknown }).count : undefined;
      if (typeof name !== 'string' || !name.trim() || out.some((o) => o.name === name)) {
        continue;   // 빈 이름·중복은 건너뛴다
      }
      out.push({ name, count: isInt(count) && count >= 0 ? count : null });
    }
    return out;
  };
  return { projects: read('projects'), languages: read('languages') };
}

// ── 11. 저장 전 비밀값 감지 — LLM 없이 규칙으로만. 서버로 보낼 코드에서만 가리고 사용자 파일은 안 건드린다
export type SecretKind = 'api_key' | 'private_key' | 'password' | 'url_password' | 'jwt';
export interface SecretFinding {
  kind: SecretKind;
  label: string;   // 화면에 보일 이름 (예: "API 키 (OpenAI)")
  line: number;    // 코드 안에서 몇 번째 줄인지 (1부터)
  start: number;   // 가릴 부분 — code 문자열 위치
  end: number;
  keep: number;    // 앞에서 남길 글자 수 (뭐였는지 알아볼 수 있게)
}

// 예시·자리표시 값은 비밀값으로 보지 않는다
function isPlaceholder(v: string): boolean {
  const s = v.trim();
  return s.length < 4
    || /^\*+$/.test(s)
    || /^<.*>$/.test(s)
    || /^\$\{.*\}$/.test(s) || /^\{\{.*\}\}$/.test(s)
    || /^(x{3,}|changeme|change_me|your[_-]?.*|example.*|dummy.*|placeholder.*|sample.*|test|none|null|todo|password|secret|token)$/i.test(s)
    || /\*{4}$/.test(s);
}

export function scanSecrets(code: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  const lineOf = (pos: number) => code.slice(0, pos).split('\n').length;
  const add = (kind: SecretKind, label: string, start: number, end: number, keep: number) => {
    if (end <= start || found.some((f) => start < f.end && end > f.start)) {
      return;   // 이미 찾은 범위와 겹치면 건너뜀
    }
    found.push({ kind, label, line: lineOf(start), start, end, keep });
  };
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      fn(m);
      if (m[0].length === 0) {
        re.lastIndex++;
      }
    }
  };

  // 1) 개인 키 블록 — 머리·꼬리 줄은 남기고 내용만
  each(/-----BEGIN ([A-Z ]*)PRIVATE KEY-----([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----|$)/g, (m) => {
    const bodyStart = m.index + m[0].indexOf(m[2]);
    add('private_key', '개인 키', bodyStart, bodyStart + m[2].length, 0);
  });
  // 2) 모양으로 알 수 있는 키
  const keys: [RegExp, string, number][] = [
    [/\bsk-(?:proj-|live-|test-|ant-)?[A-Za-z0-9_-]{20,}/g, 'API 키 (sk-…)', 8],
    [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'AWS 액세스 키', 4],
    [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, 'GitHub 토큰', 4],
    [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, 'GitHub 토큰', 11],
    [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'Google API 키', 4],
    [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, 'Slack 토큰', 5],
    [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'JWT 토큰', 3],
  ];
  for (const [re, label, keep] of keys) {
    each(re, (m) => add(re.source.startsWith('\\beyJ') ? 'jwt' : 'api_key', label, m.index, m.index + m[0].length, Math.min(keep, m[0].length)));
  }
  // 3) 주소 안 비밀번호  scheme://user:비번@host
  each(/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:([^\s@/'"]+)@/gi, (m) => {
    if (isPlaceholder(m[1])) {
      return;
    }
    const s = m.index + m[0].lastIndexOf(m[1] + '@');
    add('url_password', '주소 안 비밀번호', s, s + m[1].length, 0);
  });
  // 4) 이름이 수상한 변수에 문자열을 넣은 것  password = "…"
  each(/([A-Za-z_][\w.-]*?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth[_-]?key|credential)[\w-]*)["']?\s*(?:[:=]|=>)\s*(["'`])([^"'`\n]+)\2/gi, (m) => {
    if (isPlaceholder(m[3])) {
      return;
    }
    const s = m.index + m[0].lastIndexOf(m[2] + m[3] + m[2]) + 1;
    add('password', '비밀번호·토큰 (' + m[1] + ')', s, s + m[3].length, 0);
  });
  return found.sort((a, b) => a.start - b.start);
}

// 찾은 부분을 가린다 — 앞 keep 글자 + "****"
export function maskSecrets(code: string, findings: SecretFinding[]): string {
  let out = '';
  let pos = 0;
  for (const f of [...findings].sort((a, b) => a.start - b.start)) {
    if (f.start < pos) {
      continue;
    }
    const value = code.slice(f.start, f.end);
    const masked = f.kind === 'private_key' ? '\n****\n' : value.slice(0, f.keep) + '****';
    out += code.slice(pos, f.start) + masked;
    pos = f.end;
  }
  return out + code.slice(pos);
}

// ── 12. 검색 결과의 원본이 바뀌었는지 — 저장한 코드와 지금 파일 비교
//    줄바꿈(CRLF)·줄 끝 공백 차이는 같은 걸로 본다
export type SourceState = 'same' | 'moved' | 'changed';
export interface SourceCheck {
  state: SourceState;
  start?: number;   // moved 일 때 새 위치 (1부터)
  end?: number;
}
function normLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}
export function compareSource(saved: string, fileText: string, startLine: number, endLine: number): SourceCheck {
  const want = normLines(saved);
  const file = fileText.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  if (!want.length) {
    return { state: 'changed' };
  }
  const same = (at: number) => at >= 0 && at + want.length <= file.length && want.every((l, i) => file[at + i] === l);
  const at = startLine - 1;
  if (same(at) && (endLine - startLine + 1 >= want.length)) {
    return { state: 'same' };
  }
  // 다른 위치에 그대로 있으면 위치 이동 — 원래 자리에서 가까운 곳 우선
  let best = -1;
  for (let i = 0; i + want.length <= file.length; i++) {
    if (same(i) && (best < 0 || Math.abs(i - at) < Math.abs(best - at))) {
      best = i;
    }
  }
  if (best >= 0) {
    return best === at ? { state: 'same' } : { state: 'moved', start: best + 1, end: best + want.length };
  }
  return { state: 'changed' };
}

// ── 13. 성능 평가 — 질문 파일(질문 + 정답 코드 ID)로 검색이 원하는 코드를 몇 등에 띄우는지 잰다
//    Hit@1 = 한 번에 찾음(정답이 1등) · Hit@3 = 3개 안에 찾음 · 정답이 없는 질문은 "모르는 건 모른다고 하는지"로 따로 본다
export interface EvalQuestion {
  id: string;
  q: string;
  expected: number[];      // 정답 코드 ID. 비어 있으면 정답 없는 질문
  project?: string;        // 선택: 이 질문만 범위를 걸 때
  language?: string;
}
export function parseEvalQuestions(text: string): EvalQuestion[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('JSON 형식이 아닙니다');
  }
  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? (data as { questions?: unknown }).questions : undefined;
  if (!Array.isArray(list) || !list.length) {
    throw new Error('questions 배열이 없거나 비어 있습니다');
  }
  return list.map((v, i) => {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const q = typeof o.q === 'string' ? o.q.trim() : '';
    if (!q) {
      throw new Error(`${i + 1}번째 질문의 q 가 비어 있습니다`);
    }
    const expected = Array.isArray(o.expected) ? o.expected : o.expected === undefined || o.expected === null ? [] : [o.expected];
    if (!expected.every((x) => isInt(x) && x > 0)) {
      throw new Error(`${i + 1}번째 질문의 expected 는 코드 ID(양의 정수) 배열이어야 합니다`);
    }
    return {
      id: typeof o.id === 'string' && o.id.trim() ? o.id.trim() : `Q${i + 1}`,
      q,
      expected: expected as number[],
      project: typeof o.project === 'string' ? o.project : undefined,
      language: typeof o.language === 'string' ? o.language : undefined,
    };
  });
}

export interface EvalRow {
  id: string;
  q: string;
  expected: number[];
  rank: number | null;          // 정답이 처음 나온 순위 (1부터). 못 찾으면 null. 정답 없는 질문이면 null
  topIds: number[];             // 검색 결과 ID (위에서부터)
  searchMs: number | null;      // 검색 시간. 실패면 null
  searchError?: string;
  ask?: {                       // AI 답변까지 잰 경우
    status: 'answered' | 'insufficient_context' | 'error';
    ms: number;
    totalTokens: number | null;
    citations: number;
    error?: string;
  };
}

// 정답이 처음 나온 순위
export function rankOf(expected: number[], ids: number[]): number | null {
  const i = ids.findIndex((id) => expected.includes(id));
  return i < 0 ? null : i + 1;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) {
    return null;
  }
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

export interface EvalSummary {
  total: number;
  withAnswer: number;           // 정답이 있는 질문 수 (Hit 계산 대상)
  hit1: number;
  hit3: number;
  missed: number;               // 정답 있는데 결과에 없음
  meanRank: number | null;      // 찾은 것들의 평균 순위
  buckets: { first: number; top3: number; top10: number; missed: number };
  searchFailed: number;
  searchAvgMs: number | null;
  searchP95Ms: number | null;
  asked: number;
  askAvgMs: number | null;
  askAvgTokens: number | null;
  askErrors: number;
  noAnswerTotal: number;        // 정답 없는 질문 수 (AI 답변까지 잰 것만)
  noAnswerCorrect: number;      // 그중 근거 부족으로 답한 수
}
export function summarizeEval(rows: EvalRow[]): EvalSummary {
  const ans = rows.filter((r) => r.expected.length && r.searchMs !== null);
  const ranks = ans.map((r) => r.rank).filter((x): x is number => x !== null);
  const times = rows.map((r) => r.searchMs).filter((x): x is number => x !== null);
  const asked = rows.filter((r) => r.ask);
  const askOk = asked.filter((r) => r.ask!.status !== 'error');
  const toks = askOk.map((r) => r.ask!.totalTokens).filter((x): x is number => x !== null);
  const noAns = asked.filter((r) => !r.expected.length && r.ask!.status !== 'error');
  return {
    total: rows.length,
    withAnswer: ans.length,
    hit1: ranks.filter((x) => x === 1).length,
    hit3: ranks.filter((x) => x <= 3).length,
    missed: ans.length - ranks.length,
    meanRank: avg(ranks),
    buckets: {
      first: ranks.filter((x) => x === 1).length,
      top3: ranks.filter((x) => x === 2 || x === 3).length,
      top10: ranks.filter((x) => x > 3).length,
      missed: ans.length - ranks.length,
    },
    searchFailed: rows.filter((r) => r.searchMs === null).length,
    searchAvgMs: avg(times),
    searchP95Ms: percentile(times, 95),
    asked: asked.length,
    askAvgMs: avg(askOk.map((r) => r.ask!.ms)),
    askAvgTokens: avg(toks),
    askErrors: asked.length - askOk.length,
    noAnswerTotal: noAns.length,
    noAnswerCorrect: noAns.filter((r) => r.ask!.status === 'insufficient_context').length,
  };
}

// 내보내기 — CSV (엑셀용) / 마크다운 표 (포스터·문서용)
export function evalToCsv(rows: EvalRow[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = ['id', 'question', 'expected', 'rank', 'hit1', 'hit3', 'search_ms', 'top_ids', 'ask_status', 'ask_ms', 'ask_tokens', 'ask_citations', 'error'];
  const lines = rows.map((r) => [
    r.id, r.q, r.expected.join(' '), r.rank ?? '', r.expected.length ? (r.rank === 1 ? 1 : 0) : '', r.expected.length ? (r.rank !== null && r.rank <= 3 ? 1 : 0) : '',
    r.searchMs ?? '', r.topIds.join(' '), r.ask?.status ?? '', r.ask?.ms ?? '', r.ask?.totalTokens ?? '', r.ask?.citations ?? '',
    r.searchError ?? r.ask?.error ?? '',
  ].map(esc).join(','));
  return [head.join(','), ...lines].join('\n') + '\n';
}
export function evalToMarkdown(rows: EvalRow[], s: EvalSummary, meta: string): string {
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) + '%' : '-');
  const sec = (ms: number | null) => (ms === null ? '-' : (ms / 1000).toFixed(2) + '초');
  const out = [
    '## Code Memory 평가', '', meta, '',
    '| 지표 | 값 |', '|---|---|',
    `| 한 번에 찾음 (Hit@1) | ${pct(s.hit1, s.withAnswer)} (${s.hit1}/${s.withAnswer}) |`,
    `| 3개 안에 찾음 (Hit@3) | ${pct(s.hit3, s.withAnswer)} (${s.hit3}/${s.withAnswer}) |`,
    `| 정답 평균 순위 | ${s.meanRank === null ? '-' : s.meanRank.toFixed(1) + '등'} |`,
    `| 못 찾은 질문 | ${s.missed}개 |`,
    `| 찾는 데 걸린 시간 (평균 / p95) | ${sec(s.searchAvgMs)} / ${sec(s.searchP95Ms)} |`,
  ];
  if (s.asked) {
    out.push(`| AI 답변 평균 토큰 | ${s.askAvgTokens === null ? '-' : Math.round(s.askAvgTokens).toLocaleString()} |`,
      `| AI 답변 평균 시간 | ${sec(s.askAvgMs)} |`,
      `| 모르는 건 모른다고 함 | ${s.noAnswerCorrect}/${s.noAnswerTotal} |`);
  }
  out.push('', '| # | 질문 | 정답 ID | 순위 | 검색 | AI | 토큰 |', '|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const rank = !r.expected.length ? '-' : r.rank === null ? '못 찾음' : r.rank + '등';
    const ai = r.ask ? (r.ask.status === 'error' ? '오류' : r.ask.status === 'answered' ? `답변 · 인용 ${r.ask.citations}` : '근거 부족') : '-';
    out.push(`| ${r.id} | ${r.q.replace(/\|/g, '\\|')} | ${r.expected.join(', ') || '-'} | ${rank} | ${sec(r.searchMs)} | ${ai} | ${r.ask?.totalTokens ?? '-'} |`);
  }
  return out.join('\n') + '\n';
}

// ── 14. 사용자 AI 키 (OpenAI · Anthropic · Google Gemini) — 키는 VS Code 비밀 저장소에만, /ask 요청에만 헤더로
//    헤더 이름은 Backend 와 정한 값으로 여기 한 곳만 바꾸면 된다
export const LLM_KEY_HEADER = 'X-LLM-API-Key';
export const LLM_PROVIDER_HEADER = 'X-LLM-Provider';
export type LlmProvider = 'openai' | 'anthropic' | 'google';
export const LLM_PROVIDERS: { id: LlmProvider; label: string; hint: string; url: string }[] = [
  { id: 'openai', label: 'OpenAI', hint: 'sk-…', url: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic (Claude)', hint: 'sk-ant-…', url: 'https://console.anthropic.com/settings/keys' },
  { id: 'google', label: 'Google (Gemini)', hint: 'AIza…', url: 'https://aistudio.google.com/apikey' },
];

// 키 모양으로 어느 회사 키인지 짐작 (틀릴 수 있어서 화면에서 바꿀 수 있다). 웹페이지에도 그대로 들어간다
export function guessProvider(key: string): LlmProvider | null {
  const k = key.trim();
  if (/^sk-ant-/.test(k)) {
    return 'anthropic';
  }
  if (/^AIza[0-9A-Za-z_-]{20,}$/.test(k)) {
    return 'google';
  }
  if (/^sk-/.test(k)) {
    return 'openai';
  }
  return null;
}

// 화면 표시용 — 앞부분 조금 + 끝 4자리
export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 8) {
    return '****';
  }
  const dash = k.lastIndexOf('-', 12);
  const head = dash > 0 && dash <= 12 ? k.slice(0, dash + 1) : k.slice(0, 4);
  return `${head}…${k.slice(-4)}`;
}

// 키를 실어 보내도 되는 주소인지 — 내 PC(localhost) 이거나 https 일 때만
export function canSendKey(apiUrl: string): boolean {
  try {
    const u = new URL(apiUrl);
    if (u.protocol === 'https:') {
      return true;
    }
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}

// 붙여넣은 키가 그럴듯한지 (공백·줄바꿈이 섞이면 거절)
export function validateKey(key: string): string | null {
  const k = key.trim();
  if (!k) {
    return '키를 붙여넣으세요';
  }
  if (/\s/.test(k)) {
    return '키에 공백이나 줄바꿈이 들어 있어요';
  }
  if (k.length < 20) {
    return '키가 너무 짧아요';
  }
  return null;
}

// ── 8. 기타
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}초`;
}

// 설정값 범위 맞추기 (숫자가 아니면 기본값)
export function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}
