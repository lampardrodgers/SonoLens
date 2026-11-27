"""Music-theory & production insight layer, computed from an existing analysis dict (no audio needed).

Adds ``A["insight"]``:
  tension     harmonic / energy / total tension curves (10 Hz, 0..1) + per-chord tension
  cadences    authentic / plagal / deceptive / half cadences
  phrases     4- or 8-bar phrases inside each section, with the cadence that closes them
  melody      vocal notes tagged as chord tone / tension (9, 11, 13) / non-chord tone + scale degree
  sections    every section compared with its previous occurrence (A vs A′): stems in/out, loudness, key …
  bars        per-bar arrangement density, drum density, tension, loudness
  groove      per-drum micro-timing against the 16th grid, hi-hat swing, feel
  masking     frequency masking between kick/bass and vocals/accompaniment (from stem mel spectrograms)
  sidechain   average ducking of bass + other after kick hits ("pumping")
  portrait    compact song fingerprint (also copied into meta.json for library thumbnails)

Everything here is a heuristic estimate; the UI labels it as such.  Run on existing results with
``python -m musicviz enrich [ids…]`` — the server also does it automatically at start-up.
"""
from __future__ import annotations

import difflib
import json
import traceback
from pathlib import Path

import numpy as np

from .common import NOTE_NAMES, NOTE_NAMES_FLAT, rnd, write_json

INSIGHT_VERSION = 3

QUAL_IV = {"maj": (0, 4, 7), "min": (0, 3, 7), "7": (0, 4, 7, 10), "maj7": (0, 4, 7, 11), "min7": (0, 3, 7, 10),
           "dim": (0, 3, 6), "hdim7": (0, 3, 6, 10), "aug": (0, 4, 8), "sus4": (0, 5, 7), "sus2": (0, 2, 7)}
QUAL_T = {"maj": 0.0, "min": 0.03, "7": 0.18, "maj7": 0.06, "min7": 0.06, "dim": 0.28, "hdim7": 0.24,
          "aug": 0.3, "sus4": 0.16, "sus2": 0.08}
REL_NAME = {0: "R", 1: "b9", 2: "9", 3: "b3", 4: "3", 5: "11", 6: "#11", 7: "5", 8: "b13", 9: "13", 10: "b7", 11: "7"}
DEG_NAME = ["1", "b2", "2", "b3", "3", "4", "#4", "5", "b6", "6", "b7", "7"]
STEM_CN = {"vocals": "人声", "drums": "鼓", "bass": "贝斯", "guitar": "吉他", "piano": "钢琴/键盘", "other": "其他"}
CAD_CN = {"PAC": "完全正格终止", "IAC": "不完全正格终止", "plagal": "变格终止", "deceptive": "阻碍终止", "half": "半终止"}
DT = 0.1  # tension curve resolution


# ------------------------------------------------------------------------------------------- utils
def _series_arr(s: dict | None, fill=np.nan):
    if not s or not s.get("v"):
        return None, None
    v = np.array([fill if x is None else x for x in s["v"]], float)
    t = s["t0"] + np.arange(len(v)) * s["dt"]
    return t, v


def _resample(t, v, grid):
    if t is None:
        return np.zeros(len(grid))
    ok = np.isfinite(v)
    if ok.sum() < 2:
        return np.zeros(len(grid))
    return np.interp(grid, t[ok], v[ok])


def _norm01(x, lo_p=5, hi_p=98):
    x = np.asarray(x, float)
    ok = np.isfinite(x)
    if not ok.any():
        return np.zeros_like(x)
    lo, hi = np.percentile(x[ok], lo_p), np.percentile(x[ok], hi_p)
    return np.clip((np.nan_to_num(x, nan=lo) - lo) / max(hi - lo, 1e-9), 0, 1)


def _smooth(x, n):
    if n <= 1 or len(x) < n:
        return x
    k = np.hanning(n + 2)[1:-1]
    k /= k.sum()
    return np.convolve(np.pad(x, (n, n), mode="edge"), k, mode="same")[n:-n]


def _fifths(semis: int) -> int:
    """Distance on the circle of fifths (0..6) between two pitch classes `semis` apart."""
    k = (semis * 7) % 12
    return min(k, 12 - k)


def _key_at(t: float, key_segs: list, glob: dict) -> tuple[int, bool]:
    for s in key_segs:
        if s["start"] - 1e-3 <= t < s["end"] + 1e-3:
            return s["key"] % 12, s["key"] >= 12
    return glob.get("tonic", 0), glob.get("mode") == "minor"


def _func(deg: int, minor: bool) -> str:
    table = ({0: "T", 3: "T", 8: "T", 2: "S", 5: "S", 7: "D", 10: "D", 11: "D"} if minor
             else {0: "T", 4: "T", 9: "T", 2: "S", 5: "S", 7: "D", 11: "D"})
    return table.get(deg, "X")


def _in(t, a, b):
    return a - 1e-3 <= t < b - 1e-3


# ------------------------------------------------------------------------------------------- tension
def chord_tension(c: dict, key_segs: list, glob: dict) -> tuple[float, dict]:
    if c.get("root") is None:
        return 0.08, {}
    mid = (c["start"] + c["end"]) / 2
    tonic, minor = _key_at(mid, key_segs, glob)
    deg = (c["root"] - tonic) % 12
    f = _func(deg, minor)
    base = {"T": 0.2, "S": 0.38, "D": 0.66, "X": 0.56}[f]
    if deg == 0 and f == "T":
        base = 0.04
    q = c.get("quality") or "maj"
    t = base + QUAL_T.get(q, 0.05) + 0.035 * _fifths(deg)
    if c.get("bass"):
        t += 0.07
    if minor and deg == 7 and q in ("maj", "7"):     # raised leading tone in minor -> stronger dominant
        t += 0.06
    g_ton = glob.get("tonic", tonic)
    if tonic != g_ton:                                 # away from the home key
        t += 0.025 * _fifths(tonic - g_ton)
    return float(np.clip(t, 0, 1)), {"deg": deg, "func": f, "tonic": tonic, "minor": minor,
                                     "roman": _roman(c["root"], q, tonic)}


def _roman(root: int, quality: str, tonic: int) -> str:
    from .harmony import roman
    try:
        return roman(root, quality, tonic)
    except Exception:  # noqa: BLE001
        return "?"


def _key_label(tonic: int, minor: bool, flats: bool) -> str:
    names = NOTE_NAMES_FLAT if flats else NOTE_NAMES
    return f"{names[tonic]} {'小调' if minor else '大调'}"


def tension_curves(A: dict, chords: list, ctx: list, dur: float) -> dict:
    grid = np.arange(0, dur, DT)
    harm = np.full(len(grid), 0.08)
    for c, x in zip(chords, ctx):
        harm[(grid >= c["start"]) & (grid < c["end"])] = x["tension"]
    harm = _smooth(harm, 5)
    L = A.get("loudness", {})
    st_t, st_v = _series_arr(L.get("short_term"))
    loud = _norm01(_resample(st_t, np.where(st_v > -70, st_v, np.nan) if st_v is not None else None, grid), 3, 99)
    on_t, on_v = _series_arr(A.get("rhythm", {}).get("onset_density"))
    dens = _norm01(_smooth(_resample(on_t, on_v, grid), 21), 5, 98)
    energy = _smooth(0.75 * loud + 0.25 * dens, 9)
    total = np.clip(0.55 * harm + 0.45 * energy, 0, 1)
    return {"t0": 0.0, "dt": DT, "harmonic": rnd(harm, 3), "energy": rnd(energy, 3), "total": rnd(total, 3),
            "_harm": harm, "_energy": energy, "_total": total, "_grid": grid}


# ------------------------------------------------------------------------------------------- cadences
def cadences(chords: list, ctx: list, bars: list, beats: list, mel_pc_at, flats: bool = False) -> list:
    if not chords:
        return []
    beat = float(np.median(np.diff(beats))) if len(beats) > 1 else 0.5
    bar_starts = np.array([b[0] for b in bars]) if bars else np.array([0.0])
    bar_len = float(np.median(np.diff(bar_starts))) if len(bar_starts) > 1 else 4 * beat

    def near_down(t):
        return float(np.min(np.abs(bar_starts - t))) < 0.18 * bar_len

    seq = [(c, x) for c, x in zip(chords, ctx) if c.get("root") is not None and c["end"] - c["start"] >= 0.9 * beat]
    out = []
    for (c1, x1), (c2, x2) in zip(seq[:-1], seq[1:]):
        if abs(c2["start"] - c1["end"]) > 2 * beat or x1["tonic"] != x2["tonic"]:
            continue
        d1, d2, minor = x1["deg"], x2["deg"], x2["minor"]
        typ = None
        q1 = c1.get("quality") or ""
        if d2 == 0 and (d1 == 7 or (d1 == 11 and q1 in ("dim", "hdim7"))):
            pc = mel_pc_at(c2["start"] + 0.15)
            strong = near_down(c2["start"]) and d1 == 7 and q1 not in ("min", "min7")
            typ = "PAC" if strong and (pc is None or pc == x2["tonic"]) else "IAC"
        elif d1 == 5 and d2 == 0:
            typ = "plagal"
        elif d1 == 7 and ((not minor and d2 == 9) or (minor and d2 == 8)):
            typ = "deceptive"
        if typ:
            s = {"PAC": 1.0, "IAC": 0.75, "plagal": 0.6, "deceptive": 0.7}[typ]
            s *= 1.0 if near_down(c2["start"]) else 0.6
            s *= 0.6 + 0.4 * min(1.0, (c2["end"] - c2["start"]) / bar_len)
            out.append({"t": rnd(c2["start"], 3), "type": typ, "name": CAD_CN[typ],
                        "from": x1.get("roman"), "to": x2.get("roman"), "chords": [c1["label"], c2["label"]],
                        "key": _key_label(x2["tonic"], minor, flats), "strength": rnd(s, 2)})
    # half cadences: a dominant held ≥ ~1 bar that is NOT resolved to I
    for i, (c, x) in enumerate(seq):
        if x["deg"] == 7 and c["end"] - c["start"] >= 0.85 * bar_len:
            nxt = seq[i + 1] if i + 1 < len(seq) else None
            if nxt is None or nxt[1]["deg"] != 0:
                out.append({"t": rnd(c["start"], 3), "type": "half", "name": CAD_CN["half"], "from": None,
                            "to": x.get("roman"), "chords": [c["label"]],
                            "key": _key_label(x["tonic"], x["minor"], flats), "strength": rnd(0.55, 2)})
    out.sort(key=lambda d: d["t"])
    # one cadence per bar (keep the strongest)
    res = []
    for d in out:
        if res and abs(res[-1]["t"] - d["t"]) < 0.9 * bar_len:
            if d["strength"] > res[-1]["strength"]:
                res[-1] = d
            continue
        res.append(d)
    return res


# ------------------------------------------------------------------------------------------- phrases
def phrases(segs: list, bars: list, cads: list) -> list:
    if not bars:
        return []
    starts = np.array([b[0] for b in bars])
    bar_len = float(np.median(np.diff(starts))) if len(starts) > 1 else 2.0
    L = 4 if bar_len >= 1.7 else 8
    out = []
    for si, s in enumerate(segs or [{"start": 0, "end": bars[-1][1]}]):
        idx = [i for i, b in enumerate(bars) if s["start"] - 0.05 <= b[0] < s["end"] - 0.05]
        if not idx:
            continue
        chunks = [idx[k:k + L] for k in range(0, len(idx), L)]
        if len(chunks) > 1 and len(chunks[-1]) < max(2, L // 2):
            tail = chunks.pop()
            chunks[-1] = chunks[-1] + tail
        for ch in chunks:
            a, b = bars[ch[0]][0], bars[ch[-1]][1]
            cad = None
            for c in cads:
                if b - 1.25 * bar_len <= c["t"] <= b + 0.6 * bar_len:
                    cad = c["type"]
            out.append({"start": rnd(a, 3), "end": rnd(b, 3), "bars": [ch[0], ch[-1]], "section": si,
                        "n_bars": len(ch), "cadence": cad})
    return out


# ------------------------------------------------------------------------------------------- melody
def melody_notes(A: dict, chords: list, ctx: list, beats: list) -> tuple[list, dict]:
    mel = A.get("melody", {}).get("vocals")
    if not mel or mel.get("weak") or not mel.get("midi"):
        return [], {}
    m = np.array([np.nan if v is None else v for v in mel["midi"]], float)
    dt = mel["dt"]
    # median-smooth to remove vibrato flicker before rounding
    sm = m.copy()
    for i in range(2, len(m) - 2):
        w = m[i - 2:i + 3]
        if np.isfinite(m[i]) and np.isfinite(w).sum() >= 3:
            sm[i] = np.nanmedian(w)
    r = np.where(np.isfinite(sm), np.round(sm), np.nan)
    notes, start, cur = [], None, None
    for i, v in enumerate(np.r_[r, np.nan]):
        val = None if not np.isfinite(v) else int(v)
        if val != cur:
            if cur is not None and (i - start) * dt >= 0.1:
                notes.append([start * dt, i * dt, cur])
            start, cur = i, val
    # merge same-pitch notes separated by tiny gaps
    merged = []
    for n in notes:
        if merged and merged[-1][2] == n[2] and n[0] - merged[-1][1] < 0.06:
            merged[-1][1] = n[1]
        else:
            merged.append(n)
    starts = np.array([c["start"] for c in chords]) if chords else np.array([])
    beats = np.asarray(beats, float)
    out, cnt = [], {"c": 0.0, "t": 0.0, "n": 0.0}
    for s, e, p in merged:
        mid = (s + e) / 2
        k = int(np.searchsorted(starts, mid, side="right") - 1) if len(starts) else -1
        tag, rel, deg = "n", "", ""
        if 0 <= k < len(chords) and chords[k].get("root") is not None and mid < chords[k]["end"]:
            c, x = chords[k], ctx[k]
            iv = (p - c["root"]) % 12
            tones = QUAL_IV.get(c.get("quality") or "maj", (0, 4, 7))
            rel = REL_NAME[iv]
            if iv in tones:
                tag = "c"
                if iv == 3 and 4 not in tones:
                    rel = "b3"
            elif iv in (1, 2, 5, 6, 8, 9) or (iv in (10, 11) and len(tones) == 3):
                strong = len(beats) and float(np.min(np.abs(beats - s))) < 0.08
                tag = "t" if (e - s >= 0.28 or strong) else "n"
            deg = DEG_NAME[(p - x["tonic"]) % 12]
        cnt[tag] += e - s
        out.append([rnd(s, 3), rnd(e, 3), int(p), tag, rel, deg])
    tot = sum(cnt.values()) or 1
    stats = {"chord_tone": rnd(cnt["c"] / tot * 100, 1), "tension": rnd(cnt["t"] / tot * 100, 1),
             "non_chord": rnd(cnt["n"] / tot * 100, 1), "n": len(out)}
    return out, stats


# ------------------------------------------------------------------------------------------- per bar
def bar_metrics(A: dict, bars: list, tc: dict) -> dict:
    items = A.get("stems", {}).get("items", [])
    nb = len(bars)
    active, mask = [0] * nb, [0] * nb
    order = [it["name"] for it in items]
    for j, it in enumerate(items):
        bd = np.array([-120 if v is None else v for v in it.get("bar_db", [])], float)
        if not len(bd):
            continue
        thr = max(bd.max() - 26, -52)
        for i in range(min(nb, len(bd))):
            if bd[i] > thr:
                active[i] += 1
                mask[i] |= 1 << j
    dd = A.get("drums", {}).get("density_per_bar", []) or []
    grid, total = tc["_grid"], tc["_total"]
    st_t, st_v = _series_arr(A.get("loudness", {}).get("short_term"))
    ten, lufs = [], []
    for a, b in bars:
        m = (grid >= a) & (grid < b)
        ten.append(float(total[m].mean()) if m.any() else None)
        if st_t is not None:
            mm = (st_t >= a) & (st_t < b) & np.isfinite(st_v) & (st_v > -70)
            lufs.append(float(st_v[mm].mean()) if mm.any() else None)
    return {"stems_order": order, "active": active, "mask": mask,
            "drum_density": [int(x) for x in dd[:nb]] + [0] * max(0, nb - len(dd)),
            "tension": rnd(ten, 3), "lufs": rnd(lufs, 1)}


# ------------------------------------------------------------------------------------------- sections
def section_diffs(A: dict, bars: list, tc: dict, chords: list, ctx: list, barm: dict) -> list:
    segs = A.get("structure", {}).get("segments", [])
    if not segs:
        return []
    st_t, st_v = _series_arr(A.get("loudness", {}).get("short_term"))
    mel = A.get("melody", {}).get("vocals") or {}
    mel_t, mel_v = None, None
    if mel.get("midi") and not mel.get("weak"):
        mel_v = np.array([np.nan if v is None else v for v in mel["midi"]], float)
        mel_t = mel.get("t0", 0) + np.arange(len(mel_v)) * mel["dt"]
    key_segs = A.get("harmony", {}).get("key_segments", [])
    names = NOTE_NAMES_FLAT if A.get("harmony", {}).get("key", {}).get("use_flats") else NOTE_NAMES
    w_t, w_v = _series_arr(A.get("stereo", {}).get("width_series"))

    def feat(s):
        a, b = s["start"], s["end"]
        bi = [i for i, x in enumerate(bars) if a - 0.05 <= x[0] < b - 0.05]
        f = {"n_bars": len(bi), "stems": set(s.get("active_stems") or [])}
        if st_t is not None:
            m = (st_t >= a) & (st_t < b) & np.isfinite(st_v) & (st_v > -70)
            f["lufs"] = float(st_v[m].mean()) if m.any() else None
        else:
            f["lufs"] = None
        dd = [barm["drum_density"][i] for i in bi if i < len(barm["drum_density"])]
        f["drum"] = float(np.mean(dd)) if dd else None
        act = [barm["active"][i] for i in bi if i < len(barm["active"])]
        f["density"] = float(np.mean(act)) if act else None
        m = (tc["_grid"] >= a) & (tc["_grid"] < b)
        f["tension"] = float(tc["_total"][m].mean()) if m.any() else None
        f["tension_peak"] = float(tc["_total"][m].max()) if m.any() else None
        if mel_t is not None:
            mm = (mel_t >= a) & (mel_t < b) & np.isfinite(mel_v)
            f["vocal"] = float(np.median(mel_v[mm])) if mm.sum() > 20 else None
        else:
            f["vocal"] = None
        if w_t is not None:
            mm = (w_t >= a) & (w_t < b) & np.isfinite(w_v)
            f["width"] = float(w_v[mm].mean()) if mm.any() else None
        else:
            f["width"] = None
        ov = {}
        for k in key_segs:
            o = min(b, k["end"]) - max(a, k["start"])
            if o > 0:
                ov[k["key"]] = ov.get(k["key"], 0) + o
        f["key"] = max(ov, key=ov.get) if ov else None
        f["romans"] = [c.get("roman") for c in chords if c.get("root") is not None and a - 0.05 <= c["start"] < b - 0.05]
        return f

    feats = [feat(s) for s in segs]
    out, seen = [], {}
    for i, (s, f) in enumerate(zip(segs, feats)):
        lab = s["label"]
        occ = seen.get(lab, 0) + 1
        prev_i = next((j for j in range(i - 1, -1, -1) if segs[j]["label"] == lab), None)
        seen[lab] = occ
        item = {"idx": i, "label": lab, "prime": lab + "′" * (occ - 1), "occurrence": occ,
                "hint": s.get("hint"), "start": s["start"], "end": s["end"], "n_bars": f["n_bars"],
                "lufs": rnd(f["lufs"], 1), "density": rnd(f["density"], 2), "drum_density": rnd(f["drum"], 1),
                "tension": rnd(f["tension"], 3), "tension_peak": rnd(f["tension_peak"], 3),
                "vocal_median": rnd(f["vocal"], 1), "width": rnd(f["width"], 3),
                "key": f["key"], "diff": None, "text": []}
        if prev_i is not None:
            p = feats[prev_i]
            d = {"vs": prev_i, "vs_prime": out[prev_i]["prime"]}
            txt = []
            add, rem = sorted(f["stems"] - p["stems"]), sorted(p["stems"] - f["stems"])
            d["added"], d["removed"] = add, rem
            if add:
                txt.append("新加入 " + "、".join(STEM_CN.get(x, x) for x in add))
            if rem:
                txt.append("去掉了 " + "、".join(STEM_CN.get(x, x) for x in rem))
            if f["lufs"] is not None and p["lufs"] is not None:
                d["lufs_delta"] = rnd(f["lufs"] - p["lufs"], 1)
                if abs(f["lufs"] - p["lufs"]) >= 1.0:
                    txt.append(f"整体{'更响' if f['lufs'] > p['lufs'] else '更轻'} {f['lufs'] - p['lufs']:+.1f} LU")
            if f["drum"] is not None and p["drum"] is not None:
                d["drum_delta"] = rnd(f["drum"] - p["drum"], 1)
                if abs(f["drum"] - p["drum"]) >= 1.5:
                    txt.append(f"鼓{'更密' if f['drum'] > p['drum'] else '更稀'}（每小节 {f['drum'] - p['drum']:+.0f} 击）")
            if f["vocal"] is not None and p["vocal"] is not None:
                d["vocal_delta"] = rnd(f["vocal"] - p["vocal"], 1)
                if abs(f["vocal"] - p["vocal"]) >= 1.5:
                    txt.append(f"人声{'升高' if f['vocal'] > p['vocal'] else '降低'}约 {abs(f['vocal'] - p['vocal']):.0f} 个半音")
            if f["key"] is not None and p["key"] is not None and f["key"] != p["key"]:
                sh = ((f["key"] % 12) - (p["key"] % 12) + 6) % 12 - 6
                kn = lambda k: f"{names[k % 12]}{'m' if k >= 12 else ''}"
                d["key_shift"] = sh
                txt.append(f"调性 {kn(p['key'])} → {kn(f['key'])}" + (f"（{sh:+d} 半音）" if sh and (f['key'] >= 12) == (p['key'] >= 12) else ""))
            if f["romans"] and p["romans"]:
                sim = difflib.SequenceMatcher(None, p["romans"], f["romans"]).ratio()
                d["harmony_sim"] = rnd(sim, 2)
                txt.append("和声进行与上次相同" if sim >= 0.8 else "和声进行有变化" if sim >= 0.45 else "和声进行明显不同")
            if f["width"] is not None and p["width"] is not None and abs(f["width"] - p["width"]) >= 0.08:
                txt.append(f"声场{'更宽' if f['width'] > p['width'] else '更窄'}")
            if f["n_bars"] != p["n_bars"]:
                txt.append(f"长度 {p['n_bars']} → {f['n_bars']} 小节")
            if not txt:
                txt.append("与上次几乎相同")
            item["diff"], item["text"] = d, txt
        out.append(item)
    return out


# ------------------------------------------------------------------------------------------- groove
def groove(A: dict) -> dict:
    R, Dr = A.get("rhythm", {}), A.get("drums", {})
    beats = np.asarray(R.get("beats") or [], float)
    if len(beats) < 8 or not Dr.get("hits"):
        return {}
    grid, step = [], []
    for i in range(len(beats) - 1):
        for s in range(4):
            grid.append(beats[i] + (beats[i + 1] - beats[i]) * s / 4)
            step.append(s)
    grid, step = np.array(grid), np.array(step)
    st_len = float(np.median(np.diff(beats))) / 4
    per = {}
    for hgrp in Dr["hits"]:
        t = np.asarray(hgrp["t"], float)
        if len(t) < 16:
            continue
        j = np.clip(np.searchsorted(grid, t), 1, len(grid) - 1)
        j = np.where(np.abs(grid[j - 1] - t) < np.abs(grid[j] - t), j - 1, j)
        off = (t - grid[j]) * 1000
        ok = np.abs(off) < st_len * 1000 * 0.4
        if ok.sum() < 8:
            continue
        o = off[ok]
        per[hgrp["name"]] = {"label": hgrp.get("label"), "offset_ms": rnd(float(np.median(o)), 1),
                             "std_ms": rnd(float(np.std(o)), 1), "n": int(ok.sum()),
                             "hist": np.histogram(o, bins=15, range=(-st_len * 400, st_len * 400))[0].astype(int).tolist()}
    swing = None
    hh = next((x for x in Dr["hits"] if x["name"] == "hihat"), None)
    if hh and len(hh["t"]) > 30:
        t = np.asarray(hh["t"], float)
        k = np.clip(np.searchsorted(beats, t) - 1, 0, len(beats) - 2)
        ph = (t - beats[k]) / (beats[k + 1] - beats[k])
        mid = ph[(ph > 0.38) & (ph < 0.8)]
        if len(mid) > 12:
            p = float(np.median(mid))
            swing = p / (1 - p)
    ref = per.get("kick", {}).get("offset_ms")
    sn = per.get("snare", {}).get("offset_ms")
    feel, feel_cn = "on", "贴拍"
    if ref is not None and sn is not None:
        rel = sn - ref
        if rel > 7:
            feel, feel_cn = "laid_back", "军鼓靠后（laid-back，松弛）"
        elif rel < -7:
            feel, feel_cn = "pushed", "军鼓抢拍（pushed，紧迫）"
        else:
            feel_cn = "军鼓与底鼓贴拍"
    tight = np.mean([v["std_ms"] for v in per.values()]) if per else None
    return {"per_instrument": per, "hihat_swing": rnd(swing, 2), "feel": feel, "feel_cn": feel_cn,
            "tightness_ms": rnd(tight, 1), "step_ms": rnd(st_len * 1000, 1)}


# ------------------------------------------------------------------------------------------- masking / sidechain
def _mel_db(out_dir: Path, it: dict):
    hm = it.get("mel")
    if not hm:
        return None
    p = out_dir / hm["file"]
    if not p.exists():
        return None
    u = np.fromfile(p, dtype=np.uint8).reshape(hm["rows"], hm["cols"]).astype(np.float32)
    return hm["lo"] + u / 255 * (hm["hi"] - hm["lo"]), hm


def masking(A: dict, out_dir: Path, bars: list) -> tuple[list, dict]:
    items = {it["name"]: it for it in A.get("stems", {}).get("items", [])}
    if not items:
        return [], {}
    mels = {}
    for k, it in items.items():
        r = _mel_db(out_dir, it)
        if r is not None:
            mels[k] = r
    if not mels:
        return [], {}
    any_hm = next(iter(mels.values()))[1]
    freqs = np.array(any_hm["axis"]["values"], float)
    cols = any_hm["cols"]
    tcol = any_hm["t0"] + (np.arange(cols) + 0.5) * (any_hm["t1"] - any_hm["t0"]) / cols
    lin = {k: 10 ** (v[0] / 10) for k, v in mels.items()}
    pairs_def = [("drums", ["bass"], "底鼓 vs 贝斯", 30, 180), ("vocals", ["guitar", "piano", "other"], "人声 vs 伴奏", 300, 4000),
                 ("bass", ["guitar", "piano", "other"], "贝斯 vs 中低频乐器", 80, 300)]
    pairs = []
    for a, bs, name, lo, hi in pairs_def:
        bs = [b for b in bs if b in lin]
        if a not in lin or not bs:
            continue
        band = (freqs >= lo) & (freqs <= hi)
        if band.sum() < 2:
            continue
        Ea = lin[a][band]
        Eb = sum(lin[b][band] for b in bs)
        floor = 10 ** (-62 / 10)
        both = (Ea.sum(0) > floor * band.sum()) & (Eb.sum(0) > floor * band.sum())
        ov = np.minimum(Ea, Eb).sum(0) / (np.maximum(Ea, Eb).sum(0) + 1e-12)
        ov = np.where(both, ov, 0.0)
        per_bar = []
        for x0, x1 in bars:
            m = (tcol >= x0) & (tcol < x1)
            per_bar.append(float(ov[m].mean()) if m.any() else 0.0)
        pb = np.array(per_bar)
        worst = [int(i) for i in np.argsort(-pb)[:3] if pb[i] > 0.25] if len(pb) else []
        mean = float(ov[both].mean()) if both.any() else 0.0
        pairs.append({"a": a, "b": bs, "name": name, "band": f"{lo}–{hi} Hz", "mean": rnd(mean, 3),
                      "level": "高" if mean > 0.45 else "中" if mean > 0.28 else "低",
                      "per_bar": rnd(pb, 3), "worst_bars": worst})
    # sidechain-like pumping: bass+other dip right after kicks
    sc = {}
    kicks = next((x for x in A.get("drums", {}).get("hits", []) if x["name"] == "kick"), None)
    srcs = [k for k in ("bass", "other", "piano", "guitar") if k in lin]
    if kicks and srcs and len(kicks["t"]) > 20:
        fps = cols / (any_hm["t1"] - any_hm["t0"])
        band = (freqs >= 60) & (freqs <= 3000)
        env = 10 * np.log10(sum(lin[k][band].sum(0) for k in srcs) + 1e-12)
        kt = np.asarray(kicks["t"], float)
        kt = kt[np.r_[True, np.diff(kt) > 0.22]]
        pre, post = 3, 9
        segs = []
        for t in kt:
            c = int(t * fps)
            if c - pre < 0 or c + post >= cols:
                continue
            w = env[c - pre:c + post + 1]
            if np.isfinite(w).all() and w[:pre].mean() > -55:
                segs.append(w - w[:pre].mean())
        if len(segs) > 15:
            curve = np.median(np.array(segs), axis=0)
            depth = float(-curve[pre:pre + 6].min())
            rec = curve[-3:].mean() - curve[pre:pre + 6].min()
            sc = {"depth_db": rnd(depth, 1), "detected": bool(depth > 1.8 and rec > 1.0),
                  "curve": rnd(curve, 2), "dt": rnd(1 / fps, 4), "pre": pre, "sources": srcs, "n": len(segs)}
    return pairs, sc


# ------------------------------------------------------------------------------------------- portrait
def portrait(A: dict, tc: dict, chords: list, ctx: list, cads: list, n: int = 180) -> dict:
    dur = float(A["meta"]["duration"])
    grid = (np.arange(n) + 0.5) / n * dur
    g, tot, en = tc["_grid"], tc["_total"], tc["_energy"]
    stems = {}
    items = A.get("stems", {}).get("items", [])
    mx = max([max([v for v in it["energy"]["v"] if v is not None] or [-80]) for it in items] or [-80])
    for it in items:
        t, v = _series_arr(it["energy"], -80)
        x = _resample(t, v, grid)
        stems[it["name"]] = rnd(np.clip((x - (mx - 42)) / 42, 0, 1), 2)
    hue, func = [], []
    starts = np.array([c["start"] for c in chords]) if chords else np.array([])
    for t in grid:
        k = int(np.searchsorted(starts, t, side="right") - 1) if len(starts) else -1
        if 0 <= k < len(chords) and chords[k].get("root") is not None:
            hue.append(int((chords[k]["root"] * 7) % 12))
            func.append(ctx[k]["func"])
        else:
            hue.append(-1)
            func.append("N")
    segs = A.get("structure", {}).get("segments", [])
    H = A.get("harmony", {}).get("key", {})
    return {"n": n, "duration": rnd(dur, 2), "energy": rnd(np.interp(grid, g, en), 2), "tension": rnd(np.interp(grid, g, tot), 2),
            "stems": stems, "hue": hue, "func": "".join(func),
            "sections": [[rnd(s["start"] / dur, 4), rnd(s["end"] / dur, 4), s["label"]] for s in segs],
            "cadences": [[rnd(c["t"] / dur, 4), c["type"]] for c in cads],
            "key": H.get("name"), "tonic": H.get("tonic"), "mode": H.get("mode"),
            "bpm": A.get("rhythm", {}).get("bpm"), "lufs": A.get("loudness", {}).get("integrated_lufs")}


# ------------------------------------------------------------------------------------------- main
def analyze(A: dict, out_dir: Path) -> dict:
    out_dir = Path(out_dir)
    dur = float(A["meta"]["duration"])
    H = A.get("harmony", {}) or {}
    glob = H.get("key", {}) or {}
    key_segs = H.get("key_segments", []) or []
    chords = H.get("chords", []) or []
    R = A.get("rhythm", {}) or {}
    bars = R.get("bars") or []
    beats = R.get("beats") or []
    errs = {}
    res: dict = {"version": INSIGHT_VERSION, "note": "启发式估计，非音乐学定论"}

    ctx = []
    for c in chords:
        t, x = chord_tension(c, key_segs, glob)
        x["tension"] = t
        ctx.append(x if x else {"tension": t, "deg": None, "func": "N", "tonic": glob.get("tonic", 0), "minor": False})
        c["tension"] = rnd(t, 3)
        if x.get("roman"):
            c["roman_local"] = x["roman"]
            c["func_local"] = x["func"]
    res["chord_tension"] = [rnd(x["tension"], 3) for x in ctx]

    tc = tension_curves(A, chords, ctx, dur)
    res["tension"] = {k: v for k, v in tc.items() if not k.startswith("_")}

    mel = A.get("melody", {}).get("vocals") or {}
    mel_arr = None
    if mel.get("midi") and not mel.get("weak"):
        mel_arr = np.array([np.nan if v is None else v for v in mel["midi"]], float)

    def mel_pc_at(t):
        if mel_arr is None:
            return None
        i = int(t / mel["dt"])
        w = mel_arr[max(0, i - 3): i + 8]
        w = w[np.isfinite(w)]
        return int(round(np.median(w))) % 12 if len(w) else None

    def guard(key, fn, default):
        try:
            return fn()
        except Exception:  # noqa: BLE001
            errs[key] = traceback.format_exc()
            print(f"[insight] {key} failed:\n{errs[key]}")
            return default

    cads = guard("cadences", lambda: cadences(chords, ctx, bars, beats, mel_pc_at, bool(glob.get("use_flats"))), [])
    res["cadences"] = cads
    res["phrases"] = guard("phrases", lambda: phrases(A.get("structure", {}).get("segments", []), bars, cads), [])
    notes, mstats = guard("melody", lambda: melody_notes(A, chords, ctx, beats), ([], {}))
    res["melody_notes"], res["melody_stats"] = notes, mstats
    barm = guard("bars", lambda: bar_metrics(A, bars, tc), {"active": [], "mask": [], "drum_density": [], "tension": [], "lufs": [], "stems_order": []})
    res["bars"] = barm
    res["sections"] = guard("sections", lambda: section_diffs(A, bars, tc, chords, ctx, barm), [])
    res["groove"] = guard("groove", lambda: groove(A), {})
    pairs, sc = guard("masking", lambda: masking(A, out_dir, bars), ([], {}))
    res["masking"], res["sidechain"] = pairs, sc
    res["portrait"] = guard("portrait", lambda: portrait(A, tc, chords, ctx, cads), {})
    res["errors"] = list(errs.keys())
    return res


def enrich(rid_dir: Path, force: bool = False) -> bool:
    """Add/refresh A['insight'] for one results folder. Returns True when it wrote something."""
    p = Path(rid_dir) / "analysis.json"
    if not p.exists():
        return False
    A = json.loads(p.read_text(encoding="utf-8"))
    acc = _backfill_accents(A, Path(rid_dir))
    if not force and A.get("insight", {}).get("version") == INSIGHT_VERSION:
        if acc:
            _atomic_json(p, A)
        return acc
    A["insight"] = analyze(A, Path(rid_dir))
    _atomic_json(p, A)
    mp = Path(rid_dir) / "meta.json"
    if mp.exists():
        meta = json.loads(mp.read_text(encoding="utf-8"))
        meta["portrait"] = A["insight"].get("portrait")
        _atomic_json(mp, meta)
    return True


def _backfill_accents(A: dict, rid_dir: Path) -> bool:
    """Older results have no drums.accents (loudness-true hit list used by the 流光 scene): compute it from the drum stem."""
    d = A.get("drums")
    if not d or "accents" in d:
        return False
    src = next(iter(sorted((rid_dir / "audio" / "stems").glob("drums.*"))), None)
    if src is None:
        return False
    try:
        import librosa
        from .common import SR
        from .drums import accents
        y, _ = librosa.load(str(src), sr=SR, mono=True)
        d["accents"] = accents(y)
        return True
    except Exception:
        return False


def _atomic_json(path: Path, obj) -> None:
    tmp = path.with_suffix(".json.tmp")
    write_json(tmp, obj)
    tmp.replace(path)
