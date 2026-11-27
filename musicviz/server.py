"""FastAPI server: upload + background analysis jobs + static results + web UI."""
from __future__ import annotations

import json
import re
import shutil
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import llm
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
    path = request.url.path
    if path.startswith("/web/") or (path.startswith("/results/") and path.endswith(".json")):
        resp.headers["Cache-Control"] = "no-cache"  # always revalidate UI code / analysis json
    return resp
_pool = ThreadPoolExecutor(max_workers=1)  # one GPU job at a time


def _enrich_all():
    """Bring older results up to the current insight layer (cheap: no audio is decoded)."""
    from .insight import enrich
    for d in sorted(RESULTS.iterdir()):
        if (d / "analysis.json").exists():
            try:
                if enrich(d):
                    print(f"[insight] enriched {d.name}")
            except Exception:  # noqa: BLE001
                print(f"[insight] {d.name} failed:\n{traceback.format_exc()}")


_pool.submit(_enrich_all)
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


# ---------------------------------------------------------------------------------------- AI / LLM
def _analysis(rid: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{12}", rid):
        raise HTTPException(400)
    p = RESULTS / rid / "analysis.json"
    if not p.exists():
        raise HTTPException(404)
    return json.loads(p.read_text(encoding="utf-8"))


def _sse(gen):
    def run_():
        try:
            for ev in gen:
                yield "data: " + json.dumps(ev, ensure_ascii=False) + "\n\n"
        except llm.LLMError as e:
            yield "data: " + json.dumps({"type": "error", "message": str(e)}, ensure_ascii=False) + "\n\n"
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            yield "data: " + json.dumps({"type": "error", "message": f"{type(e).__name__}: {e}"}, ensure_ascii=False) + "\n\n"
    return StreamingResponse(run_(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/llm/config")
def llm_config():
    return llm.public_conf()


@app.post("/api/llm/config")
def llm_config_set(body: dict):
    return llm.update_conf(body)


@app.get("/api/llm/models/{pid}")
def llm_models(pid: str):
    try:
        return {"models": llm.list_models(pid)}
    except llm.LLMError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/llm/test")
def llm_test(body: dict):
    try:
        return llm.ping(body.get("provider"), body.get("model"))
    except llm.LLMError as e:
        return JSONResponse({"ok": False, "error": str(e)})


@app.get("/api/analysis/{rid}/narration")
def narration_get(rid: str):
    p = RESULTS / rid / "llm" / "narration.json"
    if not re.fullmatch(r"[0-9a-f]{12}", rid) or not p.exists():
        return JSONResponse(None)
    return json.loads(p.read_text(encoding="utf-8"))


@app.get("/api/analysis/{rid}/events")
def narration_events(rid: str):
    return llm.extract_events(_analysis(rid))


@app.post("/api/analysis/{rid}/narrate")
def narrate(rid: str, body: dict):
    A = _analysis(rid)
    style = body.get("style", "pro")
    pid = body.get("provider") or llm.load_conf()["active"]
    model = body.get("model") or None
    system, msgs = llm.narrate_messages(A, style)

    def gen():
        conf = llm._settings(pid)
        yield {"type": "start", "provider": pid, "model": model or conf["model"]}
        buf = []
        for t in llm.stream_text(pid, system, msgs, max_tokens=16000, model=model):
            buf.append(t)
            yield {"type": "delta", "text": t}
        text = "".join(buf)
        nar = llm.parse_narration(text)
        nar.update(provider=pid, provider_name=conf["name"], model=model or conf["model"], style=style,
                   created=time.strftime("%Y-%m-%d %H:%M:%S"), raw=text)
        d = RESULTS / rid / "llm"
        d.mkdir(exist_ok=True)
        (d / "narration.json").write_text(json.dumps(nar, ensure_ascii=False, indent=1), encoding="utf-8")
        yield {"type": "done", "narration": nar}
    return _sse(gen())


@app.post("/api/analysis/{rid}/chat")
def chat(rid: str, body: dict):
    A = _analysis(rid)
    p = RESULTS / rid / "llm" / "narration.json"
    nar = json.loads(p.read_text(encoding="utf-8")) if p.exists() else None
    msgs = [{"role": m["role"], "content": str(m["content"])[:8000]} for m in body.get("messages", [])
            if m.get("role") in ("user", "assistant") and m.get("content")][-20:]
    if not msgs or msgs[-1]["role"] != "user":
        raise HTTPException(400, "需要一条用户消息")

    def gen():
        for t in llm.stream_text(body.get("provider"), llm.chat_system(A, nar), msgs, max_tokens=8000, model=body.get("model")):
            yield {"type": "delta", "text": t}
        yield {"type": "done"}
    return _sse(gen())


@app.get("/")
def index():
    return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/api/health")
def health():
    return JSONResponse({"ok": True})


app.mount("/results", StaticFiles(directory=RESULTS), name="results")
app.mount("/web", StaticFiles(directory=WEB), name="web")
