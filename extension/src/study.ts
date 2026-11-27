// 공부 모드 — 서버 없이 이 PC 에서만 도는 부분
//   1) 코드에 쓰인 개념 찾기 (정해 둔 개념 목록 + 줄 단위 패턴)
//   2) 간격 반복 — 맞히면 다음 복습까지 간격을 늘리고, 틀리면 줄인다
// 웹페이지에도 toString() 으로 넣으므로 함수들은 이 파일 밖의 것을 쓰지 않는다. vscode 모듈도 쓰지 않는다.

export type StudyLang = 'py' | 'js' | 'ts';

export interface StudyConcept {
  id: string;
  name: string;
  langs: StudyLang[];      // js 는 ts 에도 해당 (ts 전용은 'ts' 만)
  level: 1 | 2 | 3;        // 1 기초 · 2 중급 · 3 심화
  summary: string;
  example: string;
  doc: string;             // 공식 문서
  prereq: string[];        // 먼저 알면 좋은 개념 id
  pattern: string;         // 줄 단위 정규식 (빈 문자열이면 따로 판단: recursion)
  misconception?: string;  // 흔한 오해
  contrast?: string;       // 비슷하지만 다른 것
}

const PY = 'https://docs.python.org/ko/3/';
const MDN = 'https://developer.mozilla.org/ko/docs/Web/JavaScript/Reference/';

export const STUDY_CONCEPTS: StudyConcept[] = [
  // ── 공통
  { id: 'loop', name: '반복문', langs: ['py', 'js', 'ts'], level: 1, prereq: [],
    summary: '같은 일을 여러 값에 차례로 해요. 파이썬 for 는 리스트 같은 묶음에서 하나씩 꺼내요.',
    example: 'for n in [1, 2, 3]:\n    print(n)', doc: PY + 'tutorial/controlflow.html#for-statements',
    pattern: '^\\s*(for|while)\\b' },
  { id: 'condition', name: '조건문', langs: ['py', 'js', 'ts'], level: 1, prereq: [],
    summary: '조건이 참일 때만 실행해요. 파이썬은 elif, 자바스크립트는 else if.',
    example: 'if n > 0:\n    print("양수")\nelse:\n    print("0 이하")', doc: PY + 'tutorial/controlflow.html#if-statements',
    pattern: '^\\s*(if|elif|else\\s*if)\\b|^\\s*}?\\s*else\\b' },
  { id: 'modulo', name: '나머지 연산 %', langs: ['py', 'js', 'ts'], level: 1, prereq: [],
    summary: 'a % b 는 a 를 b 로 나눈 나머지. n % 2 == 0 이면 짝수예요. 음수일 때 파이썬과 자바스크립트 결과가 달라요 (-3 % 2 → 파이썬 1, JS -1).',
    example: '7 % 3   # 1\n-3 % 2  # 1 (JS 에서는 -1)', doc: PY + 'reference/expressions.html#binary-arithmetic-operations',
    pattern: '[\\w)\\]]\\s*%\\s*[\\w(]' },
  { id: 'recursion', name: '재귀', langs: ['py', 'js', 'ts'], level: 2, prereq: ['condition'],
    summary: '함수가 자기 자신을 다시 불러요. 멈추는 조건(바닥)이 꼭 있어야 하고, 너무 깊으면 스택이 넘쳐요.',
    example: 'def fact(n):\n    if n <= 1:\n        return 1\n    return n * fact(n - 1)', doc: PY + 'tutorial/controlflow.html#defining-functions',
    pattern: '' },
  // ── 파이썬
  { id: 'list_comp', name: '리스트 컴프리헨션', langs: ['py'], level: 2, prereq: ['loop', 'condition'],
    summary: '반복 + 조건 + 새 리스트 만들기를 한 줄로. for 앞이 결과에 들어갈 값, if 뒤가 거르는 조건이에요. 원래 리스트는 안 바뀌어요.',
    example: '[n * n for n in nums if n > 0]', doc: PY + 'tutorial/datastructures.html#list-comprehensions',
    pattern: '\\[[^\\[\\]]*\\bfor\\b[^\\[\\]]*\\bin\\b' },
  { id: 'dict_comp', name: '딕셔너리 컴프리헨션', langs: ['py'], level: 2, prereq: ['list_comp'],
    summary: '{키: 값 for …} 로 딕셔너리를 한 줄에 만들어요.',
    example: '{name: len(name) for name in names}', doc: PY + 'tutorial/datastructures.html#dictionaries',
    pattern: '\\{[^{}]*:[^{}]*\\bfor\\b[^{}]*\\bin\\b' },
  { id: 'generator', name: '제너레이터 (yield)', langs: ['py'], level: 3, prereq: ['loop'],
    summary: 'yield 는 값을 하나씩 내주고 멈췄다가 다음에 이어서 실행해요. 전부 메모리에 올리지 않아서 큰 데이터에 좋아요.',
    example: 'def count_up(n):\n    i = 0\n    while i < n:\n        yield i\n        i += 1', doc: PY + 'tutorial/classes.html#generators',
    pattern: '\\byield\\b' },
  { id: 'lambda', name: '람다 (이름 없는 함수)', langs: ['py'], level: 2, prereq: [],
    summary: 'lambda x: x * 2 처럼 짧은 함수를 그 자리에서 만들어요. 정렬 기준(key)에 자주 써요.',
    example: 'sorted(users, key=lambda u: u.age)', doc: PY + 'tutorial/controlflow.html#lambda-expressions',
    pattern: '\\blambda\\b' },
  { id: 'fstring', name: 'f-문자열', langs: ['py'], level: 1, prereq: [],
    summary: 'f"…{변수}…" 로 문자열 안에 값을 넣어요. {x:.2f} 처럼 형식도 정할 수 있어요.',
    example: 'f"{name}님 {score:.1f}점"', doc: PY + 'tutorial/inputoutput.html#formatted-string-literals',
    pattern: '(^|[^\\w])[rRbB]?[fF][rR]?["\']' },
  { id: 'try_except', name: '예외 처리 (try/except)', langs: ['py'], level: 2, prereq: ['condition'],
    summary: '오류가 날 수 있는 부분을 try 로 감싸고, 났을 때 except 에서 처리해요. 너무 넓게 잡으면 진짜 버그를 숨겨요.',
    example: 'try:\n    x = int(text)\nexcept ValueError:\n    x = 0', doc: PY + 'tutorial/errors.html#handling-exceptions',
    pattern: '^\\s*(try\\s*:|except\\b|finally\\s*:)' },
  { id: 'with_stmt', name: 'with 문', langs: ['py'], level: 2, prereq: ['try_except'],
    summary: '파일·연결처럼 다 쓰면 닫아야 하는 것을 블록이 끝날 때 자동으로 정리해요.',
    example: 'with open("a.txt") as f:\n    text = f.read()', doc: PY + 'reference/compound_stmts.html#the-with-statement',
    pattern: '^\\s*(async\\s+)?with\\b' },
  { id: 'decorator', name: '데코레이터 (@)', langs: ['py'], level: 3, prereq: ['lambda'],
    summary: '@이름 은 함수를 다른 함수로 한 번 감싸서 기능을 덧붙여요 (기록, 캐시, 권한 확인 등).',
    example: '@lru_cache\ndef fib(n): ...', doc: PY + 'glossary.html#term-decorator',
    pattern: '^\\s*@[A-Za-z_]' },
  { id: 'class_py', name: '클래스', langs: ['py'], level: 2, prereq: [],
    summary: '데이터와 그 데이터를 다루는 함수를 하나로 묶어요. __init__ 에서 처음 값을 정하고 self 로 자기 자신을 가리켜요.',
    example: 'class User:\n    def __init__(self, name):\n        self.name = name', doc: PY + 'tutorial/classes.html',
    pattern: '^\\s*class\\s+\\w' },
  { id: 'slicing', name: '슬라이싱', langs: ['py'], level: 1, prereq: [],
    summary: 'a[시작:끝:간격] 으로 일부를 잘라 새로 만들어요. 끝은 포함하지 않고, a[::-1] 은 뒤집기예요.',
    example: 'a[1:3]   # 1, 2 번째\na[::-1]  # 뒤집기', doc: PY + 'tutorial/introduction.html#text',
    pattern: '[\\w)\\]]\\[[^\\]\\[]*:[^\\]\\[]*\\]' },
  { id: 'unpacking', name: '언패킹', langs: ['py'], level: 1, prereq: [],
    summary: 'a, b = b, a 처럼 여러 값을 한 번에 나눠 담아요. for i, x in enumerate(…) 도 같은 원리예요.',
    example: 'a, b = b, a\nfirst, *rest = items', doc: PY + 'tutorial/datastructures.html#tuples-and-sequences',
    pattern: '^\\s*\\*?\\w+\\s*,\\s*\\*?\\w+(\\s*,\\s*\\*?\\w+)*\\s*=[^=]|\\bfor\\s+\\(?\\w+\\s*,\\s*\\w+' },
  { id: 'default_args', name: '기본값 인자', langs: ['py'], level: 1, prereq: [],
    summary: 'def f(x, y=0) 처럼 안 넘기면 쓸 값을 정해요. 기본값으로 [] 같은 바뀌는 객체를 쓰면 호출끼리 공유돼서 위험해요.',
    example: 'def greet(name, polite=True): ...', doc: PY + 'tutorial/controlflow.html#default-argument-values',
    pattern: '\\bdef\\s+\\w+\\s*\\([^)]*\\w\\s*(:[^=,)]+)?=\\s*[^=]' },
  { id: 'args_kwargs', name: '*args / **kwargs', langs: ['py'], level: 2, prereq: ['default_args'],
    summary: '개수가 정해지지 않은 인자를 받아요. *args 는 튜플, **kwargs 는 딕셔너리로 들어와요.',
    example: 'def log(*args, **kwargs): ...', doc: PY + 'tutorial/controlflow.html#arbitrary-argument-lists',
    pattern: '\\bdef\\s+\\w+\\s*\\([^)]*\\*\\*?\\w' },
  { id: 'sort_key', name: '정렬 기준 key', langs: ['py'], level: 2, prereq: ['lambda'],
    summary: 'sorted·sort·max·min 에 key=함수 를 주면 그 결과로 비교해요. 원래 값은 그대로 두고 순서만 정해요.',
    example: 'sorted(words, key=len)\nmax(users, key=lambda u: u.age)', doc: PY + 'howto/sorting.html#key-functions',
    pattern: '\\b(sorted|sort|max|min)\\s*\\([^)]*\\bkey\\s*=' },
  { id: 'enumerate_zip', name: 'enumerate · zip', langs: ['py'], level: 1, prereq: ['loop', 'unpacking'],
    summary: 'enumerate 는 (번호, 값), zip 은 여러 리스트를 같은 자리끼리 묶어서 꺼내줘요.',
    example: 'for i, name in enumerate(names): ...\nfor a, b in zip(xs, ys): ...', doc: PY + 'library/functions.html#enumerate',
    pattern: '\\b(enumerate|zip)\\s*\\(' },
  { id: 'type_hints', name: '타입 힌트', langs: ['py'], level: 2, prereq: [],
    summary: 'def f(x: int) -> str 처럼 기대하는 타입을 적어요. 실행에는 영향이 없고 편집기·검사 도구가 써요.',
    example: 'def total(prices: list[float]) -> float: ...', doc: PY + 'library/typing.html',
    pattern: '\\bdef\\s+\\w+\\s*\\([^)]*\\w\\s*:\\s*[\\w\\[]|\\)\\s*->' },
  { id: 'none_check', name: 'None 다루기', langs: ['py'], level: 1, prereq: ['condition'],
    summary: 'None 은 "값 없음". 비교는 == 대신 is None 으로 해요. 함수가 None 을 돌려주면 부른 쪽에서 꼭 확인해야 해요.',
    example: 'if result is None:\n    return []', doc: PY + 'library/constants.html#None',
    pattern: '\\bis\\s+(not\\s+)?None\\b|\\breturn\\s+None\\b|[!=]=\\s*None\\b' },
  { id: 'async_py', name: 'async / await', langs: ['py'], level: 3, prereq: [],
    summary: '기다리는 동안(네트워크 등) 다른 일을 하게 해요. async def 함수 안에서 await 로 기다려요.',
    example: 'async def fetch():\n    data = await client.get(url)', doc: PY + 'library/asyncio-task.html',
    pattern: '\\basync\\s+def\\b|\\bawait\\b' },
  // ── 자바스크립트 · 타입스크립트
  { id: 'arrow', name: '화살표 함수', langs: ['js', 'ts'], level: 1, prereq: [],
    summary: '(x) => x * 2 처럼 짧게 함수를 만들어요. 자기만의 this 가 없어서 바깥 this 를 그대로 써요.',
    example: 'const double = (x) => x * 2;', doc: MDN + 'Functions/Arrow_functions',
    pattern: '=>' },
  { id: 'array_methods', name: '배열 메서드 (map·filter·reduce)', langs: ['js', 'ts'], level: 2, prereq: ['arrow', 'loop'],
    summary: 'map 은 바꾸기, filter 는 거르기, reduce 는 하나로 모으기. 원래 배열은 안 바뀌고 새 값을 돌려줘요 (forEach 는 아무것도 안 돌려줘요).',
    example: 'nums.filter(n => n % 2 === 0).map(n => n * n)', doc: MDN + 'Global_Objects/Array/filter',
    pattern: '\\.(map|filter|reduce|find|findIndex|some|every|forEach|flatMap)\\s*\\(' },
  { id: 'destructuring', name: '구조 분해', langs: ['js', 'ts'], level: 2, prereq: [],
    summary: 'const { name, age } = user 처럼 객체·배열에서 필요한 것만 꺼내 변수로 만들어요.',
    example: 'const { name, age = 0 } = user;\nconst [first, ...rest] = list;', doc: MDN + 'Operators/Destructuring_assignment',
    pattern: '\\b(const|let|var)\\s*[\\[{]|\\(\\s*\\{[^)]*\\}\\s*\\)\\s*=>' },
  { id: 'spread', name: '전개 문법 (...)', langs: ['js', 'ts'], level: 2, prereq: ['destructuring'],
    summary: '...배열 / ...객체 로 펼쳐서 복사하거나 합쳐요. 얕은 복사라 안쪽 객체는 같은 걸 가리켜요.',
    example: 'const next = { ...state, count: state.count + 1 };', doc: MDN + 'Operators/Spread_syntax',
    pattern: '\\.\\.\\.[\\w([{]' },
  { id: 'template_literal', name: '템플릿 리터럴', langs: ['js', 'ts'], level: 1, prereq: [],
    summary: '백틱 문자열 안에 ${값} 으로 값을 넣고 여러 줄도 쓸 수 있어요.',
    example: 'const msg = `${name}님 안녕하세요`;', doc: MDN + 'Template_literals',
    pattern: '`' },
  { id: 'async_js', name: 'async / await · Promise', langs: ['js', 'ts'], level: 3, prereq: ['arrow'],
    summary: '오래 걸리는 일을 기다리는 동안 멈추지 않게 해요. async 함수는 항상 Promise 를 돌려주고, await 로 결과를 기다려요.',
    example: 'const res = await fetch(url);\nconst data = await res.json();', doc: MDN + 'Statements/async_function',
    pattern: '\\basync\\b|\\bawait\\b|\\.then\\s*\\(|\\bnew\\s+Promise\\b' },
  { id: 'optional_chaining', name: '옵셔널 체이닝 ?. · ??', langs: ['js', 'ts'], level: 2, prereq: [],
    summary: 'a?.b 는 a 가 없으면 오류 대신 undefined. x ?? 기본값 은 null·undefined 일 때만 기본값을 써요.',
    example: 'const city = user?.address?.city ?? "알 수 없음";', doc: MDN + 'Operators/Optional_chaining',
    pattern: '\\?\\.|\\?\\?' },
  { id: 'strict_eq', name: '=== 엄격한 비교', langs: ['js', 'ts'], level: 1, prereq: [],
    summary: '=== 는 타입까지 같아야 참이에요. == 는 타입을 바꿔서 비교해서 "0" == 0 이 참이 되는 함정이 있어요.',
    example: '0 === "0"  // false\n0 == "0"   // true', doc: MDN + 'Operators/Strict_equality',
    pattern: '[!=]==' },
  { id: 'try_catch', name: '예외 처리 (try/catch)', langs: ['js', 'ts'], level: 2, prereq: ['condition'],
    summary: '오류가 날 수 있는 부분을 try 로 감싸고 catch 에서 처리해요. await 하는 Promise 의 오류도 여기서 잡혀요.',
    example: 'try {\n  JSON.parse(text);\n} catch (e) {\n  return null;\n}', doc: MDN + 'Statements/try...catch',
    pattern: '\\btry\\s*\\{|\\bcatch\\s*[({]|\\bfinally\\s*\\{' },
  { id: 'class_js', name: '클래스', langs: ['js', 'ts'], level: 2, prereq: [],
    summary: '데이터와 메서드를 묶어요. constructor 에서 처음 값을 정하고 this 로 자기 자신을 가리켜요.',
    example: 'class User {\n  constructor(name) { this.name = name; }\n}', doc: MDN + 'Classes',
    pattern: '\\bclass\\s+\\w' },
  { id: 'ts_types', name: '타입 표시', langs: ['ts'], level: 1, prereq: [],
    summary: 'x: number 처럼 값의 타입을 적으면 잘못된 값을 넣을 때 실행 전에 알려줘요.',
    example: 'function total(prices: number[]): number { ... }', doc: 'https://www.typescriptlang.org/ko/docs/handbook/2/everyday-types.html',
    pattern: '[\\w)]\\s*:\\s*(number|string|boolean|void|unknown|any|never|[A-Z]\\w*)(\\[\\])?\\b|\\b(interface|type)\\s+[A-Z]\\w*' },
  { id: 'generics', name: '제네릭', langs: ['ts'], level: 3, prereq: ['ts_types'],
    summary: '<T> 로 타입을 나중에 정해요. 여러 타입에 같은 코드를 쓰면서도 타입 검사를 지켜요.',
    example: 'function first<T>(items: T[]): T | undefined { return items[0]; }', doc: 'https://www.typescriptlang.org/ko/docs/handbook/2/generics.html',
    pattern: '\\w\\s*<\\s*[A-Z]\\w*(\\s+extends[^>]*)?(\\s*,\\s*[A-Z]\\w*)*\\s*>\\s*\\(|\\b(Array|Promise|Record|Map|Set)<' },
];

// 개념마다 흔한 오해 · 비슷하지만 다른 것 (AI 없이 보여주는 기본값. AI 가 주면 그쪽을 먼저)
const STUDY_EXTRA: Record<string, { misconception: string; contrast: string }> = {
  loop: { misconception: '반복 중에 그 리스트에서 지우거나 넣으면 건너뛰거나 끝나지 않을 수 있어요.', contrast: 'for 는 묶음을 끝까지, while 은 조건이 참인 동안. 횟수를 모르면 while.' },
  condition: { misconception: '빈 리스트·0·빈 문자열·None 도 거짓으로 취급돼요. if x: 는 "x 가 있다"가 아닐 수 있어요.', contrast: 'if-elif 는 처음 맞는 하나만, 따로 쓴 if 여러 개는 전부 검사해요.' },
  modulo: { misconception: '음수 나머지는 언어마다 달라요. 파이썬 -3 % 2 는 1, JS 는 -1 이라 홀수 검사는 != 0 이 안전해요.', contrast: '% 는 나머지, // 는 몫(내림). divmod(a, b) 는 둘 다.' },
  recursion: { misconception: '바닥 조건이 없거나 문제가 작아지지 않으면 끝없이 불러요. 파이썬은 기본 1000번 정도에서 멈춰요.', contrast: '반복문으로도 같은 일을 할 수 있어요. 깊이가 크면 반복문이 안전하고, 트리 같은 구조는 재귀가 읽기 쉬워요.' },
  list_comp: { misconception: '결과를 쓰지 않을 거면 컴프리헨션 대신 for 문을 쓰세요. 부작용용으로 쓰면 리스트만 낭비돼요.', contrast: '[…] 는 리스트를 한 번에 다 만들고, (…) 는 제너레이터라 하나씩 만들어 메모리를 아껴요.' },
  dict_comp: { misconception: '같은 키가 여러 번 나오면 마지막 값만 남아요.', contrast: 'dict(zip(keys, values)) 로도 만들 수 있어요. 값을 계산해야 하면 컴프리헨션.' },
  generator: { misconception: '제너레이터는 한 번 다 돌면 비어요. 두 번 쓰려면 다시 만들거나 list() 로 담아야 해요.', contrast: 'return 은 한 번 끝, yield 는 값을 내주고 멈췄다가 이어서.' },
  lambda: { misconception: 'lambda 에는 식 하나만 들어가요. 길어지면 이름 있는 함수(def)가 읽기 쉬워요.', contrast: 'def 는 이름·여러 줄·docstring 가능, lambda 는 그 자리에서 쓰고 버리는 짧은 함수.' },
  fstring: { misconception: '{} 안은 실행되는 코드예요. 사용자 입력을 f-문자열로 SQL 에 넣으면 위험해요.', contrast: 'f"…" 는 바로 값을 넣고, "…".format() 은 나중에 넣고, % 는 옛 방식.' },
  try_except: { misconception: 'except: 만 쓰면 Ctrl+C 같은 것까지 삼켜요. 잡을 예외를 정확히 적으세요.', contrast: 'if 로 미리 확인(LBYL)하거나, 해보고 실패하면 처리(EAFP). 파이썬은 EAFP 를 많이 써요.' },
  with_stmt: { misconception: 'with 가 끝나면 파일이 닫혀요. 블록 밖에서 f.read() 하면 오류예요.', contrast: 'try/finally 로 직접 닫는 것과 같지만 짧고 빠뜨릴 일이 없어요.' },
  decorator: { misconception: '@ 는 함수를 정의할 때 한 번 감싸요. 호출할 때마다 감싸는 게 아니에요. functools.wraps 를 안 쓰면 이름·설명이 바뀌어요.', contrast: '데코레이터는 함수를 감싸는 것, 상속은 클래스를 넓히는 것.' },
  class_py: { misconception: '클래스 안에 바로 쓴 리스트는 모든 객체가 같이 써요. 객체마다 따로면 __init__ 에서 self.x = [] 로.', contrast: '데이터만 묶을 거면 @dataclass 나 dict 가 더 간단해요.' },
  slicing: { misconception: '슬라이싱은 새 리스트(얕은 복사)를 만들어요. 안쪽 리스트까지 복사되지는 않아요.', contrast: 'a[i] 는 하나(범위 밖이면 오류), a[i:j] 는 묶음(범위 밖이어도 빈 리스트).' },
  unpacking: { misconception: '양쪽 개수가 다르면 오류예요. 남는 걸 받으려면 *rest.', contrast: '튜플 언패킹은 위치로, 딕셔너리는 .items() 로 키·값을 꺼내요.' },
  default_args: { misconception: 'def f(x=[]) 의 [] 는 한 번만 만들어져서 호출끼리 공유돼요. None 으로 두고 안에서 만드세요.', contrast: '기본값 인자는 생략 가능, 키워드 인자(name=…)는 순서와 상관없이 넘기기.' },
  args_kwargs: { misconception: '*args 는 리스트가 아니라 튜플이에요. 이름은 관례일 뿐 * 가 중요해요.', contrast: '정의할 때 * 는 모으기, 부를 때 *list 는 펼치기.' },
  sort_key: { misconception: 'list.sort() 는 None 을 돌려줘요. 새 리스트가 필요하면 sorted().', contrast: 'key 는 비교할 값을 뽑는 함수, reverse=True 는 순서만 뒤집기.' },
  enumerate_zip: { misconception: 'zip 은 짧은 쪽에서 멈춰요. 길이가 다르면 뒷부분이 조용히 사라져요.', contrast: 'range(len(x)) 로 번호를 세는 것보다 enumerate 가 짧고 실수가 적어요.' },
  type_hints: { misconception: '타입 힌트는 실행 중에 검사하지 않아요. 틀린 타입을 넣어도 그냥 돌아가요.', contrast: '힌트는 설명·도구용, isinstance 는 실행 중 실제 검사.' },
  none_check: { misconception: '== None 도 되지만 객체가 == 를 바꿀 수 있어서 is None 이 정확해요.', contrast: 'None 은 "값 없음", 0·""·[] 는 "비어 있는 값". if not x 는 둘 다 걸러요.' },
  async_py: { misconception: 'async 를 붙인다고 빨라지지 않아요. 기다리는 일(네트워크·파일)이 많을 때만 이득이에요.', contrast: '스레드는 OS 가 번갈아 실행, async 는 await 지점에서 스스로 양보.' },
  arrow: { misconception: '화살표 함수는 자기 this 가 없어서 객체 메서드로 쓰면 this 가 그 객체가 아니에요.', contrast: 'function 은 부르는 방식에 따라 this 가 바뀌고, 화살표는 만든 곳의 this.' },
  array_methods: { misconception: 'forEach 는 아무것도 돌려주지 않고 중간에 멈출 수 없어요. 결과가 필요하면 map/filter.', contrast: 'map 은 같은 길이로 바꾸기, filter 는 고르기, find 는 첫 하나, reduce 는 하나로 모으기.' },
  destructuring: { misconception: '없는 속성을 꺼내면 오류가 아니라 undefined 예요. 기본값(= 0)을 주세요.', contrast: '객체는 이름으로 { a }, 배열은 위치로 [a].' },
  spread: { misconception: '... 복사는 한 단계만이에요. 안쪽 객체는 원본과 같은 걸 가리켜요.', contrast: '펼치기(...)는 값을 꺼내 넣기, 나머지(...rest)는 남은 것을 모으기.' },
  template_literal: { misconception: '사용자 입력을 그대로 HTML 에 넣으면 스크립트가 실행될 수 있어요 (XSS).', contrast: '문자열 + 연결보다 읽기 쉽고 여러 줄이 돼요.' },
  async_js: { misconception: 'forEach 안의 await 는 기다려 주지 않아요. 순서대로면 for…of, 동시에면 Promise.all.', contrast: 'await 는 하나씩 기다리기, Promise.all 은 한꺼번에 시작하고 다 끝날 때까지.' },
  optional_chaining: { misconception: '?? 는 null·undefined 만 걸러요. 0 이나 "" 는 그대로 써요 (|| 와 달라요).', contrast: '|| 는 거짓 값 전부, ?? 는 null·undefined 만 기본값으로.' },
  strict_eq: { misconception: 'NaN === NaN 은 false 예요. Number.isNaN 으로 확인하세요.', contrast: '=== 는 타입까지, == 는 타입을 바꿔서, Object.is 는 NaN·-0 까지 구분.' },
  try_catch: { misconception: 'await 안 한 Promise 의 오류는 바깥 try/catch 에 안 잡혀요.', contrast: 'try/catch 는 동기·await 오류, .catch() 는 Promise 체인 오류.' },
  class_js: { misconception: '메서드를 콜백으로 넘기면 this 가 사라져요. 화살표 함수나 bind 가 필요해요.', contrast: '클래스 문법은 프로토타입을 쉽게 쓰는 방법이에요. 데이터만이면 일반 객체로 충분.' },
  ts_types: { misconception: '타입은 실행 전에만 검사해요. 서버에서 받은 JSON 이 실제로 맞는지는 따로 확인해야 해요.', contrast: 'interface 는 확장·합치기 좋고, type 은 합집합(A | B) 같은 조합에 좋아요.' },
  generics: { misconception: 'any 와 달리 제네릭은 넣은 타입을 끝까지 기억해요. any 로 바꾸면 검사가 사라져요.', contrast: '제네릭은 "같은 타입끼리", 합집합(A | B)은 "둘 중 하나".' },
};
STUDY_CONCEPTS.forEach((c) => { Object.assign(c, STUDY_EXTRA[c.id] || {}); });

// VS Code 언어 id → 개념 목록의 언어. 모르는 언어면 null (개념 찾기 생략)
export function studyLangOf(language: string | null | undefined): StudyLang | null {
  const l = String(language || '').toLowerCase();
  if (l === 'python' || l === 'py') { return 'py'; }
  if (l === 'typescript' || l === 'typescriptreact' || l === 'ts' || l === 'tsx') { return 'ts'; }
  if (l === 'javascript' || l === 'javascriptreact' || l === 'js' || l === 'jsx') { return 'js'; }
  return null;
}

export interface ConceptHit {
  id: string;
  lines: number[];   // 코드 안에서 몇 번째 줄인지 (0부터)
}

// 코드에 쓰인 개념 — 목록 순서대로. 주석 줄은 건너뛴다. 재귀는 함수 이름이 몸통에서 다시 불리는지로 본다
export function detectConcepts(code: string, language: string | null | undefined, functionName: string | null | undefined,
  concepts: StudyConcept[]): ConceptHit[] {
  const l = String(language || '').toLowerCase();
  const lang = l === 'python' || l === 'py' ? 'py'
    : (l === 'typescript' || l === 'typescriptreact' || l === 'ts' || l === 'tsx') ? 'ts'
      : (l === 'javascript' || l === 'javascriptreact' || l === 'js' || l === 'jsx') ? 'js' : null;
  if (!lang) { return []; }
  const lines = String(code || '').replace(/\r\n?/g, '\n').split('\n');
  const isComment = (t: string) => (lang === 'py' ? /^\s*#/.test(t) : /^\s*(\/\/|\/\*|\*)/.test(t));
  const hits: ConceptHit[] = [];
  for (const c of concepts) {
    const ok = c.langs.indexOf(lang) >= 0 || (lang === 'ts' && c.langs.indexOf('js') >= 0);
    if (!ok) { continue; }
    const found: number[] = [];
    if (c.id === 'recursion') {
      const name = String(functionName || '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) {
        const call = new RegExp('(^|[^\\w$.])' + name.replace(/\$/g, '\\$') + '\\s*\\(');
        lines.forEach((t, i) => { if (i > 0 && !isComment(t) && call.test(t)) { found.push(i); } });
      }
    } else if (c.pattern) {
      let re: RegExp;
      try { re = new RegExp(c.pattern); } catch { continue; }
      lines.forEach((t, i) => { if (!isComment(t) && re.test(t)) { found.push(i); } });
    }
    if (found.length) { hits.push({ id: c.id, lines: found }); }
  }
  return hits;
}

// ── 간격 반복
export type StudyGrade = 'again' | 'hard' | 'good';   // 모름 · 헷갈림 · 알겠음
export interface StudySchedule {
  interval: number;   // 다음 복습까지 날 수
  due: string;        // 다음 복습 날 (ISO)
  reps: number;       // 연속으로 "알겠음"
  lapses: number;     // "모름" 횟수
}

// 모름 → 1일 · 헷갈림 → 간격을 조금만 늘림(처음 2일) · 알겠음 → 처음 3일, 그다음부터 2.5배. 최대 180일
export function scheduleNext(prev: { interval?: number; reps?: number; lapses?: number } | null | undefined,
  grade: StudyGrade, now: Date): StudySchedule {
  const interval0 = prev && typeof prev.interval === 'number' && prev.interval > 0 ? prev.interval : 0;
  const reps0 = prev && typeof prev.reps === 'number' ? prev.reps : 0;
  const lapses0 = prev && typeof prev.lapses === 'number' ? prev.lapses : 0;
  let interval: number;
  let reps = reps0;
  let lapses = lapses0;
  if (grade === 'again') {
    interval = 1;
    reps = 0;
    lapses += 1;
  } else if (grade === 'hard') {
    interval = interval0 ? Math.max(interval0 + 1, Math.round(interval0 * 1.2)) : 2;
    reps = 0;
  } else {
    interval = reps0 === 0 ? (interval0 > 3 ? Math.round(interval0 * 2.5) : 3) : Math.round(Math.max(interval0, 1) * 2.5);
    reps += 1;
  }
  interval = Math.min(180, Math.max(1, interval));
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate() + interval, 4, 0, 0).toISOString();
  return { interval, due, reps, lapses };
}

// 오늘 복습할 것 (due 가 지금 이전) — 오래 밀린 순
export function dueCards<T extends { due?: string }>(cards: T[], now: Date): T[] {
  const t = now.getTime();
  return cards.filter((c) => c.due && new Date(c.due).getTime() <= t)
    .sort((a, b) => new Date(a.due as string).getTime() - new Date(b.due as string).getTime());
}

// ── AI 개념 — POST /study/concepts 응답 (Backend 협의안). 모양이 틀린 항목은 버린다
export interface AiConcept {
  id: string | null;          // 개념 목록에 있는 개념이면 그 id
  name: string;
  level: 1 | 2 | 3;
  summary: string;
  in_this_code: string;       // "이 코드에서는 …"
  lines: number[];            // 코드 안에서 1부터
  prereq: string[];           // 개념 이름
  misconception: string;
  contrast: string;
}
export function parseAiConcepts(body: unknown, knownIds: string[]): AiConcept[] {
  const list = body && typeof body === 'object' ? (body as { concepts?: unknown }).concepts : undefined;
  if (!Array.isArray(list)) {
    throw new Error('응답 형식 오류: concepts 배열이 없습니다');
  }
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const out: AiConcept[] = [];
  const seen = new Set<string>();
  for (const raw of list.slice(0, 12)) {
    if (!raw || typeof raw !== 'object') { continue; }
    const r = raw as Record<string, unknown>;
    const name = str(r.name, 60);
    if (!name || seen.has(name)) { continue; }
    seen.add(name);
    const id = typeof r.id === 'string' && knownIds.indexOf(r.id) >= 0 ? r.id : null;
    const lv = r.level === 1 || r.level === 2 || r.level === 3 ? r.level : 2;
    out.push({
      id, name, level: lv,
      summary: str(r.summary, 400),
      in_this_code: str(r.in_this_code, 300),
      lines: Array.isArray(r.lines) ? r.lines.filter((n): n is number => typeof n === 'number' && n >= 1 && n <= 5000).slice(0, 20) : [],
      prereq: Array.isArray(r.prereq) ? r.prereq.map((x) => str(x, 60)).filter(Boolean).slice(0, 5) : [],
      misconception: str(r.misconception, 300),
      contrast: str(r.contrast, 300),
    });
  }
  return out;
}

// ── 개념 지도 — 공부한 코드 + 개념 목록(+ AI 개념) 으로 마디·상태를 만든다
export type NodeStatus = 'ok' | 'weak' | 'new' | 'next' | 'todo';
export interface GraphNode {
  id: string;                 // 목록 개념은 그 id, AI 개념은 "ai:이름"
  name: string;
  level: 1 | 2 | 3;
  status: NodeStatus;
  count: number;              // 이 개념이 쓰인 공부한 코드 수
  ai: boolean;
  prereq: string[];           // 마디 id
  cards: string[];            // 카드 key
  summary: string;
}
export interface GraphCard {
  key: string;
  last?: string;
  concepts?: string[];
  ai?: { id: string | null; name: string; level?: number; summary?: string; prereq?: string[] }[];
}
// 상태: 공부한 개념 → 모름·헷갈림이 있으면 약함, "처음 봄"이면 처음, 아니면 탄탄.
//       안 배운 개념 → 선수 개념이 있고 모두 탄탄이면 다음 추천, 아니면 아직. "아는 것"으로 표시했으면 탄탄
export function buildConceptGraph(cards: GraphCard[], known: Record<string, string>, concepts: StudyConcept[]): GraphNode[] {
  const nodes: Record<string, GraphNode> = {};
  const byName: Record<string, string> = {};
  concepts.forEach((c) => {
    nodes[c.id] = { id: c.id, name: c.name, level: c.level, status: 'todo', count: 0, ai: false, prereq: c.prereq.slice(), cards: [], summary: c.summary };
    byName[c.name] = c.id;
  });
  const weakIds: Record<string, boolean> = {};
  const touch = (id: string, card: GraphCard) => {
    const n = nodes[id];
    if (!n || n.cards.indexOf(card.key) >= 0) { return; }
    n.cards.push(card.key);
    n.count += 1;
    if (card.last === 'again' || card.last === 'hard') { weakIds[id] = true; }
  };
  cards.forEach((card) => {
    (card.concepts || []).forEach((id) => touch(id, card));
    (card.ai || []).forEach((a) => {
      if (a.id && nodes[a.id]) { touch(a.id, card); return; }
      const name = String(a.name || '').trim();
      if (!name) { return; }
      const id = byName[name] || 'ai:' + name;
      if (!nodes[id]) {
        const lv = a.level === 1 || a.level === 3 ? a.level : 2;
        nodes[id] = { id, name, level: lv, status: 'todo', count: 0, ai: true, prereq: [], cards: [], summary: String(a.summary || '') };
        byName[name] = id;
      }
      (a.prereq || []).forEach((pn) => {
        const pid = byName[String(pn).trim()];
        if (pid && pid !== id && nodes[id].prereq.indexOf(pid) < 0) { nodes[id].prereq.push(pid); }
      });
      touch(id, card);
    });
  });
  const list = Object.keys(nodes).map((k) => nodes[k]);
  list.forEach((n) => {
    if (n.count) {
      n.status = weakIds[n.id] ? 'weak' : known[n.id] === 'new' ? 'new' : 'ok';
    } else if (known[n.id] === 'known') {
      n.status = 'ok';
    }
  });
  list.forEach((n) => {
    if (n.status === 'todo' && n.prereq.length && n.prereq.every((p) => nodes[p] && nodes[p].status === 'ok')) {
      n.status = 'next';
    }
  });
  return list;
}

// 목표 개념까지 배우는 순서 — 선수 개념을 먼저 (이미 탄탄한 건 빼지 않고 표시만 하게 상태를 같이 준다)
export function learningPath(targetId: string, nodes: GraphNode[]): GraphNode[] {
  const map: Record<string, GraphNode> = {};
  nodes.forEach((n) => { map[n.id] = n; });
  const out: GraphNode[] = [];
  const seen: Record<string, boolean> = {};
  const visit = (id: string, depth: number) => {
    const n = map[id];
    if (!n || seen[id] || depth > 20) { return; }
    seen[id] = true;
    n.prereq.forEach((p) => visit(p, depth + 1));
    out.push(n);
  };
  visit(targetId, 0);
  return out;
}

// ── 이번 주 약점 리포트
export interface ReportCard {
  key: string;
  name: string;
  lastAt?: string;
  history?: { at: string; grade: string }[];
  concepts?: string[];
}
export interface WeeklyReport {
  weak: { id: string; misses: number }[];   // 최근 7일 모름·헷갈림이 많은 개념
  stale: ReportCard[];                      // 30일 넘게 안 본 코드
  reviewed: number;                         // 최근 7일 이해도를 고른 횟수
}
export function weeklyReport(cards: ReportCard[], now: Date): WeeklyReport {
  const weekAgo = now.getTime() - 7 * 86400000;
  const monthAgo = now.getTime() - 30 * 86400000;
  const misses: Record<string, number> = {};
  let reviewed = 0;
  cards.forEach((c) => {
    (c.history || []).forEach((h) => {
      if (new Date(h.at).getTime() < weekAgo) { return; }
      reviewed += 1;
      if (h.grade === 'again' || h.grade === 'hard') {
        (c.concepts || []).forEach((id) => { misses[id] = (misses[id] || 0) + 1; });
      }
    });
  });
  const weak = Object.keys(misses).map((id) => ({ id, misses: misses[id] })).sort((a, b) => b.misses - a.misses).slice(0, 3);
  const stale = cards.filter((c) => c.lastAt && new Date(c.lastAt).getTime() < monthAgo)
    .sort((a, b) => (a.lastAt as string) < (b.lastAt as string) ? -1 : 1).slice(0, 3);
  return { weak, stale, reviewed };
}

// ── 공부 노트 (마크다운)
export interface NoteCard {
  name: string;
  file_path: string;
  language: string;
  code: string;
  last?: string;
  due?: string;
  concepts?: string[];
  ai?: { name: string; summary?: string; in_this_code?: string }[];
}
export function studyNotesMarkdown(cards: NoteCard[], nodes: GraphNode[], concepts: StudyConcept[], now: Date): string {
  const grade: Record<string, string> = { again: '모름', hard: '헷갈림', good: '알겠음' };
  const status: Record<string, string> = { ok: '탄탄', weak: '약함', new: '처음 봄', next: '다음 추천', todo: '아직' };
  const levelName = ['', '기초', '중급', '심화'];
  const fence = '```';
  const byId: Record<string, StudyConcept> = {};
  concepts.forEach((c) => { byId[c.id] = c; });
  const lines: string[] = ['# 공부 노트', '', `${now.toLocaleDateString()} · 공부한 코드 ${cards.length}개`, ''];
  const studied = nodes.filter((n) => n.count > 0).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  lines.push('## 개념', '');
  studied.forEach((n) => {
    const c = byId[n.id];
    lines.push(`### ${n.name} (${levelName[n.level]} · ${status[n.status]}${n.ai ? ' · AI' : ''})`, '');
    if (n.summary) { lines.push(n.summary, ''); }
    if (c && c.misconception) { lines.push(`- 흔한 오해: ${c.misconception}`); }
    if (c && c.contrast) { lines.push(`- 비슷하지만 다른 것: ${c.contrast}`); }
    if (c && c.doc) { lines.push(`- 문서: ${c.doc}`); }
    lines.push(`- 내 코드: ${n.cards.length}개`, '');
  });
  lines.push('## 내 코드', '');
  cards.forEach((c) => {
    lines.push(`### ${c.name} — ${c.file_path}`, '');
    lines.push(`이해도: ${grade[c.last || ''] || '-'}${c.due ? ` · 다음 복습 ${new Date(c.due).toLocaleDateString()}` : ''}`, '');
    lines.push(fence + (c.language || ''), c.code, fence, '');
    (c.ai || []).forEach((a) => { if (a.in_this_code) { lines.push(`- ${a.name}: ${a.in_this_code}`); } });
    lines.push('');
  });
  return lines.join('\n');
}

// ── 공부 모드 AI · 실행 — POST /study/{mode} (Backend 협의안). 응답 모양이 틀린 항목은 버린다
export type StudyMode = 'quiz' | 'translate' | 'explain' | 'why' | 'review' | 'task' | 'bug' | 'trace' | 'run';
const s_ = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const arr_ = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj_ = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const lines_ = (v: unknown): number[] => arr_(v).filter((n): n is number => typeof n === 'number' && n >= 1 && n <= 5000).slice(0, 20);

export interface QuizQuestion { kind: 'output' | 'blank' | 'bug' | 'concept'; prompt: string; code: string; choices: string[]; answer: number; explain: string }
export interface TranslateResult { language: string; code: string; notes: { from: string; to: string; why: string }[] }
export interface ExplainPoint { verdict: 'ok' | 'partial' | 'wrong'; text: string; lines: number[] }
export interface WhyResult {
  alternatives: { label: string; code: string; speed: string; memory: string; readability: string; note: string }[];
  complexity: { time: string; space: string; note: string };
  deeper: { title: string; text: string; doc: string }[];
}
export interface ReviewItem { kind: 'good' | 'fix' | 'warn'; title: string; text: string; lines: number[] }
export interface ReviewResult { items: ReviewItem[]; improved_code: string }
export interface TaskResult { task: string; starter: string; tests: { call: string; expected: string }[] }
export interface BugResult { code: string; line: number; explain: string; fixed_line: string }
export interface TraceFrame { name: string; vars: Record<string, string> }
export interface TraceObject { label: string; items: string[]; look: number; marks: string[] }
export interface TraceStep { line: number; say: string; frames: TraceFrame[]; objects: TraceObject[]; ret: string }
export interface TraceResult { call: string; steps: TraceStep[]; truncated: boolean }
export interface RunCase { call: string; output: string; error: string; expected: string; ok: boolean | null }
export interface RunResult { cases: RunCase[] }

export function parseStudyResult(mode: StudyMode, body: unknown): unknown {
  const b = obj_(body);
  switch (mode) {
    case 'quiz': {
      const qs = arr_(b.questions).map(obj_).map((q) => {
        const choices = arr_(q.choices).map((c) => s_(c, 200)).filter(Boolean).slice(0, 6);
        const kind = q.kind === 'output' || q.kind === 'blank' || q.kind === 'bug' ? q.kind : 'concept';
        return { kind, prompt: s_(q.prompt, 300), code: s_(q.code, 2000), choices, answer: typeof q.answer === 'number' ? q.answer : -1, explain: s_(q.explain, 500) } as QuizQuestion;
      }).filter((q) => q.prompt && q.choices.length >= 2 && q.answer >= 0 && q.answer < q.choices.length).slice(0, 5);
      if (!qs.length) { throw new Error('문제가 없습니다'); }
      return { questions: qs };
    }
    case 'translate': {
      const code = s_(b.code, 8000);
      if (!code) { throw new Error('바꾼 코드가 없습니다'); }
      return { language: s_(b.language, 40), code,
        notes: arr_(b.notes).map(obj_).map((n) => ({ from: s_(n.from, 120), to: s_(n.to, 120), why: s_(n.why, 300) })).filter((n) => n.from || n.to).slice(0, 8) } as TranslateResult;
    }
    case 'explain': {
      const pts = arr_(b.points).map(obj_).map((p) => ({
        verdict: p.verdict === 'ok' || p.verdict === 'wrong' ? p.verdict : 'partial', text: s_(p.text, 300), lines: lines_(p.lines),
      }) as ExplainPoint).filter((p) => p.text).slice(0, 8);
      if (!pts.length) { throw new Error('채점 결과가 없습니다'); }
      return { points: pts };
    }
    case 'why': {
      const c = obj_(b.complexity);
      return {
        alternatives: arr_(b.alternatives).map(obj_).map((a) => ({ label: s_(a.label, 80), code: s_(a.code, 1500), speed: s_(a.speed, 30), memory: s_(a.memory, 30), readability: s_(a.readability, 30), note: s_(a.note, 300) }))
          .filter((a) => a.label).slice(0, 5),
        complexity: { time: s_(c.time, 40), space: s_(c.space, 40), note: s_(c.note, 300) },
        deeper: arr_(b.deeper).map(obj_).map((d) => ({ title: s_(d.title, 80), text: s_(d.text, 800), doc: /^https:\/\//.test(s_(d.doc, 300)) ? s_(d.doc, 300) : '' })).filter((d) => d.title).slice(0, 5),
      } as WhyResult;
    }
    case 'review': {
      const items = arr_(b.items).map(obj_).map((i) => ({ kind: i.kind === 'good' || i.kind === 'warn' ? i.kind : 'fix', title: s_(i.title, 60), text: s_(i.text, 400), lines: lines_(i.lines) }) as ReviewItem)
        .filter((i) => i.title || i.text).slice(0, 10);
      if (!items.length) { throw new Error('리뷰 항목이 없습니다'); }
      return { items, improved_code: s_(b.improved_code, 8000) } as ReviewResult;
    }
    case 'task': {
      const tests = arr_(b.tests).map(obj_).map((t) => ({ call: s_(t.call, 300), expected: s_(t.expected, 300) })).filter((t) => t.call).slice(0, 8);
      if (!s_(b.task, 10) || !tests.length) { throw new Error('과제가 없습니다'); }
      return { task: s_(b.task, 400), starter: s_(b.starter, 8000), tests } as TaskResult;
    }
    case 'bug': {
      const code = s_(b.code, 8000);
      const line = typeof b.line === 'number' ? b.line : 0;
      if (!code || line < 1 || line > code.split('\n').length) { throw new Error('버그 위치가 없습니다'); }
      return { code, line, explain: s_(b.explain, 500), fixed_line: s_(b.fixed_line, 300) } as BugResult;
    }
    case 'trace': {
      const steps = arr_(b.steps).slice(0, 400).map(obj_).map((st) => ({
        line: typeof st.line === 'number' ? st.line : 0,
        say: s_(st.say, 300),
        frames: arr_(st.frames).slice(0, 50).map(obj_).map((f) => {
          const vars: Record<string, string> = {};
          Object.keys(obj_(f.vars)).slice(0, 20).forEach((k) => { vars[k.slice(0, 40)] = s_(obj_(f.vars)[k], 120); });
          return { name: s_(f.name, 60), vars };
        }),
        objects: arr_(st.objects).slice(0, 6).map(obj_).map((o) => ({
          label: s_(o.label, 60), items: arr_(o.items).slice(0, 40).map((x) => s_(x, 40)),
          look: typeof o.look === 'number' ? o.look : -1, marks: arr_(o.marks).slice(0, 40).map((x) => s_(x, 10)),
        })),
        ret: s_(st.ret, 120),
      }) as TraceStep).filter((st) => st.line >= 1);
      if (!steps.length) { throw new Error('실행 기록이 없습니다'); }
      return { call: s_(b.call, 300), steps, truncated: b.truncated === true } as TraceResult;
    }
    case 'run': {
      const cases = arr_(b.cases).slice(0, 20).map(obj_).map((c) => ({
        call: s_(c.call, 300), output: s_(c.output, 500), error: s_(c.error, 500), expected: s_(c.expected, 300),
        ok: c.ok === true ? true : c.ok === false ? false : null,
      }) as RunCase);
      if (!cases.length) { throw new Error('실행 결과가 없습니다'); }
      return { cases } as RunResult;
    }
  }
  return null;
}
