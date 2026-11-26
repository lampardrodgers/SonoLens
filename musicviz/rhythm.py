"""Beat / downbeat tracking, tempo, meter, tempogram, onsets, micro-timing / swing."""
from __future__ import annotations

import librosa
import numpy as np
from scipy.ndimage import median_filter

from .common import FPS, HOP, SR, Store, rnd, series

_BT_MODEL = None


def _beat_this(audio, device: str):
    global _BT_MODEL
    import torch
    from beat_this.inference import Audio2Beats, Audio2Frames

    if _BT_MODEL is None:
        _BT_MODEL = Audio2Beats(checkpoint_path="final0", device=device, dbn=False)
    sig = audio.mono_hi.astype(np.float32)
    with torch.inference_mode():
        bl, dl = Audio2Frames.__call__(_BT_MODEL, sig, 44100)
        beats, downs = _BT_MODEL.frames2beats(bl, dl)
    act_b = torch.sigmoid(bl.float()).cpu().numpy()
    act_d = torch.sigmoid(dl.float()).cpu().numpy()
    return np.asarray(beats, float), np.asarray(downs, float), act_b, act_d


def _fallback_downbeats(beats: np.ndarray, oenv: np.ndarray, bpb: int = 4) -> np.ndarray:
    if len(beats) < bpb * 2:
        return beats[:1]
    fr = librosa.time_to_frames(beats, sr=SR, hop_length=HOP).clip(0, len(oenv) - 1)
    strength = oenv[fr]
    best = max(range(bpb), key=lambda p: strength[p::bpb].mean())
    return beats[best::bpb]


def analyze(audio, store: Store, device: str = "cpu") -> tuple[dict, dict]:
    y = audio.mono
    oenv = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP, aggregate=np.median)
    method = "beat_this"
    act = None
    try:
        beats, downs, act_b, act_d = _beat_this(audio, device)
        act = {"beat": series(act_b, 0, 1 / 50, 3, max_len=20000), "downbeat": series(act_d, 0, 1 / 50, 3, max_len=20000)}
        if len(beats) < 4:
            raise RuntimeError("too few beats")
    except Exception:  # noqa: BLE001
        method = "librosa"
        _, bf = librosa.beat.beat_track(onset_envelope=oenv, sr=SR, hop_length=HOP)
        beats = librosa.frames_to_time(bf, sr=SR, hop_length=HOP)
        downs = np.array([])

    ibi = np.diff(beats)
    bpm = float(60 / np.median(ibi)) if len(ibi) else None
    local_bpm = 60 / ibi if len(ibi) else np.array([])
    local_bpm_s = median_filter(local_bpm, size=5, mode="nearest") if len(local_bpm) >= 5 else local_bpm

    # meter
    if len(downs) >= 2:
        counts = [int(((beats >= a - 1e-3) & (beats < b - 1e-3)).sum()) for a, b in zip(downs[:-1], downs[1:])]
        vals, cnts = np.unique(counts, return_counts=True)
        bpb = int(vals[np.argmax(cnts)])
        meter_conf = float(cnts.max() / cnts.sum())
    else:
        bpb, meter_conf = 4, 0.0
        downs = _fallback_downbeats(beats, oenv, bpb)
    bpb = max(2, min(bpb, 12))
    time_sig = f"{bpb}/4" if bpb not in (6, 9, 12) else f"{bpb}/8"

    bar_starts = np.asarray(downs, float)
    if len(bar_starts) and bar_starts[0] > beats[0] + 0.05:
        # pickup (anacrusis) – prepend an implied bar so the grid covers the start
        bar_len = np.median(np.diff(bar_starts)) if len(bar_starts) > 1 else bpb * np.median(ibi)
        bar_starts = np.r_[max(0.0, bar_starts[0] - bar_len), bar_starts]
    bars = [[rnd(a, 3), rnd(b, 3)] for a, b in zip(bar_starts, np.r_[bar_starts[1:], audio.duration])]

    # beat positions within bar (1..bpb)
    beat_pos = []
    for b in beats:
        k = np.searchsorted(bar_starts, b + 1e-3) - 1
        if k < 0:
            beat_pos.append(0)
            continue
        beat_pos.append(int(((beats >= bar_starts[k] - 1e-3) & (beats < b - 1e-3)).sum()) + 1)

    # tempogram -> linear BPM axis
    tg = librosa.feature.tempogram(onset_envelope=oenv, sr=SR, hop_length=HOP, win_length=384)
    tf = librosa.tempo_frequencies(384, hop_length=HOP, sr=SR)
    bpm_axis = np.arange(30, 301, 1.0)
    valid = np.isfinite(tf) & (tf > 0)
    order = np.argsort(tf[valid])
    tfv, tgv = tf[valid][order], tg[valid][order]
    tg_lin = np.empty((len(bpm_axis), tg.shape[1]), np.float32)
    for j in range(tg.shape[1]):
        tg_lin[:, j] = np.interp(bpm_axis, tfv, tgv[:, j])
    tg_lin = tg_lin / (tg_lin.max(axis=0, keepdims=True) + 1e-9)
    tempogram = store.heatmap("tempogram", tg_lin, lo=0, hi=1, t0=0, t1=tg.shape[1] / FPS, unit="", cmap="viridis",
                              axis={"kind": "bpm", "ticks": [[b - 30, str(b)] for b in (30, 60, 90, 120, 150, 180, 210, 240, 270, 300)],
                                    "values": [f"{b:.0f} BPM" for b in bpm_axis]})
    tprof = tg_lin.mean(axis=1)
    peaks = librosa.util.peak_pick(tprof, pre_max=6, post_max=6, pre_avg=6, post_avg=6, delta=0.01, wait=5)
    cands = sorted(((float(bpm_axis[p]), float(tprof[p])) for p in peaks), key=lambda x: -x[1])[:5]

    # onsets & density
    on_f = librosa.onset.onset_detect(onset_envelope=oenv, sr=SR, hop_length=HOP, backtrack=False)
    on_t = librosa.frames_to_time(on_f, sr=SR, hop_length=HOP)
    dens_t = np.arange(0, audio.duration, 0.5)
    dens = np.array([((on_t >= t - 1) & (on_t < t + 1)).sum() / 2.0 for t in dens_t])

    # micro-timing: onset phase within the beat
    phases = []
    for t in on_t:
        k = np.searchsorted(beats, t) - 1
        if 0 <= k < len(beats) - 1:
            phases.append((t - beats[k]) / (beats[k + 1] - beats[k]))
    phases = np.asarray(phases)
    hist, _ = np.histogram(phases, bins=48, range=(0, 1))
    swing = None
    if len(phases) > 30:
        mid = phases[(phases > 0.4) & (phases < 0.8)]
        if len(mid) > 10:
            p = float(np.median(mid))
            swing = p / (1 - p)
    # beat-level offset of onsets nearest to each beat (ms) – timing tightness
    dev = []
    for b in beats:
        if len(on_t):
            d = on_t[np.argmin(np.abs(on_t - b))] - b
            if abs(d) < 0.07:
                dev.append(d * 1000)
    bf = librosa.time_to_frames(beats, sr=SR, hop_length=HOP).clip(0, len(oenv) - 1)
    pulse_clarity = float(oenv[bf].mean() / (oenv.mean() + 1e-9))

    out = {
        "method": method,
        "bpm": rnd(bpm, 2),
        "bpm_candidates": [[rnd(b, 1), rnd(s, 3)] for b, s in cands],
        "tempo_stability_bpm_std": rnd(float(np.std(local_bpm_s)) if len(local_bpm_s) else None, 2),
        "time_signature": time_sig,
        "beats_per_bar": bpb,
        "meter_confidence": rnd(meter_conf, 2),
        "beats": rnd(beats, 3),
        "beat_pos": beat_pos,
        "downbeats": rnd(downs, 3),
        "bars": bars,
        "n_bars": len(bars),
        "local_bpm": {"t": rnd((beats[:-1] + beats[1:]) / 2, 3), "v": rnd(local_bpm_s, 2)},
        "activation": act,
        "onset_env": series(oenv / (oenv.max() + 1e-9), 0, 1 / FPS, 3),
        "onsets": rnd(on_t, 3),
        "onset_density": {"t0": 0, "dt": 0.5, "v": rnd(dens, 2)},
        "tempogram": tempogram,
        "tempo_profile": {"bpm": bpm_axis.tolist(), "v": rnd(tprof, 3)},
        "microtiming_hist": hist.astype(int).tolist(),
        "swing_ratio": rnd(swing, 2),
        "timing_dev_ms": {"mean": rnd(float(np.mean(dev)), 1) if dev else None,
                          "std": rnd(float(np.std(dev)), 1) if dev else None},
        "pulse_clarity": rnd(pulse_clarity, 2),
    }
    cache = {"beats": beats, "downbeats": bar_starts, "bpb": bpb, "oenv": oenv, "bpm": bpm, "onsets": on_t}
    return out, cache
