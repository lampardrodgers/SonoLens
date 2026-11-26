"""Orchestrates the whole analysis and writes results/<id>/analysis.json (+ binaries, stems, MIDI)."""
from __future__ import annotations

import hashlib
import shutil
import time
import traceback
from pathlib import Path
from typing import Callable

import librosa
import numpy as np

from . import audio_io, drums, harmony, loudness, melody, rhythm, spectral, stems, stereo, story, structure, transcribe
from .common import FPS, HOP, NOTE_NAMES, SR, SR_HI, Store, rnd, write_json

VERSION = 1

STEPS = [  # key, label, weight
    ("decode", "解码音频", 2), ("loudness", "响度与动态", 4), ("spectral", "频谱分析", 8), ("rhythm", "节拍与速度", 6),
    ("separate", "乐器分离 (Demucs)", 34), ("stems", "分轨分析", 6), ("harmony", "调性与和弦", 6),
    ("structure", "段落结构", 4), ("drums", "鼓组节奏型", 3), ("melody", "旋律音高", 10),
    ("transcribe", "音符转录 / MIDI", 12), ("stereo", "立体声像", 3), ("story", "生成影院叙事", 2), ("summary", "汇总报告", 2),
]


def file_id(path: Path, opts: dict) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    h.update(repr(sorted(opts.items())).encode())
    h.update(str(VERSION).encode())
    return h.hexdigest()[:12]


def pick_device() -> str:
    try:
        import torch
        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    except Exception:  # noqa: BLE001
        pass
    return "cpu"


class Progress:
    def __init__(self, cb: Callable[[float, str], None] | None):
        self.cb = cb
        self.total = sum(w for *_, w in STEPS)
        self.done = 0.0
        self.cur = None

    def start(self, key):
        self.cur = next(s for s in STEPS if s[0] == key)
        self.emit(0)

    def emit(self, frac):
        if self.cb:
            self.cb(min(0.999, (self.done + self.cur[2] * frac) / self.total), self.cur[1])

    def end(self):
        self.done += self.cur[2]


def descriptors(A: dict) -> list:
    def cl(x):
        return float(np.clip(x, 0, 1))
    L = A.get("loudness", {})
    R = A.get("rhythm", {})
    Sp = A.get("spectral", {})
    H = A.get("harmony", {})
    St = A.get("stereo", {})
    lufs = L.get("integrated_lufs") or -30
    cent = (Sp.get("features", {}).get("centroid", {}).get("stats", {}) or {}).get("median") or 1500
    dens = np.mean([v for v in (R.get("onset_density", {}).get("v") or [0]) if v is not None])
    bpm = R.get("bpm") or 100
    pc = R.get("pulse_clarity") or 1.5
    energy = cl((lufs + 30) / 24) * 0.5 + cl(dens / 6) * 0.25 + cl((cent - 500) / 3500) * 0.25
    dance = cl((pc - 1) / 2.0) * 0.5 + cl(1 - (R.get("tempo_stability_bpm_std") or 5) / 10) * 0.2 + \
        cl(1 - abs(bpm - 118) / 50) * 0.3
    bright = cl((cent - 500) / 3500)
    dyn = cl((L.get("lra") or 0) / 15)
    harmonic = cl(Sp.get("hpss", {}).get("harmonic_share") or 0.5)
    width = cl((St.get("width") or 0) / 0.7)
    cs = H.get("chord_stats", {})
    dur = A["meta"]["duration"]
    complexity = cl(((cs.get("unique") or 0) / 14) * 0.6 + cl(len(H.get("chords", [])) / max(dur, 1) / 0.8) * 0.4)
    major = 1.0 if H.get("key", {}).get("mode") == "major" else 0.0
    valence = cl(0.45 * major + 0.25 * cl((bpm - 60) / 100) + 0.3 * bright)
    return [
        {"key": "energy", "label": "能量 Energy", "value": rnd(energy, 2), "desc": "响度+起音密度+亮度"},
        {"key": "danceability", "label": "律动 Danceability", "value": rnd(dance, 2), "desc": "节拍清晰度+速度稳定+适舞速度"},
        {"key": "valence", "label": "情绪正向 Valence", "value": rnd(valence, 2), "desc": "大小调+速度+亮度 (启发式)"},
        {"key": "brightness", "label": "明亮度 Brightness", "value": rnd(bright, 2), "desc": "频谱质心中位数"},
        {"key": "dynamics", "label": "动态 Dynamics", "value": rnd(dyn, 2), "desc": "响度范围 LRA"},
        {"key": "harmonic", "label": "和声性 Harmonic", "value": rnd(harmonic, 2), "desc": "HPSS 谐波能量占比"},
        {"key": "width", "label": "声场宽度 Width", "value": rnd(width, 2), "desc": "Side/Mid 能量比"},
        {"key": "complexity", "label": "和声复杂度", "value": rnd(complexity, 2), "desc": "和弦种类+换和弦频率"},
    ]


def summary_text(A: dict) -> list[str]:
    m, L, R, H, S, St, Sp = (A.get(k, {}) for k in ("meta", "loudness", "rhythm", "harmony", "structure", "stereo", "spectral"))
    lines = []
    d = m.get("duration", 0)
    lines.append(f"时长 {int(d // 60)}:{int(d % 60):02d}，{m.get('codec') or ''} {m.get('sample_rate') or ''} Hz，"
                 f"{'单声道' if m.get('channels') == 1 else '立体声'}。")
    if R.get("bpm"):
        sw = R.get("swing_ratio")
        swt = "，带明显摇摆 (swing≈%.2f)" % sw if sw and sw > 1.35 else ""
        lines.append(f"速度约 {R['bpm']:.1f} BPM，{R.get('time_signature')} 拍，共 {R.get('n_bars')} 小节；"
                     f"速度波动 ±{R.get('tempo_stability_bpm_std')} BPM{swt}。")
    if H.get("key"):
        k = H["key"]
        lines.append(f"调性推测为 {k['name_cn']}（{k['name']}，置信度 {k['confidence']:.2f}；关系调 {k['relative_cn']}）"
                     + (f"，检测到 {H.get('modulations')} 次可能的转调。" if H.get("modulations") else "。"))
        progs = H.get("chord_stats", {}).get("progressions") or []
        if progs:
            lines.append("最常见的和弦进行：" + " → ".join(progs[0]["chords"]) + f"（出现 {progs[0]['count']} 次）。")
    if L.get("integrated_lufs") is not None:
        lines.append(f"综合响度 {L['integrated_lufs']} LUFS，真峰值 {L['true_peak_dbtp']} dBTP，响度范围 LRA {L['lra']} LU，"
                     f"PLR {L.get('plr_db')} dB" + ("；存在削波采样 %d 个。" % L["clipped_samples"] if L.get("clipped_samples", 0) > 10 else "。"))
    if S.get("segments"):
        seq = " | ".join(f"{s['label']}" for s in S["segments"])
        lines.append(f"段落结构（自动聚类）：{seq}。")
    if St:
        if St.get("is_mono"):
            lines.append("音频为单声道（左右完全相同）。")
        else:
            lines.append(f"立体声相关度 {St.get('correlation')}，Side/Mid {St.get('side_to_mid_db')} dB，单声道折叠损失 {St.get('mono_loss_db')} dB。")
    if Sp.get("cutoff_hz"):
        lines.append(f"频谱在约 {Sp['cutoff_hz']/1000:.1f} kHz 处有陡峭截止，可能经过有损压缩。")
    st = A.get("stems", {}).get("items")
    if st:
        top = sorted(st, key=lambda s: -s["energy_share"])[:3]
        lines.append("分轨能量占比最高：" + "、".join(f"{s['label']} {s['energy_share']:.0f}%" for s in top) + "。")
    mel = A.get("melody", {}).get("vocals")
    if mel and mel.get("weak"):
        lines.append("人声分轨能量极低，判断为纯音乐/无明显人声（旋律曲线可能来自串音）。")
    elif mel and mel.get("low"):
        lines.append(f"人声音域约 {mel['low']} – {mel['high']}（{mel['range_semitones']} 个半音），中位音高 {mel['median']}。")
    return lines


def run(src: Path, results_root: Path, opts: dict | None = None,
        progress_cb: Callable[[float, str], None] | None = None, force: bool = False) -> str:
    opts = {"stems_model": "htdemucs_6s", "transcribe": True, "melody": True, **(opts or {})}
    src = Path(src)
    rid = file_id(src, opts)
    out = Path(results_root) / rid
    if (out / "analysis.json").exists() and not force:
        if progress_cb:
            progress_cb(1.0, "已有缓存结果")
        return rid
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    store = Store(out)
    P = Progress(progress_cb)
    device = pick_device()
    errors: dict[str, str] = {}
    timings: dict[str, float] = {}
    A: dict = {"version": VERSION, "id": rid, "options": opts, "device": device}

    def step(key, fn):
        P.start(key)
        t = time.time()
        try:
            return fn()
        except Exception:  # noqa: BLE001
            errors[key] = traceback.format_exc()
            print(f"[musicviz] step {key} failed:\n{errors[key]}")
            return None
        finally:
            timings[key] = round(time.time() - t, 2)
            P.end()

    # 1 decode ---------------------------------------------------------------------------------
    P.start("decode")
    meta = audio_io.probe(src)
    audio, _mix = audio_io.decode(src, out)
    A["meta"] = {**meta, "file_name": src.name, "duration": rnd(audio.duration, 3),
                 "title": meta.get("title") or src.stem, "analysis_sr": SR, "orig_channels": audio.orig_channels}
    A["audio"] = {"mix": "audio/mix.flac"}
    P.end()

    A["loudness"] = step("loudness", lambda: loudness.analyze(audio, store))
    sp = step("spectral", lambda: spectral.analyze(audio, store))
    sp_out, sp_cache = sp if sp else ({}, {})
    A["spectral"] = sp_out
    rh = step("rhythm", lambda: rhythm.analyze(audio, store, device))
    rh_out, rh_cache = rh if rh else ({}, {})
    A["rhythm"] = rh_out
    beats = rh_cache.get("beats", np.arange(0, audio.duration, 0.5))
    downs = rh_cache.get("downbeats", beats[::4])
    bars = rh_out.get("bars") or [[float(a), float(b)] for a, b in zip(downs, np.r_[downs[1:], audio.duration])]

    # stems ----------------------------------------------------------------------------------------
    stem_sig: dict[str, np.ndarray] = {}
    mono22: dict[str, np.ndarray] = {}
    model = opts.get("stems_model")
    if model and model != "none":
        res = step("separate", lambda: stems.separate(audio, out, model, device, progress=P.emit))
        stem_sig = res or {}
        if stem_sig:
            r = step("stems", lambda: stems.analyze(audio, stem_sig, store, bars, model))
            if r:
                A["stems"], c = r
                mono22 = c["mono22"]
    else:
        P.start("separate"); P.end(); P.start("stems"); P.end()

    # harmonic / percussive sources
    def istft_of(M):
        D = sp_cache.get("D")
        return librosa.istft(M * np.exp(1j * np.angle(D)), hop_length=HOP, length=len(audio.mono))

    if mono22:
        harm_y = sum(mono22[k] for k in mono22 if k not in ("drums", "vocals"))
        bass_y = mono22.get("bass")
    else:
        harm_y = istft_of(sp_cache["H"]) if "H" in sp_cache else audio.mono
        bass_y = None
    if not isinstance(harm_y, np.ndarray):
        harm_y = audio.mono

    rms_frames = sp_cache.get("rms", librosa.feature.rms(y=audio.mono, hop_length=HOP)[0])
    hm = step("harmony", lambda: harmony.analyze(harm_y, bass_y, rms_frames, beats, bars, audio.duration, store))
    chroma_raw = hm.pop("_chroma") if hm else None
    A["harmony"] = hm or {}

    vocal_energy = None
    if A.get("stems"):
        v = next((s for s in A["stems"]["items"] if s["name"] == "vocals"), None)
        if v:
            e = v["energy"]
            vv = np.array([x if x is not None else -80 for x in e["v"]], float)
            vocal_energy = (e["t0"] + np.arange(len(vv)) * e["dt"], vv)
    if "cqt_db" in sp_cache:
        A["structure"] = step("structure", lambda: structure.analyze(
            sp_cache["cqt_db"], sp_cache["mfcc"],
            chroma_raw if chroma_raw is not None else librosa.feature.chroma_cqt(y=audio.mono, sr=SR, hop_length=HOP),
            rms_frames, beats, np.asarray(downs), audio.duration, store, vocal_energy)) or {}
    else:
        P.start("structure"); P.end()

    drum_src = mono22.get("drums") if "drums" in mono22 else (istft_of(sp_cache["P"]) if "P" in sp_cache else audio.mono)
    A["drums"] = step("drums", lambda: drums.analyze(drum_src, beats, np.asarray(downs), rh_cache.get("bpb", 4))) or {}
    if A["drums"]:
        A["drums"]["source"] = "drums stem" if "drums" in mono22 else "HPSS percussive"

    # melody ---------------------------------------------------------------------------------------
    def do_melody():
        res = {}
        P.emit(0.05)
        if "vocals" in mono22:
            res["vocals"] = melody.track(mono22["vocals"], librosa.note_to_hz("C2"), librosa.note_to_hz("C6"))
            res["vocals"]["source"] = "vocals stem"
            v = next((s for s in A.get("stems", {}).get("items", []) if s["name"] == "vocals"), None)
            # very quiet vocal stem = mostly separation bleed: flag it
            res["vocals"]["weak"] = bool(v and (v["energy_share"] < 1.0 or v["rms_dbfs"] < -45))
        else:
            res["vocals"] = melody.track(harm_y, librosa.note_to_hz("C2"), librosa.note_to_hz("C6"))
            res["vocals"]["source"] = "harmonic mix (no stems)"
        P.emit(0.7)
        if "bass" in mono22:
            res["bass"] = melody.track(mono22["bass"], librosa.note_to_hz("A0"), librosa.note_to_hz("C4"), frame_length=4096)
            res["bass"]["source"] = "bass stem"
        return res
    A["melody"] = step("melody", do_melody) if opts.get("melody", True) else {}
    A["melody"] = A["melody"] or {}

    # transcription ------------------------------------------------------------------------------
    def do_transcribe():
        tracks = {}
        srcs = {k: v for k, v in mono22.items() if k != "drums"} or {"mix": harm_y}
        for i, (k, y) in enumerate(srcs.items()):
            P.emit(i / max(1, len(srcs)))
            tracks[k] = transcribe.transcribe(y, k)
        bpm = A["rhythm"].get("bpm")
        ts = A["rhythm"].get("time_signature", "4/4").split("/")
        dh = []
        if A.get("drums", {}).get("hits"):
            gm = {d["name"]: d["gm"] for d in A["drums"]["instruments"]}
            dh = [{"t": h["t"], "v": h["v"], "gm": gm[h["name"]]} for h in A["drums"]["hits"]]
        (out / "midi").mkdir(exist_ok=True)
        transcribe.export_midi(out / "midi" / "transcription.mid", bpm, tracks, dh, (int(ts[0]), int(ts[1])))
        for k, notes in tracks.items():
            if notes:
                transcribe.export_midi(out / "midi" / f"{k}.mid", bpm, {k: notes}, None, (int(ts[0]), int(ts[1])))
        return {"tracks": {k: v for k, v in tracks.items()}, "midi": "midi/transcription.mid",
                "per_track": {k: f"midi/{k}.mid" for k, v in tracks.items() if v},
                "engine": "basic-pitch (Spotify, ONNX)"}
    A["transcription"] = (step("transcribe", do_transcribe) if opts.get("transcribe", True) else None) or {}

    A["stereo"] = step("stereo", lambda: stereo.analyze(audio, store)) or {}
    A["story"] = step("story", lambda: story.analyze(audio, A, sp_cache, chroma_raw, mono22, bars)) or {}

    # summary / enrichment -----------------------------------------------------------------------
    P.start("summary")
    try:
        segs = A.get("structure", {}).get("segments", [])
        chords = A.get("harmony", {}).get("chords", [])
        st_items = A.get("stems", {}).get("items", [])
        for s in segs:
            dur = {}
            for c in chords:
                ov = min(s["end"], c["end"]) - max(s["start"], c["start"])
                if ov > 0 and c["label"] != "N":
                    dur[c["label"]] = dur.get(c["label"], 0) + ov
            s["top_chords"] = [k for k, _ in sorted(dur.items(), key=lambda x: -x[1])[:4]]
            s["n_bars"] = sum(1 for a, b in bars if a >= s["start"] - 0.05 and a < s["end"] - 0.05)
            act = []
            for it in st_items:
                bdb = [v for (a, b), v in zip(bars, it["bar_db"]) if a >= s["start"] - 0.05 and a < s["end"] - 0.05 and v is not None]
                if bdb and np.mean(bdb) > -45:
                    act.append(it["name"])
            s["active_stems"] = act
        A["descriptors"] = descriptors(A)
        A["summary"] = summary_text(A)
    except Exception:  # noqa: BLE001
        errors["summary"] = traceback.format_exc()
    A["errors"] = errors
    A["timings"] = timings
    A["created"] = time.strftime("%Y-%m-%d %H:%M:%S")
    write_json(out / "analysis.json", A)
    write_json(out / "meta.json", {
        "id": rid, "title": A["meta"].get("title"), "artist": A["meta"].get("artist"), "file_name": src.name,
        "duration": A["meta"]["duration"], "bpm": A.get("rhythm", {}).get("bpm"),
        "key": A.get("harmony", {}).get("key", {}).get("name"), "lufs": A.get("loudness", {}).get("integrated_lufs"),
        "created": A["created"], "options": opts, "errors": list(errors.keys())})
    P.end()
    if progress_cb:
        progress_cb(1.0, "完成")
    return rid
