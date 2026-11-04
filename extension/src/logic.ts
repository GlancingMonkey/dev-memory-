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

// ── 6. 기타
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}초`;
}

// 설정값 범위 맞추기 (숫자가 아니면 기본값)
export function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}
