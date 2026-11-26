"""Loudness (EBU R128 / BS.1770), peaks, dynamics, waveform envelopes."""
from __future__ import annotations

import numpy as np
import pyloudnorm as pyln
from scipy.signal import resample_poly

from .common import SR_HI, Store, db, rnd, series


def _kweight(st: np.ndarray, rate: int) -> np.ndarray:
    meter = pyln.Meter(rate)
    out = []
    for ch in st:
        z = ch.astype(np.float64)
        for f in meter._filters.values():
            z = f.apply_filter(z)
        out.append(z)
    return np.array(out)


def _windowed_loudness(z2sum: np.ndarray, rate: int, win: float, step: float):
    """z2sum: per-sample sum over channels of K-weighted squared signal."""
    w, s = int(win * rate), int(step * rate)
    c = np.concatenate([[0.0], np.cumsum(z2sum)])
    starts = np.arange(0, max(len(z2sum) - w, 0) + 1, s)
    ms = (c[starts + w] - c[starts]) / w
    lk = -0.691 + 10 * np.log10(np.maximum(ms, 1e-12))
    centers = (starts + w / 2) / rate
    return centers, lk


def _lra(st_lufs: np.ndarray) -> float:
    v = st_lufs[st_lufs > -70]
    if len(v) == 0:
        return 0.0
    ener = np.mean(10 ** ((v + 0.691) / 10))
    rel = -0.691 + 10 * np.log10(ener) - 20
    v = v[v > rel]
    if len(v) < 2:
        return 0.0
    return float(np.percentile(v, 95) - np.percentile(v, 10))


def waveform_envelope(st: np.ndarray, rate: int, per_sec: int) -> np.ndarray:
    """Min/max per bucket for each channel -> int8 array [ch, 2, n]."""
    hop = max(1, rate // per_sec)
    n = st.shape[1] // hop
    seg = st[:, : n * hop].reshape(st.shape[0], n, hop)
    mn, mx = seg.min(axis=2), seg.max(axis=2)
    env = np.stack([mn, mx], axis=1)
    return np.clip(np.round(env * 127), -127, 127).astype(np.int8)


def analyze(audio, store: Store) -> dict:
    st = audio.st
    rate = SR_HI
    meter = pyln.Meter(rate)
    integrated = float(meter.integrated_loudness(st.T.astype(np.float64)))

    z = _kweight(st, rate)
    z2 = (z ** 2).sum(axis=0)
    tm, mom = _windowed_loudness(z2, rate, 0.4, 0.1)
    ts, short = _windowed_loudness(z2, rate, 3.0, 0.1)
    lra = _lra(short)

    sample_peak = float(np.abs(st).max())
    up = resample_poly(st, 4, 1, axis=1)
    true_peak = float(np.abs(up).max())
    del up

    rms_total = float(np.sqrt(np.mean(st ** 2)))
    clip_samples = int((np.abs(st) >= 0.9999).sum())

    # RMS / peak envelopes at 20 Hz
    hop = rate // 20
    n = st.shape[1] // hop
    m = st.mean(axis=0)[: n * hop].reshape(n, hop)
    rms_env = db(np.sqrt((m ** 2).mean(axis=1)))
    peak_env = db(np.abs(st[:, : n * hop]).reshape(2, n, hop).max(axis=(0, 2)))
    crest_env = peak_env - rms_env

    # Dynamic range style metric: loud-part RMS top 20% vs peak (approx. DR meter)
    blk = rate * 3
    nb = st.shape[1] // blk
    if nb >= 2:
        b = st[:, : nb * blk].reshape(2, nb, blk)
        brms = np.sqrt(2 * (b ** 2).mean(axis=2))
        bpk = np.abs(b).max(axis=2)
        k = max(1, int(round(nb * 0.2)))
        top = np.sort(brms, axis=1)[:, -k:]
        r = np.sqrt((top ** 2).mean(axis=1))
        pk2 = np.sort(bpk, axis=1)[:, -2] if nb >= 2 else bpk.max(axis=1)
        dr = float(np.mean(db(pk2) - db(r)))
    else:
        dr = None

    hist_v = short[short > -70]
    hist, edges = np.histogram(hist_v, bins=40, range=(-40, 0)) if len(hist_v) else (np.zeros(40), np.linspace(-40, 0, 41))

    wav = waveform_envelope(st, rate, 200)
    dc = [float(np.mean(ch)) for ch in st]

    return {
        "integrated_lufs": rnd(integrated, 2),
        "lra": rnd(lra, 2),
        "sample_peak_dbfs": rnd(float(db(sample_peak)), 2),
        "true_peak_dbtp": rnd(float(db(true_peak)), 2),
        "rms_dbfs": rnd(float(db(rms_total)), 2),
        "crest_db": rnd(float(db(sample_peak) - db(rms_total)), 2),
        "plr_db": rnd(float(db(true_peak)) - integrated, 2),
        "dr": rnd(dr, 1),
        "max_momentary": rnd(float(mom.max()) if len(mom) else None, 2),
        "max_short_term": rnd(float(short.max()) if len(short) else None, 2),
        "clipped_samples": clip_samples,
        "dc_offset": rnd(dc, 5),
        "momentary": {"t0": float(tm[0]) if len(tm) else 0.2, "dt": 0.1, "v": rnd(np.maximum(mom, -70), 2)},
        "short_term": {"t0": float(ts[0]) if len(ts) else 1.5, "dt": 0.1, "v": rnd(np.maximum(short, -70), 2)},
        "rms": series(rms_env, 0.025, 1 / 20, 2),
        "peak": series(peak_env, 0.025, 1 / 20, 2),
        "crest": series(crest_env, 0.025, 1 / 20, 2),
        "histogram": {"edges": rnd(edges, 1), "counts": hist.astype(int).tolist()},
        "waveform": {**store.raw("waveform", wav, "int8"), "per_sec": 200, "channels": 2},
        "streaming_targets": {k: rnd(v - integrated, 1) for k, v in {
            "Spotify": -14, "Apple Music": -16, "YouTube": -14, "Tidal": -14, "Amazon": -14, "网易云/QQ": -14}.items()},
    }
