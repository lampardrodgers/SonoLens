"""Spectrograms (STFT / Mel / CQT), spectral descriptors, band energies, long-term average spectrum."""
from __future__ import annotations

import librosa
import numpy as np

from .common import FPS, HOP, NOTE_NAMES, SR, SR_HI, Store, midi_to_name, pdb, rnd, series

BANDS = [  # name, lo, hi
    ("Sub 低频", 20, 60), ("Bass 低音", 60, 250), ("Low-Mid 中低", 250, 500), ("Mid 中频", 500, 2000),
    ("High-Mid 中高", 2000, 4000), ("Presence 临场", 4000, 6000), ("Brilliance 空气感", 6000, 20000),
]


def fmt_hz(f: float) -> str:
    return f"{f/1000:.1f}k" if f >= 1000 else f"{f:.0f}"


def freq_axis(centers: np.ndarray, ticks_hz=(20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000)) -> dict:
    """Axis descriptor: row centre freqs + tick rows (fractional index)."""
    centers = np.asarray(centers, dtype=float)
    ticks = []
    for f in ticks_hz:
        if centers[0] <= f <= centers[-1]:
            ticks.append([rnd(float(np.interp(f, centers, np.arange(len(centers)))), 2), fmt_hz(f)])
    return {"kind": "freq", "ticks": ticks, "values": rnd(centers, 1), "unit": "Hz"}


def log_freq_matrix(fft_freqs: np.ndarray, n_out: int, fmin: float, fmax: float):
    edges = np.geomspace(fmin, fmax, n_out + 1)
    centers = np.sqrt(edges[:-1] * edges[1:])
    W = np.zeros((n_out, len(fft_freqs)), dtype=np.float32)
    df = fft_freqs[1] - fft_freqs[0]
    for k in range(n_out):
        idx = np.where((fft_freqs >= edges[k]) & (fft_freqs < edges[k + 1]))[0]
        if len(idx):
            W[k, idx] = 1.0 / len(idx)
        else:  # interpolate between neighbours
            pos = centers[k] / df
            i0 = int(np.floor(pos))
            fr = pos - i0
            if i0 + 1 < len(fft_freqs):
                W[k, i0], W[k, i0 + 1] = 1 - fr, fr
    return W, centers


def ltas_curve(power_mean: np.ndarray, fft_freqs: np.ndarray, n: int = 320, frac_oct: float = 1 / 12):
    centers = np.geomspace(20, 20000, n)
    out = np.empty(n)
    for i, f in enumerate(centers):
        lo, hi = f * 2 ** (-frac_oct / 2), f * 2 ** (frac_oct / 2)
        m = (fft_freqs >= lo) & (fft_freqs <= hi)
        out[i] = power_mean[m].mean() if m.any() else np.interp(f, fft_freqs, power_mean)
    return centers, pdb(out)


def detect_cutoff(freqs: np.ndarray, ltas_db: np.ndarray) -> float | None:
    """Look for a brick-wall low-pass (typical of lossy encoding)."""
    hi = freqs >= 10000
    f, v = freqs[hi], ltas_db[hi]
    if len(f) < 8:
        return None
    for i in range(len(f) - 4):
        j = np.searchsorted(f, f[i] * 2 ** (1 / 6))
        if j < len(f) and v[i] - v[j:].max() > 25:
            return float(f[i])
    return None


def analyze(audio, store: Store) -> tuple[dict, dict]:
    """Returns (json_part, cache) – cache keeps arrays other modules reuse."""
    dur = audio.duration
    out: dict = {}

    # ---------- full-band STFT spectrogram @ 44.1 kHz -------------------------------------------
    n_fft_hi, hop_hi = 4096, 1024
    S = np.abs(librosa.stft(audio.mono_hi, n_fft=n_fft_hi, hop_length=hop_hi)) ** 2
    fft_freqs = librosa.fft_frequencies(sr=SR_HI, n_fft=n_fft_hi)
    W, centers = log_freq_matrix(fft_freqs, 480, 20, 20000)
    S_log = pdb(W @ S)
    ref = np.percentile(S_log, 99.9)
    out["stft"] = store.heatmap("stft", S_log - ref, lo=-90, hi=0, t0=0, t1=S.shape[1] * hop_hi / SR_HI,
                                axis=freq_axis(centers), cmap="magma")

    # band energy over time
    bands = []
    tot = S.sum(axis=0) + 1e-20
    total_energy = float(S.sum())
    for name, lo, hi in BANDS:
        m = (fft_freqs >= lo) & (fft_freqs < hi)
        e = S[m].sum(axis=0)
        bands.append({"name": name, "lo": lo, "hi": hi,
                      "share": rnd(float(e.sum()) / total_energy * 100, 2),
                      "db": series(pdb(e) - pdb(tot.max()), 0, hop_hi / SR_HI, 1, max_len=3000),
                      "pct": series(e / tot * 100, 0, hop_hi / SR_HI, 1, max_len=3000)})
    out["bands"] = bands

    # LTAS for L, R, Mid, Side
    ltas = {}
    for key, sig in {"mid": (audio.st[0] + audio.st[1]) / 2, "side": (audio.st[0] - audio.st[1]) / 2,
                     "left": audio.st[0], "right": audio.st[1]}.items():
        P = S if key == "mid" else np.abs(librosa.stft(sig, n_fft=n_fft_hi, hop_length=hop_hi * 2)) ** 2
        f, v = ltas_curve(P.mean(axis=1), fft_freqs)
        ltas[key] = v
    ref_l = ltas["mid"].max()
    out["ltas"] = {"freqs": rnd(f, 1), **{k: rnd(v - ref_l, 2) for k, v in ltas.items()}}
    # spectral tilt (dB/oct) between 100 Hz–10 kHz
    sel = (f >= 100) & (f <= 10000)
    slope = np.polyfit(np.log2(f[sel]), ltas["mid"][sel], 1)[0]
    out["tilt_db_per_oct"] = rnd(float(slope), 2)
    out["cutoff_hz"] = rnd(detect_cutoff(f, ltas["mid"]), 0)
    out["peak_freq_hz"] = rnd(float(f[np.argmax(ltas["mid"])]), 1)
    del S

    # ---------- 22.05 kHz features ---------------------------------------------------------------
    y = audio.mono
    D = librosa.stft(y, n_fft=2048, hop_length=HOP)
    mag = np.abs(D)
    n_frames = mag.shape[1]
    t1 = n_frames / FPS

    mel = librosa.feature.melspectrogram(S=mag ** 2, sr=SR, n_mels=128, fmax=SR / 2)
    mel_db = librosa.power_to_db(mel, ref=np.max)
    mel_f = librosa.mel_frequencies(n_mels=128, fmax=SR / 2)
    out["mel"] = store.heatmap("mel", mel_db, lo=-80, hi=0, t0=0, t1=t1,
                               axis=freq_axis(mel_f, (50, 100, 200, 500, 1000, 2000, 4000, 8000)), cmap="magma")

    # CQT with note axis
    fmin = librosa.note_to_hz("C1")
    bpo = 36
    n_bins = 7 * bpo + 6
    C = np.abs(librosa.cqt(y, sr=SR, hop_length=HOP, fmin=fmin, n_bins=n_bins, bins_per_octave=bpo))
    C_db = librosa.amplitude_to_db(C, ref=np.max)
    midi = 24 + np.arange(n_bins) * 12 / bpo
    ticks = [[float(i), f"C{o + 1}"] for o, i in enumerate(range(0, n_bins, bpo))]
    vals = [f"{midi_to_name(m)}{'' if abs(m - round(m)) < 1e-6 else ('+' if m > round(m) else '-') + str(int(round(abs(m-round(m))*100)))+'¢'}"
            for m in midi]
    out["cqt"] = store.heatmap("cqt", C_db, lo=-70, hi=0, t0=0, t1=C.shape[1] / FPS,
                               axis={"kind": "note", "ticks": ticks, "values": vals, "midi0": 24, "bpo": bpo})

    # descriptors
    cent = librosa.feature.spectral_centroid(S=mag, sr=SR)[0]
    bw = librosa.feature.spectral_bandwidth(S=mag, sr=SR)[0]
    roll = librosa.feature.spectral_rolloff(S=mag, sr=SR, roll_percent=0.85)[0]
    flat = librosa.feature.spectral_flatness(S=mag)[0]
    zcr = librosa.feature.zero_crossing_rate(y, frame_length=2048, hop_length=HOP)[0]
    rms = librosa.feature.rms(S=mag, frame_length=2048)[0]
    flux = np.r_[0, np.sqrt((np.diff(mag, axis=1).clip(0) ** 2).sum(axis=0))]
    flux = flux / (flux.max() + 1e-9)
    loud_mask = rms > (rms.max() * 0.03)

    def stat(x):
        v = x[loud_mask] if loud_mask.any() else x
        return {"mean": rnd(float(np.mean(v)), 3), "median": rnd(float(np.median(v)), 3),
                "std": rnd(float(np.std(v)), 3), "p10": rnd(float(np.percentile(v, 10)), 3),
                "p90": rnd(float(np.percentile(v, 90)), 3)}

    out["features"] = {
        "centroid": {**series(cent, 0, 1 / FPS, 0), "stats": stat(cent), "unit": "Hz"},
        "bandwidth": {**series(bw, 0, 1 / FPS, 0), "stats": stat(bw), "unit": "Hz"},
        "rolloff": {**series(roll, 0, 1 / FPS, 0), "stats": stat(roll), "unit": "Hz"},
        "flatness": {**series(flat, 0, 1 / FPS, 4), "stats": stat(flat), "unit": ""},
        "zcr": {**series(zcr, 0, 1 / FPS, 4), "stats": stat(zcr), "unit": ""},
        "flux": {**series(flux, 0, 1 / FPS, 3), "stats": stat(flux), "unit": ""},
    }

    contrast = librosa.feature.spectral_contrast(S=mag, sr=SR, n_bands=6)
    out["contrast"] = store.heatmap(
        "contrast", contrast, lo=float(np.percentile(contrast, 1)), hi=float(np.percentile(contrast, 99)),
        t0=0, t1=t1, unit="dB", cmap="viridis",
        axis={"kind": "bins", "ticks": [[i, l] for i, l in enumerate(["<200", "200-400", "400-800", "0.8-1.6k", "1.6-3.2k", "3.2-6.4k", ">6.4k"])],
              "values": ["<200Hz", "200-400Hz", "400-800Hz", "0.8-1.6kHz", "1.6-3.2kHz", "3.2-6.4kHz", ">6.4kHz"]})

    mfcc = librosa.feature.mfcc(S=librosa.power_to_db(mel), n_mfcc=20)
    mz = (mfcc - mfcc.mean(axis=1, keepdims=True)) / (mfcc.std(axis=1, keepdims=True) + 1e-9)
    out["mfcc"] = store.heatmap("mfcc", mz, lo=-3, hi=3, t0=0, t1=t1, unit="z", cmap="diverging",
                                axis={"kind": "bins", "ticks": [[i, str(i)] for i in range(0, 20, 4)],
                                      "values": [f"MFCC {i}" for i in range(20)]})

    # harmonic / percussive
    H, P = librosa.decompose.hpss(mag, margin=1.0)
    he, pe = (H ** 2).sum(axis=0), (P ** 2).sum(axis=0)
    hr = he / (he + pe + 1e-12)
    out["hpss"] = {"harmonic_ratio": series(hr, 0, 1 / FPS, 3, max_len=3000),
                   "harmonic_share": rnd(float(he.sum() / (he.sum() + pe.sum())), 3)}

    cache = {"mag": mag, "rms": rms, "D": D, "H": H, "P": P, "cent": cent, "flat": flat,
             "mel_db": mel_db, "mfcc": mfcc, "cqt_db": C_db, "n_frames": n_frames, "flux": flux}
    return out, cache
