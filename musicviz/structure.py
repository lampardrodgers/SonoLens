"""Song structure: self-similarity, novelty, Laplacian spectral-clustering segmentation, section labels."""
from __future__ import annotations

import librosa
import numpy as np
import scipy.ndimage
import scipy.sparse.csgraph
from sklearn.cluster import KMeans

from .common import HOP, SR, Store, pool_time, rnd

LETTERS = "ABCDEFGHIJ"


def _sync(M, frames):
    return librosa.util.sync(M, frames, aggregate=np.median)


def _foote(S: np.ndarray, k: int) -> np.ndarray:
    k = max(2, min(k, S.shape[0] // 2))
    g = np.outer(np.hanning(2 * k), np.hanning(2 * k))
    sign = np.ones((2 * k, 2 * k))
    sign[:k, k:] = sign[k:, :k] = -1
    K = g * sign
    Sp = np.pad(S, k, mode="constant")
    nov = np.array([(Sp[i:i + 2 * k, i:i + 2 * k] * K).sum() for i in range(S.shape[0])])
    nov = np.maximum(nov, 0)
    return nov / (nov.max() + 1e-9)


def analyze(cqt_db: np.ndarray, mfcc: np.ndarray, chroma_like: np.ndarray, rms: np.ndarray, beats: np.ndarray,
            downbeats: np.ndarray, duration: float, store: Store, vocal_energy=None) -> dict:
    n = cqt_db.shape[1]
    bf = np.unique(np.clip(librosa.time_to_frames(beats, sr=SR, hop_length=HOP), 0, n - 1))
    bf_full = librosa.util.fix_frames(bf, x_min=0, x_max=n)
    bt = librosa.frames_to_time(bf_full, sr=SR, hop_length=HOP)
    bt[-1] = duration
    Csync = _sync(cqt_db, bf_full)
    Msync = _sync(mfcc, bf_full)
    Hsync = _sync(chroma_like[:, :n] if chroma_like.shape[1] >= n else np.pad(chroma_like, ((0, 0), (0, n - chroma_like.shape[1]))), bf_full)
    nb = Csync.shape[1]

    # dense similarity for display (chroma + timbre)
    def nrm(X):
        X = (X - X.mean(axis=1, keepdims=True)) / (X.std(axis=1, keepdims=True) + 1e-9)
        return X / (np.linalg.norm(X, axis=0, keepdims=True) + 1e-9)
    F = np.vstack([nrm(Hsync), 0.7 * nrm(Msync)])
    F = F / (np.linalg.norm(F, axis=0, keepdims=True) + 1e-9)
    Sdense = np.clip(F.T @ F, -1, 1)
    Sdisp = (Sdense + 1) / 2
    if nb > 900:
        Sdisp, f = pool_time(Sdisp, 900, "mean")
        Sdisp, _ = pool_time(Sdisp.T, 900, "mean")
        Sdisp = Sdisp.T
    ssm = store.heatmap("ssm", Sdisp[::-1].copy(), lo=0.35, hi=1.0, t0=0, t1=duration, unit="", cmap="magma",
                        axis={"kind": "time"}, max_frames=900)
    ssm["beat_times"] = rnd(bt, 3)

    novelty = _foote(Sdense, 16 if nb > 64 else max(4, nb // 6))

    # ---------- Laplacian segmentation (McFee & Ellis 2014) ---------------------------------
    segments = []
    if nb >= 24:
        R = librosa.segment.recurrence_matrix(Csync, width=3, mode="affinity", sym=True)
        df = librosa.segment.timelag_filter(scipy.ndimage.median_filter)
        Rf = df(R, size=(1, 7))
        path_distance = np.sum(np.diff(Msync, axis=1) ** 2, axis=0)
        sigma = np.median(path_distance) + 1e-9
        path_sim = np.exp(-path_distance / sigma)
        R_path = np.diag(path_sim, k=1) + np.diag(path_sim, k=-1)
        deg_path = np.sum(R_path, axis=1)
        deg_rec = np.sum(Rf, axis=1)
        mu = deg_path.dot(deg_path + deg_rec) / (np.sum((deg_path + deg_rec) ** 2) + 1e-9)
        A = mu * Rf + (1 - mu) * R_path
        L = scipy.sparse.csgraph.laplacian(A, normed=True)
        evals, evecs = np.linalg.eigh(L)
        evecs = scipy.ndimage.median_filter(evecs, size=(9, 1))
        Cn = np.cumsum(evecs ** 2, axis=1) ** 0.5
        gaps = np.diff(evals[:10])
        k = int(np.clip(np.argmax(gaps[2:8]) + 3, 3, 8)) if len(gaps) >= 8 else 3
        k = min(k, max(2, nb // 12))
        X = evecs[:, :k] / (Cn[:, k - 1:k] + 1e-9)
        seg_ids = KMeans(n_clusters=k, n_init=10, random_state=0).fit_predict(X)
        bound_beats = np.r_[0, 1 + np.flatnonzero(seg_ids[:-1] != seg_ids[1:])]
        seg_lab = seg_ids[bound_beats]
        times = list(bt[bound_beats]) + [duration]
        segs = [[times[i], times[i + 1], int(seg_lab[i])] for i in range(len(bound_beats))]
        # snap to downbeats
        if len(downbeats) > 2:
            for s in segs[1:]:
                j = int(np.argmin(np.abs(downbeats - s[0])))
                if abs(downbeats[j] - s[0]) < 1.6:
                    s[0] = float(downbeats[j])
            for i in range(len(segs) - 1):
                segs[i][1] = segs[i + 1][0]
        # merge too-short segments (< ~2 bars)
        bar_len = float(np.median(np.diff(downbeats))) if len(downbeats) > 2 else 4 * float(np.median(np.diff(beats)))
        changed = True
        while changed and len(segs) > 1:
            changed = False
            for i, s in enumerate(segs):
                if s[1] - s[0] < 1.8 * bar_len:
                    if i == 0:
                        segs[1][0] = s[0]
                    else:
                        segs[i - 1][1] = s[1]
                    segs.pop(i)
                    changed = True
                    break
        # re-merge adjacent same-label
        merged = []
        for s in segs:
            if merged and merged[-1][2] == s[2]:
                merged[-1][1] = s[1]
            else:
                merged.append(s)
        segments = merged
    else:
        segments = [[0.0, duration, 0]]

    # letters by first appearance
    order = {}
    for s in segments:
        order.setdefault(s[2], LETTERS[len(order) % len(LETTERS)])

    rms_t = np.arange(len(rms)) * HOP / SR
    def mean_db(a, b, arr=rms, t=rms_t):
        m = (t >= a) & (t < b)
        return float(20 * np.log10(np.mean(arr[m]) + 1e-9)) if m.any() else -80.0

    out_segs = []
    for a, b, lab in segments:
        e = mean_db(a, b)
        item = {"start": rnd(a, 3), "end": rnd(b, 3), "label": order[lab], "cluster": int(lab), "energy_db": rnd(e, 1)}
        if vocal_energy is not None:
            vt, vv = vocal_energy
            m = (vt >= a) & (vt < b)
            item["vocal_db"] = rnd(float(np.mean(vv[m])) if m.any() else -80.0, 1)
        out_segs.append(item)

    # heuristic names
    if out_segs:
        energies = np.array([s["energy_db"] for s in out_segs])
        counts = {}
        for s in out_segs:
            counts[s["label"]] = counts.get(s["label"], 0) + 1
        repeated = [l for l, c in counts.items() if c >= 2]
        lab_e = {l: np.mean([s["energy_db"] for s in out_segs if s["label"] == l]) for l in counts}
        chorus = max(repeated, key=lambda l: lab_e[l]) if repeated else None
        verse_c = [l for l in repeated if l != chorus]
        verse = max(verse_c, key=lambda l: counts[l]) if verse_c else None
        med = float(np.median(energies))
        e_max = float(energies.max())
        for i, s in enumerate(out_segs):
            h = None
            if s["label"] == chorus:
                h = "副歌 Chorus"
            elif s["label"] == verse:
                h = "主歌 Verse"
            if i == 0 and s["energy_db"] <= med and s["label"] != chorus and len(out_segs) > 2:
                h = "前奏 Intro"
            elif i == len(out_segs) - 1 and s["energy_db"] <= med and s["label"] != chorus and len(out_segs) > 2:
                h = "尾奏 Outro"
            elif h is None:
                if vocal_energy is not None and s.get("vocal_db", 0) < max(x.get("vocal_db", -80) for x in out_segs) - 18:
                    h = "间奏 Interlude"
                elif counts[s["label"]] == 1 and repeated and 0 < i < len(out_segs) - 1:
                    # a one-off section between repeating material is bridge-like
                    h = "桥段 Bridge"
                elif not repeated and s["energy_db"] >= e_max - 0.5 and len(out_segs) > 2:
                    h = "高潮 Peak"
                else:
                    h = "段落 Section"
            s["hint"] = h

    return {
        "ssm": ssm,
        "novelty": {"t": rnd(bt[:len(novelty)], 3), "v": rnd(novelty, 3)},
        "segments": out_segs,
        "n_clusters": len(order),
    }
