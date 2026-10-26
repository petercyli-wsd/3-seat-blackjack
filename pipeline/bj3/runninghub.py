"""
A small RunningHub client (standard library only), after octane-tools' integration:
the v2 API (Bearer key; nano-banana-pro image edits) and the ComfyUI workflow API (key in the
body; MatAnyone mattes).

The key is RUNNINGHUB_API_KEY from the environment, or from a .env file at the repo root.
"""

from __future__ import annotations

import json
import mimetypes
import os
import time
import urllib.request
import uuid
from pathlib import Path

BASE = os.environ.get("RUNNINGHUB_API_URL", "https://www.runninghub.ai").rstrip("/")
QUEUE_FULL = 421
PENDING = {804, 813, 10010, 10011, 10012}
FAILED = {"FAILED", "FAILURE", "ERROR", "CANCEL", "CANCELED", "FAIL"}

# MatAnyone (octane-tools' "segmentation-post"): video in at node 14; node 13 saves the matte.
MATANYONE_WORKFLOW = "2072355753909899265"
MATANYONE_VIDEO_NODE = 14
MATANYONE_MATTE_NODE = 13


def api_key() -> str:
    key = os.environ.get("RUNNINGHUB_API_KEY")
    if key:
        return key
    for d in [Path.cwd(), *Path.cwd().parents]:
        env = d / ".env"
        if env.exists():
            for line in env.read_text().splitlines():
                if line.startswith("RUNNINGHUB_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("RUNNINGHUB_API_KEY is not set (environment or .env)")


def _request(path: str, body: bytes, headers: dict[str, str], tries: int = 6) -> dict:
    for attempt in range(tries):
        try:
            req = urllib.request.Request(BASE + path, data=body, headers={"User-Agent": "bj3/0.1", **headers}, method="POST")
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read())
        except OSError:
            if attempt == tries - 1:
                raise
            time.sleep(10)
    raise AssertionError


def _json(path: str, payload: dict, bearer: bool) -> dict:
    headers = {"Content-Type": "application/json"}
    if bearer:
        headers["Authorization"] = f"Bearer {api_key()}"
    return _request(path, json.dumps(payload).encode(), headers)


def _multipart(path: str, fields: dict[str, str], file: Path, bearer: bool) -> dict:
    boundary = uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    ctype = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{file.name}"\r\n'
                 f"Content-Type: {ctype}\r\n\r\n".encode() + file.read_bytes() + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
    if bearer:
        headers["Authorization"] = f"Bearer {api_key()}"
    return _request(path, b"".join(parts), headers)


def download(url: str, to: Path) -> Path:
    to.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "bj3/0.1"}), timeout=600) as r:
        to.write_bytes(r.read())
    return to


# ---------- v2: nano-banana-pro ----------

def upload_image(file: Path) -> str:
    body = _multipart("/openapi/v2/media/upload/binary", {}, file, bearer=True)
    url = (body.get("data") or {}).get("download_url")
    if body.get("code") != 0 or not isinstance(url, str):
        raise RuntimeError(f"upload failed: {body}")
    return url


def nano_banana_edit(images: list[Path], prompt: str, aspect: str = "16:9", resolution: str = "2k", wait: float = 900) -> str:
    """Submit an edit and wait for it; returns the result image's URL."""
    urls = [upload_image(p) for p in images]
    body = _json("/openapi/v2/rhart-image-n-pro/edit", {"imageUrls": urls, "prompt": prompt, "aspectRatio": aspect, "resolution": resolution}, bearer=True)
    task = body.get("taskId")
    if not isinstance(task, str) or not task:
        raise RuntimeError(f"edit not created: {body}")
    deadline = time.time() + wait
    while time.time() < deadline:
        time.sleep(6)
        q = _json("/openapi/v2/query", {"taskId": task}, bearer=True)
        results = [r.get("url") for r in (q.get("results") or []) if isinstance(r.get("url"), str)]
        if results:
            return results[0]
        if str(q.get("status", "")).upper() in FAILED or q.get("errorCode"):
            raise RuntimeError(f"edit {task} failed: {q}")
    raise TimeoutError(f"edit {task} still running after {wait}s")


# ---------- workflows: MatAnyone ----------

def upload_workflow_media(file: Path, kind: str) -> str:
    body = _multipart("/task/openapi/upload", {"apiKey": api_key(), "fileType": kind}, file, bearer=False)
    name = (body.get("data") or {}).get("fileName")
    if body.get("code") != 0 or not isinstance(name, str):
        raise RuntimeError(f"workflow upload failed: {body}")
    return name


def run_workflow(workflow: str, nodes: list[dict], wait: float = 3600) -> list[dict]:
    while True:
        body = _json("/task/openapi/create", {"workflowId": workflow, "apiKey": api_key(), "nodeInfoList": nodes}, bearer=False)
        task = (body.get("data") or {}).get("taskId")
        if body.get("code") == 0 and isinstance(task, str):
            break
        if body.get("code") != QUEUE_FULL:
            raise RuntimeError(f"workflow task not created: {body}")
        time.sleep(30)
    deadline = time.time() + wait
    while time.time() < deadline:
        time.sleep(10)
        st = _json("/task/openapi/status", {"taskId": task, "apiKey": api_key()}, bearer=False)
        state = str(st.get("data") or "").upper() if st.get("code") == 0 else ""
        if state == "SUCCESS":
            out = _json("/task/openapi/outputs", {"taskId": task, "apiKey": api_key()}, bearer=False)
            return out.get("data") if isinstance(out.get("data"), list) else []
        if state in FAILED:
            raise RuntimeError(f"workflow task {task} {state}: {st}")
        if st.get("code") not in (0, *PENDING):
            raise RuntimeError(f"workflow status failed: {st}")
    raise TimeoutError(f"workflow task {task} still running after {wait}s")


def output_url(outputs: list[dict], node: int) -> str:
    """The file a given save node wrote (RunningHub names the node and the file under several keys)."""
    for o in outputs:
        n = next((o.get(k) for k in ("nodeId", "node_id", "node_id_int", "node") if o.get(k) is not None), None)
        url = next((o.get(k) for k in ("fileUrl", "url", "cos_url") if isinstance(o.get(k), str)), None)
        if url and str(n) == str(node):
            return url
    raise RuntimeError(f"no output from node {node}: {outputs}")


def matanyone(video: Path, out: Path) -> Path:
    """The dealer's alpha matte for a clip, as a video the same length."""
    name = upload_workflow_media(video, "video")
    outputs = run_workflow(MATANYONE_WORKFLOW, [
        {"nodeId": MATANYONE_VIDEO_NODE, "fieldName": "video", "fieldValue": name},
        {"nodeId": MATANYONE_MATTE_NODE, "fieldName": "save_output", "fieldValue": True},
    ])
    return download(output_url(outputs, MATANYONE_MATTE_NODE), out)
