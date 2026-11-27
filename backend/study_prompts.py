"""Backend copy of Extension llm.ts prompts, kept as data for drift checks."""

import json
from pathlib import Path

DATA = json.loads(Path(__file__).with_suffix(".json").read_text())


def study_prompt(mode: str, request) -> list[dict[str, str]]:
    req = request.model_dump()
    task = DATA["tasks"][mode]
    for token, field in (("__TARGET__", "target"), ("__CALL__", "call"), ("__ANSWER__", "answer")):
        task = task.replace(token, req.get(field, ""))
    language = req["language"]
    function = req.get("function_name")
    numbered = "\n".join(f"{index}: {line}" for index, line in enumerate(req["code"].split("\n"), 1))
    parts = [task, f"언어: {language}" + (f" · 함수: {function}" if function else ""),
             "코드(줄 번호 포함):\n```\n" + numbered + "\n```"]
    if mode == "explain":
        parts.append("학생 설명: " + req["answer"])
    if mode == "narrate":
        parts.extend(["호출: " + req["call"], "실행 기록:\n" + "\n".join(req["steps"])])
    if mode == "concepts":
        identifiers = req["concept_ids"] or list(DATA["concepts"])
        parts.append("개념 목록(id: 이름): " + ", ".join(
            f"{identifier}: {DATA['concepts'].get(identifier, identifier)}" for identifier in identifiers
        ))
    parts.append("JSON 모양: " + DATA["shapes"][mode])
    return [{"role": "system", "content": DATA["system"]},
            {"role": "user", "content": "\n\n".join(parts)}]
