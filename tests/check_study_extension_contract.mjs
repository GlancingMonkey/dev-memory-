// Read-only cross-check against the actual Extension parsers and prompt builder.
// At repository root: node tests/check_study_extension_contract.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {stripTypeScriptTypes} from 'node:module';

async function moduleOf(source) {
  return import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source,{mode:'transform'})).toString('base64'));
}
const llm = fs.readFileSync('extension/src/llm.ts','utf8');
const {studyPrompt} = await moduleOf(llm.slice(llm.indexOf('const STUDY_SYSTEM ='),llm.indexOf('export async function studyDirect')));
const {parseStudyResult, parseAiConcepts, STUDY_CONCEPTS} = await moduleOf(fs.readFileSync('extension/src/study.ts','utf8'));
const fixtures = JSON.parse(fs.readFileSync('tests/fixtures/study_responses.json','utf8'));
const base = {code:'def add(a,b):\n    return a + b',language:'python',function_name:'add'};
const extras = {explain:{answer:'더해요'},translate:{target:'typescript'},distractors:{call:'add(1,2)',answer:'3'},
  narrate:{call:'add(1,2)',steps:['start','return']},concepts:{known_ids:[],concept_ids:['condition']}};
const cases = Object.keys(fixtures).map(mode => ({mode, request:{...base,...extras[mode]}, result:fixtures[mode]}));
const python = `
import json,sys
from backend.schemas.study import REQUESTS,StudyRequest
from backend.study_prompts import study_prompt
from backend.routers.study import check_result
cases=json.load(sys.stdin)
for case in cases:
 req=REQUESTS.get(case['mode'],StudyRequest).model_validate(case['request'])
 case['messages']=study_prompt(case['mode'],req)
 case['validated']=check_result(case['mode'],case['result'],req).model_dump(by_alias=True)
print(json.dumps(cases,ensure_ascii=False))
`;
const checked = JSON.parse(execFileSync('uv',['run','--locked','python','-c',python],{input:JSON.stringify(cases),encoding:'utf8'}));
for (const c of checked) {
  const req = {...c.request};
  if (c.mode === 'concepts') req.known = req.concept_ids.map(id => id + ': ' + STUDY_CONCEPTS.find(x=>x.id===id).name);
  const expected = studyPrompt(c.mode,req);
  assert.deepEqual(c.messages,[{role:'system',content:expected.system},{role:'user',content:expected.user}],c.mode+' prompt drift');
  assert.deepEqual(c.validated,c.result,c.mode+' backend shape');
  const parsed = c.mode === 'concepts' ? parseAiConcepts(c.validated,req.concept_ids) : parseStudyResult(c.mode,c.validated);
  assert.ok(parsed,c.mode+' frontend parse');
}
console.log('Actual Extension prompts + response parsers: '+checked.length+' modes matched');
const report = 'out/reports/2026-11-27-study/isolated-runner-check.json';
if (fs.existsSync(report)) {
  const records = JSON.parse(fs.readFileSync(report,'utf8')).filter(x=>x.status===200);
  for (const r of records) assert.ok(parseStudyResult(r.mode,r.body),r.label);
  console.log('Actual isolated runner responses accepted by Extension: '+records.length);
}
