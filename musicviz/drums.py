"""Drum hit detection (kick / snare / hi-hat) and step-grid pattern extraction."""
from __future__ import annotations

from collections import Counter

import librosa
import numpy as np

from .common import SR, rnd

HOP = 256
INSTR = [  # name, label, f_lo, f_hi, gm note
    ("kick", "底鼓 Kick", 30, 130, 36),
    ("snare", "军鼓 Snare", 160, 2500, 38),
    ("hihat", "镲片 Hi-hat", 6000, 11000, 42),
]


def analyze(y: np.ndarray, beats: np.ndarray, downbeats: np.ndarray, bpb: int) -> dict:
    S = np.abs(librosa.stft(y, n_fft=1024, hop_length=HOP)) ** 2
    freqs = librosa.fft_frequencies(sr=SR, n_fft=1024)
    total = S.sum(axis=0) + 1e-12
    hits = {}
    for name, _, lo, hi, _ in INSTR:
        m = (freqs >= lo) & (freqs < hi)
        band = np.log1p(1e3 * S[m].sum(axis=0) / (S[m].sum(axis=0).max() + 1e-12))
        flux = np.r_[0, np.maximum(np.diff(band), 0)]
        flux = flux / (flux.max() + 1e-9)
        delta = {"kick": 0.12, "snare": 0.10, "hihat": 0.08}[name]
        pk = librosa.util.peak_pick(flux, pre_max=3, post_max=3, pre_avg=10, post_avg=10, delta=delta, wait=4)
        share = S[m].sum(axis=0) / total
        if name == "snare":  # snare needs broadband noise: require energy above 1 kHz too
            hm = (freqs >= 1000) & (freqs < 8000)
            noise = S[hm].sum(axis=0) / total
            pk = pk[noise[pk] > np.percentile(noise, 40)]
        if name == "kick":
            pk = pk[share[pk] > np.percentile(share, 35)]
        t = librosa.frames_to_time(pk, sr=SR, hop_length=HOP)
        vel = flux[pk]
        hits[name] = (t, vel)

    # 16th-note grid quantisation
    steps_per_beat = 4
    n_steps = bpb * steps_per_beat
    grid_t = []
    for i in range(len(beats) - 1):
        for s in range(steps_per_beat):
            grid_t.append(beats[i] + (beats[i + 1] - beats[i]) * s / steps_per_beat)
    grid_t = np.array(grid_t)
    bars = np.asarray(downbeats, float)
    out_hits, patterns = [], []
    per_instr_prob = {}
    bar_patterns = []
    if len(grid_t) and len(bars) >= 2:
        nbars = len(bars) - 1
        P = {name: np.zeros((nbars, n_steps)) for name, *_ in INSTR}
        for name, *_ in INSTR:
            t, v = hits[name]
            for tt, vv in zip(t, v):
                j = int(np.argmin(np.abs(grid_t - tt)))
                step_len = (beats[1] - beats[0]) / steps_per_beat if len(beats) > 1 else 0.1
                if abs(grid_t[j] - tt) > step_len * 0.6:
                    continue
                k = np.searchsorted(bars, grid_t[j] + 1e-4) - 1
                if 0 <= k < nbars:
                    pos = int(round((grid_t[j] - bars[k]) / ((bars[k + 1] - bars[k]) / n_steps)))
                    if 0 <= pos < n_steps:
                        P[name][k, pos] = max(P[name][k, pos], vv)
        for name, *_ in INSTR:
            per_instr_prob[name] = rnd((P[name] > 0).mean(axis=0), 3)
        for k in range(nbars):
            key = tuple("".join("x" if P[name][k, s] > 0 else "." for s in range(n_steps)) for name, *_ in INSTR)
            bar_patterns.append(key)
        cnt = Counter(p for p in bar_patterns if any("x" in r for r in p))
        for pat, c in cnt.most_common(4):
            patterns.append({"count": c, "rows": {INSTR[i][0]: pat[i] for i in range(len(INSTR))}})
    for name, label, *_ in INSTR:
        t, v = hits[name]
        out_hits.append({"name": name, "label": label, "t": rnd(t, 3), "v": rnd(v, 2)})

    return {
        "instruments": [{"name": n, "label": l, "gm": g} for n, l, _, _, g in INSTR],
        "hits": out_hits,
        "steps_per_bar": n_steps,
        "step_prob": per_instr_prob,
        "patterns": patterns,
        "bar_pattern_ids": _ids(bar_patterns),
        "density_per_bar": [sum(r.count("x") for r in p) for p in bar_patterns],
        "accents": accents(y),
    }


ACCENT_BANDS = [("kick", 35, 130), ("snare", 180, 2500)]


def accents(y: np.ndarray, sr: int = SR) -> list:
    """The hits you actually hear as hits: [{name, t, v}] with t = the attack (±5 ms) and v = real loudness of the hit
    relative to the song's loud hits (0.3 … 1.3). `hits` above is tuned for pattern grids and is far too sensitive
    (ghost notes, bleed) to drive visuals; this list is sparse, loudness-true and tightly timed."""
    from scipy.signal import butter, sosfiltfilt, find_peaks
    y = np.asarray(y, float)
    if len(y) < sr:
        return []
    w = max(1, int(sr * 0.004))
    step = max(1, int(sr * 0.002))                      # 2 ms envelope
    def envelope(lo, hi):
        sos = butter(4, [lo, min(hi, sr / 2 - 100)], btype="band", fs=sr, output="sos")
        z = np.abs(sosfiltfilt(sos, y))
        return np.convolve(z, np.ones(w) / w, "same")[::step]
    fs = sr / step
    hi_env = envelope(1500, 9000)
    out = []
    for name, lo, hi in ACCENT_BANDS:
        e = envelope(lo, hi)
        if e.max() <= 1e-6:
            out.append({"name": name, "t": [], "v": []})
            continue
        pk, _ = find_peaks(e, distance=int(0.09 * fs), prominence=0.12 * np.percentile(e, 99.5))
        if not len(pk):
            out.append({"name": name, "t": [], "v": []})
            continue
        ref = np.percentile(e[pk], 90) + 1e-9
        ts, vs = [], []
        for i in pk:
            v = e[i] / ref
            if v < 0.3:
                continue
            a = max(0, i - int(0.07 * fs))
            seg = e[a:i + 1]
            floor = seg.min()
            if e[i] - floor < 0.5 * e[i]:               # no real attack: a sustained tail, not a hit
                continue
            if name == "snare" and hi_env[a:i + int(0.03 * fs)].max() < 0.25 * np.percentile(hi_env, 95):
                continue                                # a snare needs noise up top (otherwise it is a tom / kick body)
            thr = floor + 0.3 * (e[i] - floor)
            j = i
            while j > a and e[j - 1] > thr:
                j -= 1
            ts.append(j / fs)
            vs.append(min(1.3, v))
        out.append({"name": name, "t": rnd(np.array(ts), 3), "v": rnd(np.array(vs), 2)})
    return out


def _ids(pats):
    m, out = {}, []
    for p in pats:
        if not any("x" in r for r in p):
            out.append(-1)
            continue
        m.setdefault(p, len(m))
        out.append(m[p])
    return out
