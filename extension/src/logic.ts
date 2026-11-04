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

// ── 5. 저장 응답 읽기
//    계약: HTTP 200 { id, message }. 팀 합의로 임베딩 처리 상태(pending/ready/failed)와
//    실패 이유가 붙을 수 있다 — 필드 이름이 확정 전이라 몇 가지 이름을 받아준다.
export type EmbeddingStatus = 'pending' | 'ready' | 'failed';

export interface SaveResponse {
  id: number;
  embedding?: EmbeddingStatus;   // 서버가 안 알려주면 undefined
  embeddingError?: string;
}

const EMBEDDING_VALUES = new Set(['pending', 'ready', 'failed']);

export function parseSaveResponse(text: string): SaveResponse {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`응답이 JSON 이 아닙니다: ${text.slice(0, 200)}`);
  }
  if (!data || typeof data !== 'object' || typeof data.id !== 'number') {
    throw new Error(`응답에 id 가 없습니다: ${text.slice(0, 200)}`);
  }

  const nested = (typeof data.embedding === 'object' && data.embedding !== null)
    ? data.embedding as Record<string, unknown>
    : {};
  const rawStatus = [data.embedding_status, nested.status, data.status, data.embedding]
    .find((v) => typeof v === 'string' && EMBEDDING_VALUES.has(v.toLowerCase()));
  const rawError = [data.embedding_error, nested.error, nested.reason, data.error, data.reason]
    .find((v) => typeof v === 'string' && v.trim().length > 0);

  return {
    id: data.id,
    embedding: typeof rawStatus === 'string' ? rawStatus.toLowerCase() as EmbeddingStatus : undefined,
    embeddingError: typeof rawError === 'string' ? rawError : undefined,
  };
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
