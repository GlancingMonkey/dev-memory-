"""Opt-in, bounded Docker execution; never execute submitted code on the host."""

import asyncio
import json
import os
from pathlib import Path
import re
import threading
import uuid

from dotenv import load_dotenv

ENV_PATH = Path(__file__).resolve().parents[1] / ".env"

class RunnerUnavailable(Exception):
    pass


class RunnerTimeout(Exception):
    pass


class RunnerInputError(Exception):
    pass


LIMIT_SECONDS = 5
_slots = threading.BoundedSemaphore(2)


def command(name: str, language: str) -> list[str]:
    image = os.getenv("STUDY_RUNNER_IMAGE", "code-memory-study-runner:local")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/:@-]{0,250}", image):
        raise RunnerUnavailable
    executable = ["python3", "-I", "/runner/python_worker.py"] if language == "python" else ["node", "--disable-warning=ExperimentalWarning", "/runner/js_worker.mjs"]
    return [
        "docker", "run", "--rm", "--pull=never", "--name", name,
        "--network=none", "--read-only", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--pids-limit=32",
        "--memory=256m", "--memory-swap=256m", "--cpus=1",
        "--ulimit=nofile=64:64", "--ulimit=fsize=1048576:1048576", "--ulimit=core=0:0",
        "--user=65534:65534", "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
        "--workdir=/tmp", "--log-driver=none", "-i", image, *executable,
    ]


async def _read_limited(stream, maximum):
    output = bytearray()
    while chunk := await stream.read(16384):
        output.extend(chunk)
        if len(output) > maximum:
            raise RunnerInputError("실행 출력 한도를 초과했어요.")
    return bytes(output)


async def _remove(name):
    try:
        process = await asyncio.create_subprocess_exec(
            "docker", "rm", "--force", name,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            await asyncio.wait_for(process.wait(), timeout=3)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
    except OSError:
        pass


async def execute(mode: str, request) -> dict:
    load_dotenv(ENV_PATH)
    if os.getenv("STUDY_RUNNER_ENABLED", "false").lower() != "true":
        raise RunnerUnavailable
    if request.language not in ("python", "typescript", "javascript"):
        raise RunnerInputError("실행은 python, typescript, javascript를 지원해요.")
    if mode == "run" and not (request.calls or request.tests):
        raise RunnerInputError("calls 또는 tests를 하나 이상 입력해 주세요.")
    if not _slots.acquire(blocking=False):
        raise RunnerUnavailable
    name = "code-memory-study-" + uuid.uuid4().hex
    process = None
    try:
        process = await asyncio.create_subprocess_exec(
            *command(name, request.language), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )

        async def communicate():
            async def send():
                process.stdin.write(json.dumps({**request.model_dump(), "mode": mode}).encode())
                await process.stdin.drain()
                process.stdin.close()
            tasks = [asyncio.create_task(send()),
                     asyncio.create_task(_read_limited(process.stdout, 4_000_000)),
                     asyncio.create_task(_read_limited(process.stderr, 64_000))]
            try:
                _, stdout, _ = await asyncio.gather(*tasks)
                await process.wait()
                return stdout
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

        try:
            stdout = await asyncio.wait_for(communicate(), timeout=LIMIT_SECONDS)
        except asyncio.TimeoutError:
            raise RunnerTimeout from None
        if process.returncode in (125, 126, 127):
            raise RunnerUnavailable
        try:
            result = json.loads(stdout)
        except (ValueError, UnicodeError):
            raise RunnerInputError("실행 결과를 읽지 못했어요.") from None
        if not isinstance(result, dict):
            raise RunnerInputError("실행 결과 형식이 올바르지 않아요.")
        if "error" in result:
            raise RunnerInputError(str(result["error"])[:300])
        return result
    except (OSError, BrokenPipeError):
        raise RunnerUnavailable from None
    finally:
        try:
            if process is not None and process.returncode is None:
                process.kill()
                await process.wait()
            await _remove(name)
        finally:
            _slots.release()
