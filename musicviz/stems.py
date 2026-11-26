"""Source separation with Demucs + per-stem analysis (energy, spectrum, arrangement map)."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

from .common import SR, SR_HI, Store, pdb, rnd, series
from .loudness import waveform_envelope
from .spectral import freq_axis, ltas_curve

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

STEM_LABELS = {"vocals": "人声 Vocals", "drums": "鼓 Drums", "bass": "贝斯 Bass", "guitar": "吉他 Guitar",
               "piano": "钢琴/键盘 Piano", "other": "其他 Other"}
STEM_ORDER = ["vocals", "drums", "bass", "guitar", "piano", "other"]


def separate(audio, out_dir: Path, model_name: str, device: str, progress=None) -> dict[str, np.ndarray]:
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    model = get_model(model_name)
    model.eval()
    sr = model.samplerate
    wav = audio.st if sr == SR_HI else librosa.resample(audio.st, orig_sr=SR_HI, target_sr=sr)
    x = torch.from_numpy(np.ascontiguousarray(wav)).float()
    ref = x.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    x = (x - mean) / std

    n_models = len(getattr(model, "models", [model]))
    length = x.shape[-1]
    seg_len = int(sr * float(getattr(model, "segment", 8) or 8))

    def cb(d):
        # demucs calls back once per chunk (per model in a bag)
        if progress and d.get("state") == "end":
            frac = min(1.0, (d.get("segment_offset", 0) + seg_len) / length)
            progress((d.get("model_idx_in_bag", 0) + frac) / n_models)

    with torch.inference_mode():
        try:
            est = apply_model(model, x[None], device=device, shifts=1, split=True, overlap=0.25,
                              progress=False, callback=cb)[0]
        except Exception:  # noqa: BLE001  (MPS edge cases) -> CPU
            est = apply_model(model, x[None], device="cpu", shifts=1, split=True, overlap=0.25, progress=False)[0]
    est = (est * std + mean).cpu().numpy()

    stems = {}
    sdir = out_dir / "audio" / "stems"
    sdir.mkdir(parents=True, exist_ok=True)
    for i, name in enumerate(model.sources):
        s = est[i]
        if sr != SR_HI:
            s = librosa.resample(s, orig_sr=sr, target_sr=SR_HI)
        s = s[:, : audio.st.shape[1]]
        if s.shape[1] < audio.st.shape[1]:
            s = np.pad(s, ((0, 0), (0, audio.st.shape[1] - s.shape[1])))
        stems[name] = s.astype(np.float32)
        sf.write(sdir / f"{name}.flac", np.clip(s.T, -1, 1), SR_HI, subtype="PCM_16")
    return stems


def analyze(audio, stems: dict[str, np.ndarray], store: Store, bars: list, model_name: str) -> tuple[dict, dict]:
    names = [n for n in STEM_ORDER if n in stems] + [n for n in stems if n not in STEM_ORDER]
    total_e = sum(float((s ** 2).sum()) for s in stems.values()) + 1e-12
    out_stems = []
    mono22 = {}
    rate = SR_HI
    hop = rate // 10  # 10 Hz energy envelope
    for name in names:
        s = stems[name]
        m = s.mean(axis=0)
        m22 = librosa.resample(m, orig_sr=SR_HI, target_sr=SR, res_type="soxr_hq")
        mono22[name] = m22
        n = len(m) // hop
        rms = np.sqrt((m[: n * hop].reshape(n, hop) ** 2).mean(axis=1))
        rms_db = 20 * np.log10(np.maximum(rms, 1e-6))
        active = rms_db > max(rms_db.max() - 35, -60)
        mel = librosa.feature.melspectrogram(y=m22, sr=SR, n_fft=2048, hop_length=1024, n_mels=96, fmax=SR / 2)
        mel_db = librosa.power_to_db(mel, ref=1.0)
        mel_f = librosa.mel_frequencies(n_mels=96, fmax=SR / 2)
        P = np.abs(librosa.stft(m, n_fft=4096, hop_length=4096)) ** 2
        f, lt = ltas_curve(P.mean(axis=1), librosa.fft_frequencies(sr=SR_HI, n_fft=4096), n=200, frac_oct=1 / 6)
        # per-bar energy for the arrangement map
        bar_db = []
        for a, b in bars:
            seg = m[int(a * rate): int(b * rate)]
            bar_db.append(float(20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-6)) if len(seg) else -120.0)
        out_stems.append({
            "name": name,
            "label": STEM_LABELS.get(name, name),
            "file": f"audio/stems/{name}.flac",
            "energy_share": rnd(float((s ** 2).sum()) / total_e * 100, 2),
            "peak_dbfs": rnd(float(20 * np.log10(np.abs(s).max() + 1e-9)), 2),
            "rms_dbfs": rnd(float(20 * np.log10(np.sqrt(np.mean(s ** 2)) + 1e-9)), 2),
            "active_ratio": rnd(float(active.mean()), 3),
            "energy": series(np.maximum(rms_db, -80), 0.05, 0.1, 1),
            "waveform": {**store.raw(f"wave_{name}", waveform_envelope(s, rate, 100), "int8"), "per_sec": 100, "channels": 2},
            "mel": store.heatmap(f"mel_{name}", mel_db, lo=-90, hi=-10, t0=0, t1=mel.shape[1] * 1024 / SR,
                                 axis=freq_axis(mel_f, (50, 100, 200, 500, 1000, 2000, 4000, 8000)), max_frames=6000),
            "ltas": rnd(lt, 1),
            "bar_db": rnd(bar_db, 1),
        })
    return {"model": model_name, "ltas_freqs": rnd(f, 1), "items": out_stems}, {"mono22": mono22}
