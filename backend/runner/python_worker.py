"""Untrusted code worker. Run ONLY inside the restricted runner container.

Output follows Extension follow.ts TRACER; tracing also covers module loading
and run cases so the server's 400-event limit applies to both entry points.
"""

import contextlib
import io
import json
import reprlib
import sys

MAX_STEPS = 400
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")


class StepLimit(BaseException):
    pass


class Capture(io.TextIOBase):
    def __init__(self):
        self.text = ""

    def write(self, value):
        self.text = (self.text + value[-4096:])[-4096:]
        return len(value)

    def flush(self):
        pass


def main():
    data = json.loads(sys.stdin.read())
    steps = []
    out = Capture()
    budget = 0
    recording = False
    rp = reprlib.Repr()
    rp.maxlist, rp.maxdict, rp.maxstring, rp.maxother, rp.maxlevel = 12, 8, 40, 40, 3

    def show(value):
        try:
            return rp.repr(value)
        except Exception:
            return "<?>"

    def keep(key, value):
        return not key.startswith("__") and not callable(value) and type(value).__name__ != "module"

    def snapshot(frame, ret=""):
        frames, objects = [], []
        top = frame.f_locals
        while frame is not None and len(frames) < 50:
            if frame.f_code.co_filename == "<cm>":
                variables = {k[:40]: show(v)[:120] for k, v in list(frame.f_locals.items())[:100] if keep(k, v)}
                frames.append({"name": frame.f_code.co_name[:60], "vars": dict(list(variables.items())[:20])})
            elif frame.f_code.co_filename == "<call>":
                frames.append({"name": "부른 곳", "vars": {}})
            frame = frame.f_back
        for key, value in list(top.items())[:100]:
            if isinstance(value, (list, tuple)) and keep(key, value):
                objects.append({"label": key[:60], "items": [show(v)[:40] for v in value[:40]], "look": -1, "marks": []})
        return {"frames": list(reversed(frames)), "objects": objects[:4], "ret": ret[:120]}

    def trace(frame, event, value):
        nonlocal budget
        if frame.f_code.co_filename == "<cm>" and event in ("line", "return"):
            if budget >= MAX_STEPS:
                raise StepLimit()
            budget += 1
            if recording:
                ret = frame.f_code.co_name + "() = " + show(value) if event == "return" else ""
                step = {"line": frame.f_lineno, "say": "", **snapshot(frame, ret)}
                if ret:
                    step["say"] = frame.f_code.co_name + " 이(가) " + show(value) + " 을(를) 돌려줘요"
                steps.append(step)
        return trace

    namespace = {"__name__": "__codememory__"}
    try:
        sys.settrace(trace)
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            exec(compile(data["code"], "<cm>", "exec"), namespace)
    except BaseException as error:
        sys.settrace(None)
        return {"error": "코드를 불러오지 못했어요: " + type(error).__name__}
    finally:
        sys.settrace(None)

    if data["mode"] == "run":
        cases = []
        items = [{"call": call, "expected": ""} for call in data.get("calls", [])] or data.get("tests", [])
        for item in items[:20]:
            call, expected = item["call"], item.get("expected", "")
            result, error = "", ""
            try:
                sys.settrace(trace)
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                    result = repr(eval(compile(call, "<call>", "eval"), namespace))[:500]
            except BaseException as exc:
                error = "실행 단계 한도(400)" if isinstance(exc, StepLimit) else (type(exc).__name__ + ": " + str(exc))[:500]
            finally:
                sys.settrace(None)
            ok = (not error and result.replace(" ", "") == expected.replace(" ", "")) if expected else None
            cases.append({"call": call, "output": result, "error": error, "expected": expected, "ok": ok})
            if budget >= MAX_STEPS:
                break
        return {"cases": cases}

    recording = True
    value, error, truncated = None, "", False
    try:
        sys.settrace(trace)
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            value = eval(compile(data["call"], "<call>", "eval"), namespace)
    except StepLimit:
        truncated = True
    except BaseException as exc:
        error = (type(exc).__name__ + ": " + str(exc))[:300]
    finally:
        sys.settrace(None)
    previous = {}
    for step in steps:
        variables = step["frames"][-1]["vars"] if step["frames"] else {}
        changed = [key + " = " + value for key, value in variables.items() if previous.get(key) != value]
        if not step["say"]:
            step["say"] = ", ".join(changed[:3])[:300] or str(step["line"]) + "번째 줄"
        previous = variables
    if error:
        steps.append({"line": steps[-1]["line"] if steps else 1, "say": "오류로 멈췄어요: " + error,
                      "frames": [], "objects": [], "ret": error})
    if not steps:
        return {"error": "기록된 실행 단계가 없어요. 저장된 함수를 부르는 식을 확인해 주세요."}
    return {"call": data["call"], "steps": steps[:400], "truncated": truncated,
            "value": show(value), "stdout": out.text[-500:]}


if __name__ == "__main__":
    print(json.dumps(main(), ensure_ascii=False))
