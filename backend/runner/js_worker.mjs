// Run only in the restricted Docker image; node:vm is not used as a sandbox.
import {stripTypeScriptTypes} from 'node:module';
import fs from 'node:fs';
import {instrument, RUNTIME} from './instrument.mjs';

const data = JSON.parse(fs.readFileSync(0, 'utf8'));
try {
  const source = data.language === 'typescript'
    ? stripTypeScriptTypes(data.code, {mode: 'strip'}) : data.code;
  const inst = instrument(source);
  const res = new Function(RUNTIME + '\n' + inst.code + '\n;return {' +
    'call: (expression) => eval(expression), steps: __steps, show: __show, Stop: __Stop, out: () => __out' +
    '};')();
  if (data.mode === 'run') {
    const cases = [];
    const items = data.calls?.length ? data.calls.map(call => ({call, expected: ''})) : data.tests;
    for (const {call, expected = ''} of items.slice(0, 20)) {
      let output = '', error = '';
      try {
        const value = res.call(call);
        output = String(JSON.stringify(value)).slice(0, 500);
      } catch (e) {
        error = e instanceof res.Stop ? '실행 단계 한도(400)' : String(e.name + ': ' + e.message).slice(0, 500);
      }
      const ok = expected ? !error && output.replaceAll(' ', '') === expected.replaceAll(' ', '') : null;
      cases.push({call, output, error, expected, ok});
      if (res.steps.length >= 400) break;
    }
    process.stdout.write(JSON.stringify({cases}));
  } else {
    let value, truncated = false;
    try { value = res.call(data.call); }
    catch (e) {
      if (e instanceof res.Stop) truncated = true;
      else if (res.steps.length < 400) res.steps.push({
        line: res.steps.at(-1)?.line || 1, say: '오류로 멈췄어요: ' + String(e.message).slice(0, 250),
        frames: [], objects: [], ret: String(e.message).slice(0, 120),
      });
    }
    if (!res.steps.length) throw new Error('기록된 실행 단계가 없어요');
    process.stdout.write(JSON.stringify({call: data.call, steps: res.steps.slice(0, 400), truncated,
      value: res.show(value), stdout: res.out().slice(-500)}));
  }
} catch (error) {
  process.stdout.write(JSON.stringify({error: String(error.name + ': ' + error.message).slice(0, 300)}));
}
