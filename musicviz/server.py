"""FastAPI server: upload + background analysis jobs + static results + web UI."""
from __future__ import annotations

import json
import re
import shutil
import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .pipeline import run

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "results"
UPLOADS = RESULTS / "_uploads"
WEB = ROOT / "web"
RESULTS.mkdir(exist_ok=True)
UPLOADS.mkdir(exist_ok=True)

app = FastAPI(title="SonoLens 声镜")


@app.middleware("http")
async def _no_cache_ui(request, call_next):
    resp = await call_next(request)
    if request.url.path.startswith("/web/"):
        resp.headers["Cache-Control"] = "no-cache"  # always revalidate UI code
    return resp
_pool = ThreadPoolExecutor(max_workers=1)  # one GPU job at a time
_jobs: dict[str, dict] = {}
_lock = threading.Lock()

ALLOWED = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".aif", ".aiff", ".wma", ".mp4", ".webm"}


def _job(job_id: str, path: Path, opts: dict):
    def cb(p, msg):
        with _lock:
            _jobs[job_id].update(progress=round(p, 4), message=msg)
    try:
        with _lock:
            _jobs[job_id].update(status="running", message="开始分析")
        rid = run(path, RESULTS, opts, cb)
        with _lock:
            _jobs[job_id].update(status="done", progress=1.0, result_id=rid, message="完成")
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        with _lock:
            _jobs[job_id].update(status="error", message=f"{type(e).__name__}: {e}")


@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...), stems_model: str = Form("htdemucs_6s"),
                  transcribe: bool = Form(True), melody: bool = Form(True)):
    name = Path(file.filename or "audio").name
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED:
        raise HTTPException(400, f"不支持的格式 {ext}")
    if stems_model not in ("htdemucs_6s", "htdemucs", "htdemucs_ft", "none"):
        raise HTTPException(400, "bad stems_model")
    job_id = uuid.uuid4().hex[:10]
    safe = re.sub(r"[^\w\-. 一-鿿]", "_", name)
    dest = UPLOADS / job_id / safe
    dest.parent.mkdir(parents=True)
    with open(dest, "wb") as fh:
        shutil.copyfileobj(file.file, fh)
    with _lock:
        _jobs[job_id] = {"id": job_id, "status": "queued", "progress": 0.0, "message": "排队中", "file": safe}
    _pool.submit(_job, job_id, dest, {"stems_model": stems_model, "transcribe": transcribe, "melody": melody})
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
def job(job_id: str):
    with _lock:
        j = _jobs.get(job_id)
    if not j:
        raise HTTPException(404)
    return j


@app.get("/api/library")
def library():
    items = []
    for m in RESULTS.glob("*/meta.json"):
        try:
            items.append(json.loads(m.read_text(encoding="utf-8")))
        except Exception:  # noqa: BLE001
            pass
    items.sort(key=lambda x: x.get("created", ""), reverse=True)
    return items


@app.delete("/api/library/{rid}")
def delete(rid: str):
    if not re.fullmatch(r"[0-9a-f]{12}", rid):
        raise HTTPException(400)
    d = RESULTS / rid
    if d.exists():
        shutil.rmtree(d)
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/api/health")
def health():
    return JSONResponse({"ok": True})


app.mount("/results", StaticFiles(directory=RESULTS), name="results")
app.mount("/web", StaticFiles(directory=WEB), name="web")
