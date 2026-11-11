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
export type AskErrorKind = 'timeout' | 'input' | 'unavailable' | 'bad_answer' | 'connect' | 'server' | 'format' | 'cancelled';

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
    default:
      return new AskError('server', `서버 오류 (HTTP ${httpStatus})`, d || '서버 로그를 확인하세요.');
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
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
    const detail = value && typeof value === 'object' && typeof (value as { detail?: unknown }).detail === 'string'
      ? (value as { detail: string }).detail
      : '';
    throw askErrorFor(httpStatus, detail);
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

// ── 8. 기타
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}초`;
}

// 설정값 범위 맞추기 (숫자가 아니면 기본값)
export function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}
