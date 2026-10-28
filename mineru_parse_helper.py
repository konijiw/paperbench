"""Parse one local document through the secured MinerU V1 API."""

from __future__ import annotations

import argparse
import io
import json
import math
import msvcrt
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
import zipfile
from datetime import datetime
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path, PurePosixPath

import httpx

try:
    from pypdf import PdfReader
except ImportError:
    PdfReader = None
try:
    import pypdfium2
except ImportError:
    pypdfium2 = None


MINERU_ROOT = Path(os.environ["PAPERBENCH_MINERU_ROOT"])
MINERU_KIT = Path(os.environ["PAPERBENCH_MINERU_KIT"])
LEGACY_LAYOUT = os.environ.get("PAPERBENCH_MINERU_LAYOUT") == "legacy"
APP_STATE = Path(os.environ["PAPERBENCH_MINERU_STATE"])
API_STATE = MINERU_ROOT / "state" if LEGACY_LAYOUT else APP_STATE
BASE_URL = os.environ.get("PAPERBENCH_MINERU_API_URL", "http://127.0.0.1:8000")
TERMINAL_STATES = {"completed", "partial", "failed", "canceled"}
VALID_TIERS = ("auto", "flash", "basic", "standard", "advanced")


def _api_key() -> str:
    if not LEGACY_LAYOUT:
        return ""
    key_path = MINERU_ROOT / "config" / "api-key.txt"
    return key_path.read_text(encoding="ascii").strip()


def _safe_stem(value: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value).strip(" .")
    return cleaned or "document"


def _sample_page_indices(page_count: int, limit: int = 6) -> list[int]:
    if page_count <= limit:
        return list(range(page_count))
    return sorted({round(i * (page_count - 1) / (limit - 1)) for i in range(limit)})


def _looks_like_image_pdf(path: Path) -> bool:
    character_counts: list[int] = []
    if PdfReader is not None:
        reader = PdfReader(path)
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception:
                return False
        for index in _sample_page_indices(len(reader.pages)):
            try:
                text = reader.pages[index].extract_text() or ""
            except Exception:
                text = ""
            character_counts.append(len(re.sub(r"\s+", "", text)))
    elif pypdfium2 is not None:
        reader = pypdfium2.PdfDocument(str(path))
        for index in _sample_page_indices(len(reader)):
            try:
                page = reader[index]
                textpage = page.get_textpage()
                text = textpage.get_text_range() or ""
                textpage.close()
                page.close()
            except Exception:
                text = ""
            character_counts.append(len(re.sub(r"\s+", "", text)))
        reader.close()
    if not character_counts:
        return False
    low_text_pages = sum(count < 80 for count in character_counts)
    return low_text_pages >= math.ceil(len(character_counts) * 0.7)


def _select_tier(path: Path, requested: str) -> str:
    if requested != "auto":
        return requested
    if path.suffix.lower() == ".pdf" and _looks_like_image_pdf(path):
        return "advanced"
    return "standard"


def _health_ok() -> bool:
    try:
        with httpx.Client(timeout=3, trust_env=False) as client:
            response = client.get(f"{BASE_URL}/v1/health")
            return response.status_code == 200 and response.json().get("status") == "ok"
    except Exception:
        return False


def _ensure_api(timeout_seconds: int = 180) -> None:
    if _health_ok():
        return
    lock_path = API_STATE / "paperbench-api-start.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as lock_file:
        lock_file.seek(0)
        msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
        try:
            _ensure_api_locked(timeout_seconds)
        finally:
            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)


def _ensure_api_locked(timeout_seconds: int) -> None:
    if _health_ok():
        return
    pid_path = API_STATE / ("api.pid" if LEGACY_LAYOUT else "mineru-api.pid")
    executable = MINERU_KIT
    if not executable.is_file():
        raise FileNotFoundError(f"MinerU command not found: {executable}")
    api_key = _api_key()
    if LEGACY_LAYOUT and not api_key:
        raise RuntimeError("The local MinerU API key file is empty.")
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    if LEGACY_LAYOUT:
        env.update({
            "MINERU_HOME": str(MINERU_ROOT / "state"),
            "MINERU_CONFIG": str(MINERU_ROOT / "config" / "config.yaml"),
            "HF_HOME": str(MINERU_ROOT / "cache" / "hf"),
            "MODELSCOPE_CACHE": str(MINERU_ROOT / "cache" / "modelscope"),
            "UV_CACHE_DIR": str(MINERU_ROOT / "cache" / "uv"),
        })
    env["NO_PROXY"] = ",".join(filter(None, [env.get("NO_PROXY", ""), "127.0.0.1", "localhost", "::1"]))
    env["no_proxy"] = env["NO_PROXY"]
    (API_STATE / "uploads").mkdir(parents=True, exist_ok=True)
    logs = MINERU_ROOT / "logs" if LEGACY_LAYOUT else APP_STATE / "mineru-logs"
    logs.mkdir(parents=True, exist_ok=True)
    creation_flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    command = [str(executable), "api-server", "--host", "127.0.0.1", "--port", "8000",
               "--upload-dir", str(API_STATE / "uploads"), "--tier", "standard",
               "--concurrency", "1", "--allow-local-source"]
    if LEGACY_LAYOUT:
        command.extend(["--api-key", api_key, "--log-level", "info", "--preload-models"])
    with (logs / "paperbench-api.stdout.log").open("ab") as stdout, (logs / "paperbench-api.stderr.log").open("ab") as stderr:
        process = subprocess.Popen(command, cwd=MINERU_ROOT, env=env, stdout=stdout,
                                   stderr=stderr, creationflags=creation_flags)
    pid_path.write_text(str(process.pid), encoding="ascii")
    print(f"PAPERBENCH_API_STARTED={process.pid}", file=sys.stderr, flush=True)
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if _health_ok():
            return
        if process.poll() is not None:
            break
        time.sleep(2)
    if process.poll() is None:
        process.kill()
    if pid_path.is_file() and pid_path.read_text(encoding="ascii").strip() == str(process.pid):
        pid_path.unlink()
    raise TimeoutError(f"MinerU API did not become healthy within {timeout_seconds} seconds.")


def _available_output_directory(requested: Path) -> Path:
    candidate = requested.resolve()
    if candidate.parent == candidate:
        raise ValueError("A drive root cannot be used as the output directory.")
    if not candidate.exists():
        return candidate
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    numbered = candidate.with_name(f"{candidate.name}-{timestamp}")
    counter = 2
    while numbered.exists():
        numbered = candidate.with_name(f"{candidate.name}-{timestamp}-{counter}")
        counter += 1
    return numbered


def _safe_extract(zip_bytes: bytes, output_directory: Path, input_path: Path) -> None:
    output_directory.parent.mkdir(parents=True, exist_ok=True)
    staging = output_directory.parent / f".{output_directory.name}.{uuid.uuid4().hex}.partial"
    staging.mkdir()
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
            for item in archive.infolist():
                member = PurePosixPath(item.filename)
                if member.is_absolute() or ".." in member.parts:
                    raise ValueError(f"Unsafe ZIP entry: {item.filename}")
            archive.extractall(staging)
        markdown = staging / "markdown.md"
        if not markdown.is_file():
            raise RuntimeError("MinerU ZIP did not contain markdown.md.")
        structured_json = staging / "structured_content.json"
        if not structured_json.is_file():
            raise RuntimeError("MinerU ZIP did not contain structured_content.json.")
        (staging / "images").mkdir(exist_ok=True)
        shutil.copy2(input_path, staging / input_path.name)
        staging.replace(output_directory)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def _parse_via_api(input_path: Path, output_directory: Path, tier: str, timeout_seconds: int) -> dict[str, object]:
    api_key = _api_key()
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    payload = {
        "files": [{"source": {"type": "local", "path": str(input_path)}, "page_range": "all"}],
        "tier": tier,
        "output_formats": ["zip"],
    }
    deadline = time.monotonic() + timeout_seconds
    with httpx.Client(base_url=BASE_URL, headers=headers, timeout=60, trust_env=False) as client:
        response = client.post("/v1/parse/jobs", json=payload)
        response.raise_for_status()
        job_id = response.json()["job_id"]
        while True:
            response = client.get(f"/v1/parse/jobs/{job_id}")
            response.raise_for_status()
            job = response.json()
            if job["status"] in TERMINAL_STATES:
                break
            if time.monotonic() >= deadline:
                raise TimeoutError(f"MinerU job timed out: {job_id}")
            time.sleep(2)
        if job["status"] not in {"completed", "partial"}:
            raise RuntimeError(f"MinerU parse failed: {json.dumps(job, ensure_ascii=False)}")
        file_result = job["files"][0]
        if file_result["status"] != "completed":
            raise RuntimeError(f"MinerU file parse failed: {json.dumps(file_result, ensure_ascii=False)}")
        zip_reference = file_result["output_files"].get("zip")
        if not zip_reference:
            raise RuntimeError("MinerU job did not return a ZIP output.")
        response = client.get(f"/v1/files/{zip_reference['file_id']}/content")
        response.raise_for_status()
        _safe_extract(response.content, output_directory, input_path)
    return {
        "status": "completed",
        "job_id": job_id,
        "tier": tier,
        "output_directory": str(output_directory),
        "markdown": str(output_directory / "markdown.md"),
        "images": str(output_directory / "images"),
        "json": str(output_directory / "structured_content.json"),
        "source": str(output_directory / input_path.name),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Parse a local document through the MinerU API.")
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, help="Unpacked output directory")
    parser.add_argument("--tier", choices=VALID_TIERS, default="auto")
    parser.add_argument("--timeout", type=int, default=3600, help="Maximum parse wait in seconds")
    args = parser.parse_args()

    if not LEGACY_LAYOUT:
        try:
            mineru_version = version("mineru")
        except PackageNotFoundError as exc:
            raise RuntimeError("所选 Python 环境没有安装 MinerU，请选择安装了 MinerU 4.x 的环境。") from exc
        if not mineru_version.startswith("4."):
            raise RuntimeError(f"当前支持 MinerU 4.x；所选环境为 {mineru_version}。")

    input_path = args.input.expanduser().resolve(strict=True)
    tier = _select_tier(input_path, args.tier)
    requested_output = args.output or MINERU_ROOT / "output" / _safe_stem(input_path.stem)
    output_directory = _available_output_directory(requested_output)

    print(f"selected tier: {tier}", file=sys.stderr)
    _ensure_api()
    result = _parse_via_api(input_path, output_directory, tier, args.timeout)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Canceled.", file=sys.stderr)
        raise SystemExit(130)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
