"""Stereo image: correlation, width, balance, per-band width, mono compatibility, vectorscope density."""
from __future__ import annotations

import librosa
import numpy as np

from .common import SR_HI, Store, db, pdb, rnd, series

BANDS = [(20, 120), (120, 250), (250, 500), (500, 1000), (1000, 2000), (2000, 4000), (4000, 8000), (8000, 16000), (16000, 20000)]


def analyze(audio, store: Store) -> dict:
    L, R = audio.st[0].astype(np.float64), audio.st[1].astype(np.float64)
    M, S = (L + R) / 2, (L - R) / 2
    rate = SR_HI
    win = rate // 10
    n = len(L) // win
    Lb, Rb = L[: n * win].reshape(n, win), R[: n * win].reshape(n, win)
    Mb, Sb = M[: n * win].reshape(n, win), S[: n * win].reshape(n, win)
    num = (Lb * Rb).sum(1)
    den = np.sqrt((Lb ** 2).sum(1) * (Rb ** 2).sum(1)) + 1e-12
    corr = num / den
    loud = np.sqrt((Mb ** 2).mean(1)) > 1e-4
    corr = np.where(loud, corr, np.nan)
    width = np.sqrt((Sb ** 2).mean(1)) / (np.sqrt((Mb ** 2).mean(1)) + 1e-12)
    width = np.where(loud, width, np.nan)
    bal = db(np.sqrt((Lb ** 2).mean(1))) - db(np.sqrt((Rb ** 2).mean(1)))
    bal = np.where(loud, bal, np.nan)

    is_mono = bool(np.allclose(L, R, atol=1e-5))
    overall_corr = float(np.nansum(num) / (np.sqrt((L ** 2).sum() * (R ** 2).sum()) + 1e-12))

    # per-band width via STFT
    Ls = librosa.stft(L.astype(np.float32), n_fft=4096, hop_length=2048)
    Rs = librosa.stft(R.astype(np.float32), n_fft=4096, hop_length=2048)
    f = librosa.fft_frequencies(sr=rate, n_fft=4096)
    Ms, Ss = (Ls + Rs) / 2, (Ls - Rs) / 2
    band_out = []
    for lo, hi in BANDS:
        m = (f >= lo) & (f < hi)
        me, se = (np.abs(Ms[m]) ** 2).sum(), (np.abs(Ss[m]) ** 2).sum()
        lr = (Ls[m] * np.conj(Rs[m])).sum()
        c = float(np.real(lr) / (np.sqrt((np.abs(Ls[m]) ** 2).sum() * (np.abs(Rs[m]) ** 2).sum()) + 1e-12))
        band_out.append({"lo": lo, "hi": hi, "side_to_mid_db": rnd(float(pdb(se) - pdb(me)), 1),
                         "width": rnd(float(np.sqrt(se / (me + 1e-20))), 3), "corr": rnd(c, 3)})

    # mono compatibility: loudness drop when summed to mono vs stereo average power
    st_pow = (L ** 2 + R ** 2).mean() / 2
    mono_pow = (M ** 2).mean()
    mono_loss = float(pdb(mono_pow) - pdb(st_pow))

    # vectorscope density (x = side, y = mid) rotated 45°
    step = max(1, len(L) // 400000)
    xs, ys = S[::step], M[::step]
    peak = max(np.abs(L).max(), np.abs(R).max(), 1e-6)
    # x = -side so that a left-only signal sits on the upper-left diagonal (goniometer convention)
    H, _, _ = np.histogram2d(ys / peak, -xs / peak, bins=160, range=[[-1, 1], [-1, 1]])
    Hl = np.log1p(H)
    vs = store.heatmap("vectorscope", Hl, lo=0, hi=float(Hl.max() or 1), t0=0, t1=1, unit="", cmap="magma",
                       axis={"kind": "xy"})
    # L/R scatter density for polar level histogram
    ang = np.degrees(np.arctan2(xs, ys + 1e-12))
    ang_hist = np.histogram(ang[np.abs(xs) + np.abs(ys) > 0.02 * peak], bins=36, range=(-90, 90))[0]

    return {
        "is_mono": is_mono,
        "correlation": rnd(overall_corr, 3),
        "width": rnd(float(np.sqrt((S ** 2).mean() / ((M ** 2).mean() + 1e-20))), 3),
        "side_to_mid_db": rnd(float(pdb((S ** 2).mean()) - pdb((M ** 2).mean())), 1),
        "balance_db": rnd(float(db(np.sqrt((L ** 2).mean())) - db(np.sqrt((R ** 2).mean()))), 2),
        "mono_loss_db": rnd(mono_loss, 2),
        "negative_corr_ratio": rnd(float(np.nanmean(corr < 0)) if np.isfinite(corr).any() else 0.0, 3),
        "corr_series": series(corr, 0.05, 0.1, 3),
        "width_series": series(width, 0.05, 0.1, 3),
        "balance_series": series(bal, 0.05, 0.1, 2),
        "bands": band_out,
        "vectorscope": vs,
        "angle_hist": ang_hist.astype(int).tolist(),
    }
