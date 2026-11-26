"""Chroma, key (global + local), chord recognition with Viterbi smoothing, roman numerals, progressions."""
from __future__ import annotations

from collections import Counter

import librosa
import numpy as np

from .common import FPS, HOP, NOTE_NAMES, NOTE_NAMES_FLAT, SR, Store, rnd

KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

QUALITIES = {  # name: (intervals, display suffix, weight)
    "maj": ((0, 4, 7), "", 1.0),
    "min": ((0, 3, 7), "m", 1.0),
    "7": ((0, 4, 7, 10), "7", 0.94),
    "maj7": ((0, 4, 7, 11), "maj7", 0.94),
    "min7": ((0, 3, 7, 10), "m7", 0.94),
    "dim": ((0, 3, 6), "dim", 0.9),
    "hdim7": ((0, 3, 6, 10), "m7b5", 0.88),
    "aug": ((0, 4, 8), "aug", 0.86),
    "sus4": ((0, 5, 7), "sus4", 0.9),
    "sus2": ((0, 2, 7), "sus2", 0.9),
}
FLAT_KEYS_MAJ = {5, 10, 3, 8, 1, 6}      # F Bb Eb Ab Db Gb
FLAT_KEYS_MIN = {2, 7, 0, 5, 10, 3}      # d g c f bb eb
ROMAN = ["I", "bII", "II", "bIII", "III", "IV", "#IV", "V", "bVI", "VI", "bVII", "VII"]


def key_scores(chroma_vec: np.ndarray) -> np.ndarray:
    """24 Pearson correlations: index 0-11 major (C..B), 12-23 minor."""
    v = chroma_vec / (chroma_vec.sum() + 1e-12)
    sc = []
    for prof in (KK_MAJOR, KK_MINOR):
        for k in range(12):
            sc.append(np.corrcoef(v, np.roll(prof, k))[0, 1])
    return np.nan_to_num(np.array(sc))


def key_name(idx: int, flats: bool | None = None) -> str:
    tonic, minor = idx % 12, idx >= 12
    if flats is None:
        flats = tonic in (FLAT_KEYS_MIN if minor else FLAT_KEYS_MAJ)
    names = NOTE_NAMES_FLAT if flats else NOTE_NAMES
    return f"{names[tonic]} {'minor' if minor else 'major'}"


def key_name_cn(idx: int) -> str:
    tonic, minor = idx % 12, idx >= 12
    names = NOTE_NAMES_FLAT if tonic in (FLAT_KEYS_MIN if minor else FLAT_KEYS_MAJ) else NOTE_NAMES
    return f"{names[tonic]} {'小调' if minor else '大调'}"


def build_templates():
    labels, mats, weights = [], [], []
    for root in range(12):
        for q, (iv, suf, w) in QUALITIES.items():
            t = np.zeros(12)
            for i in iv:
                t[(root + i) % 12] = 1.0
            t[root] += 0.25  # emphasise the root slightly
            mats.append(t / np.linalg.norm(t))
            labels.append((root, q))
            weights.append(w)
    return labels, np.array(mats), np.array(weights)


def roman(root: int, quality: str, tonic: int) -> str:
    deg = (root - tonic) % 12
    r = ROMAN[deg]
    acc = r[:1] if r[0] in "b#" else ""
    base = r[len(acc):]
    lower = quality in ("min", "min7", "dim", "hdim7")
    base = base.lower() if lower else base
    suf = {"maj": "", "min": "", "7": "7", "maj7": "maj7", "min7": "7", "dim": "°", "hdim7": "ø7",
           "aug": "+", "sus4": "sus4", "sus2": "sus2"}[quality]
    return acc + base + suf


def function_of(root: int, tonic: int, minor: bool) -> str:
    d = (root - tonic) % 12
    if minor:
        table = {0: "T", 3: "T", 8: "T", 2: "S", 5: "S", 7: "D", 10: "D", 11: "D"}
    else:
        table = {0: "T", 4: "T", 9: "T", 2: "S", 5: "S", 7: "D", 11: "D"}
    return table.get(d, "X")


def analyze(harm_y: np.ndarray, bass_y: np.ndarray | None, rms_frames: np.ndarray, beats: np.ndarray,
            bars: list, duration: float, store: Store) -> dict:
    chroma = librosa.feature.chroma_cqt(y=harm_y, sr=SR, hop_length=HOP, n_chroma=12, bins_per_octave=36)
    n = chroma.shape[1]
    rms = np.resize(rms_frames, n) if len(rms_frames) != n else rms_frames
    chroma_n = chroma / (chroma.max(axis=0, keepdims=True) + 1e-9)
    chroma_hm = store.heatmap("chroma", chroma_n, lo=0, hi=1, t0=0, t1=n / FPS, unit="", cmap="viridis",
                              axis={"kind": "pc", "ticks": [[i, NOTE_NAMES[i]] for i in range(12)], "values": NOTE_NAMES})

    # ---------- global key -----------------------------------------------------------------
    w = rms / (rms.max() + 1e-9)
    prof = (chroma * w[None, :]).sum(axis=1)
    scores = key_scores(prof)
    best = int(np.argmax(scores))
    # relative major/minor share the same pitch set: decide by tonic evidence in the bass and at the edges
    rel_of = lambda k: (k % 12 + 9) % 12 + 12 if k < 12 else (k % 12 + 3) % 12
    rk = rel_of(best)
    if scores[rk] >= scores[best] - 0.25:
        try:
            # tonic-triad evidence: how often is each candidate's tonic triad the best-matching triad per frame block
            tri = np.zeros((24, 12))
            for r in range(12):
                tri[r, [r, (r + 4) % 12, (r + 7) % 12]] = 1
                tri[12 + r, [r, (r + 3) % 12, (r + 7) % 12]] = 1
            blk = max(1, int(FPS * 0.5))
            cb = np.stack([chroma_n[:, i:i + blk].mean(1) for i in range(0, n, blk)], 1)
            wb = np.array([w[i:i + blk].mean() for i in range(0, n, blk)])
            win = np.argmax(tri @ cb, axis=0)
            tshare = np.array([(wb * (win == k)).sum() for k in range(24)]) / (wb.sum() + 1e-9)
            src = bass_y if bass_y is not None else harm_y
            bc = librosa.feature.chroma_cqt(y=src, sr=SR, hop_length=HOP * 4, fmin=librosa.note_to_hz("C1"),
                                            n_octaves=3, bins_per_octave=36)
            bp = bc.sum(axis=1); bp /= bp.max() + 1e-9
            e = max(1, n // 10)
            edge = chroma[:, :e].sum(1) + 1.5 * chroma[:, -e:].sum(1)
            edge /= edge.max() + 1e-9
            ev = lambda k: bp[k % 12] + edge[k % 12] + 4 * tshare[k] + 1.2 * (scores[k] - scores[best])
            if ev(rk) > ev(best) + 0.05:
                best = rk
        except Exception:  # noqa: BLE001
            pass
    srt = np.sort(scores)[::-1]
    conf = float((srt[0] - srt[1]) / (abs(srt[0]) + 1e-9))
    tonic, minor = best % 12, best >= 12
    flats = tonic in (FLAT_KEYS_MIN if minor else FLAT_KEYS_MAJ)
    names = NOTE_NAMES_FLAT if flats else NOTE_NAMES
    rel = (tonic + 9) % 12 + 12 if not minor else (tonic + 3) % 12

    # ---------- local key over bar windows ------------------------------------------------
    local = []
    if len(bars) >= 4:
        for i in range(len(bars)):
            a = bars[max(0, i - 4)][0]
            b = bars[min(len(bars) - 1, i + 3)][1]
            fa, fb = int(a * FPS), max(int(a * FPS) + 1, int(b * FPS))
            sc = key_scores((chroma[:, fa:fb] * w[None, fa:fb]).sum(axis=1))
            local.append(int(np.argmax(sc)))
        # smooth with a mode filter
        sm = []
        for i in range(len(local)):
            win = local[max(0, i - 2): i + 3]
            sm.append(Counter(win).most_common(1)[0][0])
        local = sm
    key_segments = []
    for i, k in enumerate(local):
        if key_segments and key_segments[-1]["key"] == k:
            key_segments[-1]["end"] = bars[i][1]
        else:
            key_segments.append({"key": k, "start": bars[i][0], "end": bars[i][1]})
    for s in key_segments:
        s["name"] = key_name(s["key"])
        s["name_cn"] = key_name_cn(s["key"])

    # ---------- chords (beat synchronous) ---------------------------------------------------
    labels, T, qw = build_templates()
    bf = librosa.time_to_frames(beats, sr=SR, hop_length=HOP)
    bf = np.unique(np.clip(bf, 0, n - 1))
    bounds = np.r_[0, bf, n]
    bounds = np.unique(bounds)
    seg_chroma = np.stack([chroma[:, a:b].mean(axis=1) if b > a else chroma[:, a] for a, b in zip(bounds[:-1], bounds[1:])], 1)
    seg_rms = np.array([rms[a:b].mean() if b > a else rms[a] for a, b in zip(bounds[:-1], bounds[1:])])
    seg_t = bounds / FPS
    seg_t[-1] = duration

    if bass_y is not None:
        bc = librosa.feature.chroma_cqt(y=bass_y, sr=SR, hop_length=HOP, fmin=librosa.note_to_hz("C1"),
                                        n_octaves=4, bins_per_octave=36)
        bc = bc[:, :n] if bc.shape[1] >= n else np.pad(bc, ((0, 0), (0, n - bc.shape[1])))
        bass_seg = np.stack([bc[:, a:b].mean(axis=1) if b > a else bc[:, a] for a, b in zip(bounds[:-1], bounds[1:])], 1)
        bass_e = np.array([np.sqrt(np.mean(bass_y[int(a * HOP): int(b * HOP)] ** 2)) if b > a else 0
                           for a, b in zip(bounds[:-1], bounds[1:])])
    else:
        bass_seg, bass_e = None, None

    cn = seg_chroma / (np.linalg.norm(seg_chroma, axis=0, keepdims=True) + 1e-9)
    S = (T @ cn) * qw[:, None]  # [templates, segs]
    if bass_seg is not None:
        bn = bass_seg / (bass_seg.max(axis=0, keepdims=True) + 1e-9)
        roots = np.array([r for r, _ in labels])
        S = S + 0.15 * bn[roots, :]
    silent = seg_rms < rms.max() * 0.02
    n_states = len(labels) + 1
    full = np.zeros((n_states, S.shape[1]))
    full[:-1] = S
    full[-1] = np.where(silent, 2.0, 0.3)
    beta = 18.0
    P = np.exp(beta * (full - full.max(axis=0, keepdims=True)))
    P /= P.sum(axis=0, keepdims=True)
    trans = librosa.sequence.transition_loop(n_states, 0.82)
    path = librosa.sequence.viterbi_discriminative(P, trans)

    def name_of(state: int, seg_idx: int) -> tuple[str, int | None, str | None]:
        if state == n_states - 1:
            return "N", None, None
        root, q = labels[state]
        nm = names[root] + QUALITIES[q][1]
        bass_note = None
        if bass_seg is not None and bass_e is not None and bass_e[seg_idx] > 0.01 * (bass_e.max() + 1e-9) * 5:
            bpc = int(np.argmax(bass_seg[:, seg_idx]))
            if bpc != root and (bpc - root) % 12 in QUALITIES[q][0]:
                bass_note = names[bpc]
        return nm, root, q if bass_note is None else q + "/" + bass_note

    chords = []
    for i, st in enumerate(path):
        nm, root, qb = name_of(int(st), i)
        q = None if qb is None else qb.split("/")[0]
        bass_note = qb.split("/")[1] if qb and "/" in qb else None
        label = nm + (f"/{bass_note}" if bass_note else "")
        conf_i = float(P[st, i])
        if chords and chords[-1]["label"] == label:
            chords[-1]["end"] = float(seg_t[i + 1])
            chords[-1]["_c"].append(conf_i)
            continue
        chords.append({"start": float(seg_t[i]), "end": float(seg_t[i + 1]), "label": label, "root": root,
                       "quality": q, "bass": bass_note, "_c": [conf_i]})
    # merge very short blips (< 0.6 beat) into neighbour
    med_beat = float(np.median(np.diff(beats))) if len(beats) > 1 else 0.5
    merged = []
    for c in chords:
        if merged and (c["end"] - c["start"]) < 0.6 * med_beat:
            merged[-1]["end"] = c["end"]
            continue
        merged.append(c)
    chords = merged
    for c in chords:
        c["confidence"] = rnd(float(np.mean(c.pop("_c"))), 2)
        c["start"], c["end"] = rnd(c["start"], 3), rnd(c["end"], 3)
        if c["root"] is not None:
            c["roman"] = roman(c["root"], c["quality"], tonic)
            c["function"] = function_of(c["root"], tonic, minor)
        else:
            c["roman"], c["function"] = "N.C.", "N"

    # ---------- statistics -------------------------------------------------------------------
    dur_by = Counter()
    for c in chords:
        if c["label"] != "N":
            dur_by[c["label"]] += c["end"] - c["start"]
    seq = [c["label"] for c in chords if c["label"] != "N"]
    trans_c = Counter(zip(seq[:-1], seq[1:]))
    ngrams = Counter()
    for L in (4, 3):
        for i in range(len(seq) - L + 1):
            g = tuple(seq[i:i + L])
            if len(set(g)) > 1:
                ngrams[g] += 1
    progs = [{"chords": list(g), "count": c} for g, c in ngrams.most_common(8) if c >= 2]
    roman_seq = [c["roman"] for c in chords if c["label"] != "N"]
    rgrams = Counter(tuple(roman_seq[i:i + 4]) for i in range(len(roman_seq) - 3))
    func_dur = Counter()
    for c in chords:
        func_dur[c["function"]] += c["end"] - c["start"]

    # lead-sheet: chords per bar
    lead = []
    for a, b in bars:
        inbar = []
        for c in chords:
            ov = min(b, c["end"]) - max(a, c["start"])
            if ov > 0.22 * (b - a) and c["label"] != "N":
                inbar.append(c["label"])
        if not inbar:
            inbar = ["N.C."]
        dedup = [x for i, x in enumerate(inbar) if i == 0 or x != inbar[i - 1]]
        lead.append(dedup)

    tonnetz = librosa.feature.tonnetz(chroma=chroma)
    tn = store.heatmap("tonnetz", tonnetz, lo=-0.4, hi=0.4, t0=0, t1=n / FPS, unit="", cmap="diverging",
                       axis={"kind": "bins", "ticks": [[i, l] for i, l in enumerate(["5度x", "5度y", "小3度x", "小3度y", "大3度x", "大3度y"])],
                             "values": ["Fifth x", "Fifth y", "Minor 3rd x", "Minor 3rd y", "Major 3rd x", "Major 3rd y"]})

    pc = prof / (prof.max() + 1e-12)
    return {
        "_chroma": chroma,
        "chroma": chroma_hm,
        "tonnetz": tn,
        "key": {"index": best, "name": key_name(best), "name_cn": key_name_cn(best), "tonic": tonic,
                "mode": "minor" if minor else "major", "confidence": rnd(conf, 3),
                "relative": key_name(rel), "relative_cn": key_name_cn(rel),
                "scores": rnd(scores, 4), "labels": [key_name(i) for i in range(24)], "use_flats": flats},
        "key_segments": key_segments,
        "modulations": max(0, len(key_segments) - 1),
        "pitch_class_profile": rnd(pc, 3),
        "key_profile_major": rnd(np.roll(KK_MAJOR, tonic) / KK_MAJOR.max(), 3),
        "key_profile_minor": rnd(np.roll(KK_MINOR, tonic) / KK_MINOR.max(), 3),
        "chords": chords,
        "chord_stats": {
            "unique": len(dur_by),
            "duration_by_chord": [[k, rnd(v, 2)] for k, v in dur_by.most_common(16)],
            "top_transitions": [[a, b, c] for (a, b), c in trans_c.most_common(14)],
            "progressions": progs,
            "roman_progressions": [{"chords": list(g), "count": c} for g, c in rgrams.most_common(6) if c >= 2],
            "function_share": {k: rnd(v / max(duration, 1e-9) * 100, 1) for k, v in func_dur.items()},
            "avg_chord_beats": rnd(float(np.mean([(c["end"] - c["start"]) / med_beat for c in chords if c["label"] != "N"]))
                                   if seq else None, 2),
        },
        "lead_sheet": lead,
    }
