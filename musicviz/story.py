"""Story engine: turns the raw analysis into a chaptered, narrated 'cinema' timeline.

Output (A["story"]):
  chapters[]: {idx, roman, start, end, name, subtitle, role, tone, scenes[{type,start,end}], facts[], m{metrics}}
  key_trail:  sliding-window key centre on the circle of fifths (x, y in [-1, 1])
  layers:     harmonic vs percussive energy (0..1 of song peak), 10 Hz
  global:     song-wide headline numbers for the finale card
"""
from __future__ import annotations

import librosa
import numpy as np

from .common import FPS, HOP, NOTE_NAMES, NOTE_NAMES_FLAT, SR, SR_HI, rnd
from .harmony import key_name_cn, key_scores

ROMANS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"]
BANDS5 = [("低频", 20, 150), ("中低", 150, 500), ("中频", 500, 2000), ("中高", 2000, 6000), ("高频", 6000, 20000)]
FIFTHS = [(i * 7) % 12 for i in range(12)]  # C G D A E B F# C# G# D# A# F


def mm(t: float) -> str:
    t = max(0.0, t)
    return f"{int(t // 60)}:{int(t % 60):02d}"


def note(m: float, flats=False) -> str:
    m = int(round(m))
    names = NOTE_NAMES_FLAT if flats else NOTE_NAMES
    return f"{names[m % 12]}{m // 12 - 1}"


def _series_arr(s):
    if not s:
        return np.zeros(0), np.zeros(0)
    v = np.array([np.nan if x is None else x for x in s["v"]], float)
    if "t" in s:
        t = np.array(s["t"], float)
    else:
        t = s["t0"] + np.arange(len(v)) * s["dt"]
    return t, v


def _mean_in(t, v, a, b, default=np.nan):
    m = (t >= a) & (t < b) & np.isfinite(v)
    return float(np.mean(v[m])) if m.any() else default


def _frames(a, b, n):
    return slice(int(max(0, a * FPS)), int(min(n, max(a * FPS + 1, b * FPS))))


def _cos(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))


# ------------------------------------------------------------------------------------------------
def _chapters_from_segments(segs, dur, st_t, st_v):
    """Merge structural segments into a readable number of chapters, then cut out dramatic breaks."""
    if not segs:
        n = max(1, int(round(dur / 30)))
        edges = np.linspace(0, dur, n + 1)
        segs = [{"start": float(a), "end": float(b), "label": "A"} for a, b in zip(edges[:-1], edges[1:])]
    ch = [{"start": float(s["start"]), "end": float(s["end"]), "labels": [s.get("label", "A")],
           "hint": s.get("hint")} for s in segs]
    ch[0]["start"] = 0.0
    ch[-1]["end"] = float(dur)
    target = int(np.clip(round(dur / 32), 3, 8))
    min_len = max(6.0, dur / 18)
    loud = lambda c: _mean_in(st_t, st_v, c["start"], c["end"], -40)
    while len(ch) > 1:
        lens = np.array([c["end"] - c["start"] for c in ch])
        i = int(np.argmin(lens))
        if len(ch) <= target and lens[i] >= min_len:
            break
        # merge with the neighbour whose loudness is closer
        if i == 0:
            j = 1
        elif i == len(ch) - 1:
            j = i - 1
        else:
            j = i - 1 if abs(loud(ch[i - 1]) - loud(ch[i])) <= abs(loud(ch[i + 1]) - loud(ch[i])) else i + 1
        a, b = sorted((i, j))
        ch[a] = {"start": ch[a]["start"], "end": ch[b]["end"], "labels": ch[a]["labels"] + ch[b]["labels"],
                 "hint": ch[a]["hint"] or ch[b]["hint"]}
        del ch[b]

    # split overly long chapters at their strongest loudness change so the story keeps moving
    vv = np.where(np.isfinite(st_v), st_v, -60.0)
    dt = float(st_t[1] - st_t[0]) if len(st_t) > 1 else 0.1
    hw = max(1, int(8 / dt))
    for _ in range(12):
        if len(ch) >= target:
            break
        lens = [c["end"] - c["start"] for c in ch]
        i = int(np.argmax(lens))
        if lens[i] < max(2 * min_len, 1.4 * dur / target):
            break
        c = ch[i]
        best, bt = -1.0, None
        for k in range(len(st_t)):
            tt = st_t[k]
            if tt < c["start"] + min_len or tt > c["end"] - min_len:
                continue
            l = vv[max(0, k - hw):k]
            r = vv[k:k + hw]
            if len(l) < 3 or len(r) < 3:
                continue
            d = abs(float(np.mean(r) - np.mean(l)))
            if d > best:
                best, bt = d, float(tt)
        if bt is None:
            break
        lab = c["labels"][-1] if c["labels"] else "A"
        ch[i:i + 1] = [{**c, "end": bt}, {"start": bt, "end": c["end"], "labels": [lab + "'"], "hint": None}]

    # dramatic break: short region far below its surroundings → its own chapter
    brk = _find_break(st_t, st_v, dur)
    if brk:
        a, b = brk
        out = []
        for c in ch:
            if c["end"] <= a or c["start"] >= b:
                out.append(c)
                continue
            if a - c["start"] > 3:
                out.append({**c, "end": a})
            out.append({"start": a, "end": b, "labels": ["~"], "hint": None, "break": True})
            if c["end"] - b > 3:
                out.append({**c, "start": b})
        # absorb tiny leftovers
        ch = [c for c in out if c["end"] - c["start"] > 1.0]
        for i in range(1, len(ch)):
            ch[i]["start"] = ch[i - 1]["end"]
        ch[0]["start"] = 0.0
        ch[-1]["end"] = float(dur)
    return ch


def _find_break(t, v, dur):
    if len(v) < 50 or dur < 60:
        return None
    vv = np.where(np.isfinite(v), v, -70)
    best = None
    w = int(20 / max(1e-3, (t[1] - t[0])))
    n = len(vv)
    ref = np.array([np.median(vv[max(0, i - w): min(n, i + w)]) for i in range(n)])
    low = vv < ref - 6.5
    i = 0
    while i < n:
        if low[i]:
            j = i
            while j < n and low[j]:
                j += 1
            a, b = t[i], t[min(j, n - 1)]
            depth = float(np.mean(ref[i:j] - vv[i:j]))
            if 1.5 <= b - a <= 15 and a > dur * 0.08 and b < dur * 0.92:
                if best is None or depth > best[2]:
                    best = (float(a), float(b), depth)
            i = j
        else:
            i += 1
    if not best:
        return None
    a, b, _ = best
    return (max(0.0, a - 0.6), min(dur, b + 0.6))


# ------------------------------------------------------------------------------------------------
def analyze(audio, A: dict, sp_cache: dict, chroma: np.ndarray | None, mono22: dict, bars) -> dict:
    dur = float(audio.duration)
    L, Sp, R, H = A.get("loudness", {}), A.get("spectral", {}), A.get("rhythm", {}), A.get("harmony", {})
    st_t, st_v = _series_arr(L.get("short_term"))
    segs = A.get("structure", {}).get("segments", [])
    key = H.get("key", {})
    tonic, minor = key.get("tonic", 0), key.get("mode") == "minor"
    flats = bool(key.get("use_flats"))
    n_frames = sp_cache.get("n_frames", 0)
    mag = sp_cache.get("mag")
    freqs = librosa.fft_frequencies(sr=SR, n_fft=2048)
    cqt = sp_cache.get("cqt_db")
    cent = sp_cache.get("cent")
    rms = sp_cache.get("rms")
    if chroma is None and mag is not None:
        chroma = librosa.feature.chroma_stft(S=mag ** 2, sr=SR)

    # ---------- layers: harmonic vs percussive energy -----------------------------------------
    rate = 10
    nl = int(dur * rate)
    def env(y, sr):
        hop = sr // rate
        n = len(y) // hop
        e = np.sqrt((y[: n * hop].reshape(n, hop) ** 2).mean(1))
        return np.pad(e, (0, max(0, nl - n)))[:nl]
    if mono22 and "drums" in mono22:
        perc = env(mono22["drums"], SR)
        harm = env(sum(v for k, v in mono22.items() if k != "drums"), SR)
    elif "H" in sp_cache:
        hE = np.sqrt((sp_cache["H"] ** 2).sum(0)); pE = np.sqrt((sp_cache["P"] ** 2).sum(0))
        tt = np.arange(nl) / rate
        fi = np.clip((tt * FPS).astype(int), 0, len(hE) - 1)
        harm, perc = hE[fi], pE[fi]
    else:
        harm = perc = np.zeros(nl)
    from scipy.ndimage import uniform_filter1d
    harm_s = uniform_filter1d(harm, 5); perc_s = uniform_filter1d(perc, 5)
    hn = harm_s / (np.percentile(harm_s, 99.5) + 1e-9); pn = perc_s / (np.percentile(perc_s, 99.5) + 1e-9)
    layers = {"t0": 0, "dt": 1 / rate, "harm": rnd(np.clip(hn, 0, 1), 3), "perc": rnd(np.clip(pn, 0, 1), 3)}
    lt = np.arange(nl) / rate

    # ---------- key-centre trail on the circle of fifths ----------------------------------------
    trail = {"t": [], "x": [], "y": [], "key": []}
    if chroma is not None and chroma.shape[1] > 10:
        win, hop_s = 8.0, 1.0
        nC = chroma.shape[1]
        for c in np.arange(0, dur, hop_s):
            sl = _frames(c - win / 2, c + win / 2, nC)
            v = chroma[:, sl].mean(1)
            if v.sum() < 1e-6:
                continue
            sc = key_scores(v)
            w = np.exp((sc - sc.max()) * 10); w /= w.sum()
            x = y = 0.0
            for k in range(24):
                maj = k % 12 if k < 12 else (k % 12 + 3) % 12
                pos = FIFTHS.index(maj)
                r = 1.0 if k < 12 else 0.64
                th = pos / 12 * 2 * np.pi
                x += w[k] * r * np.sin(th); y += w[k] * -r * np.cos(th)
            trail["t"].append(round(float(c), 2)); trail["x"].append(round(x, 4)); trail["y"].append(round(y, 4))
            trail["key"].append(int(np.argmax(sc)))

    # ---------- chapters -------------------------------------------------------------------------
    raw = _chapters_from_segments(segs, dur, st_t, st_v)
    onsets = np.array(R.get("onsets", []), float)
    beats = np.array(R.get("beats", []), float)
    chords = H.get("chords", [])
    stems_items = A.get("stems", {}).get("items", [])
    stereo_L, stereo_R = audio.st[0], audio.st[1]

    def metrics(a, b):
        m = {}
        m["lufs"] = rnd(_mean_in(st_t, st_v, a, b, -60), 1)
        sel = (st_t >= a) & (st_t < b) & np.isfinite(st_v)
        if sel.any():
            k = int(np.argmax(np.where(sel, st_v, -999)))
            m["lufs_peak"], m["lufs_peak_t"] = rnd(float(st_v[k]), 1), rnd(float(st_t[k]), 1)
            first = st_v[sel][: max(1, sel.sum() // 6)]
            last = st_v[sel][-max(1, sel.sum() // 6):]
            m["lufs_start"], m["lufs_end"] = rnd(float(np.mean(first)), 1), rnd(float(np.mean(last)), 1)
        if mag is not None:
            fs = _frames(a, b, mag.shape[1])
            pw = (mag[:, fs] ** 2).sum(1)
            tot = pw.sum() + 1e-20
            m["bands"] = [rnd(float(pw[(freqs >= lo) & (freqs < hi)].sum() / tot * 100), 1) for _, lo, hi in BANDS5]
            m["low150"] = rnd(float(pw[freqs < 150].sum() / tot * 100), 0)
        if cent is not None and rms is not None:
            fs = _frames(a, b, len(cent))
            w = rms[fs] ** 2
            m["centroid"] = rnd(float((cent[fs] * w).sum() / (w.sum() + 1e-12)), 0)
            # centroid in the final seconds (for "drops to" facts)
            fe = _frames(max(a, b - 4), b, len(cent))
            m["centroid_end"] = rnd(float(np.median(cent[fe])), 0)
            fsb = _frames(a, min(b, a + 6), len(cent))
            m["centroid_start"] = rnd(float(np.median(cent[fsb])), 0)
        if cqt is not None:
            fs = _frames(a, b, cqt.shape[1])
            p90 = np.percentile(cqt[:, fs], 92, axis=1)
            thr = p90.max() - 20
            idx = np.where(p90 >= thr)[0]
            if len(idx):
                m["range_lo"], m["range_hi"] = int(24 + round(idx.min() / 3)), int(24 + round(idx.max() / 3))
        if chroma is not None:
            fs = _frames(a, b, chroma.shape[1])
            cv = chroma[:, fs].mean(1)
            m["chroma"] = rnd(cv / (cv.max() + 1e-12), 3)
            sc = key_scores(cv)
            m["key"], m["key_corr"] = int(np.argmax(sc)), rnd(float(sc.max()), 2)
        s0, s1 = int(a * SR_HI), int(b * SR_HI)
        Lc, Rc = stereo_L[s0:s1].astype(np.float64), stereo_R[s0:s1].astype(np.float64)
        if len(Lc):
            M2, S2 = (((Lc + Rc) / 2) ** 2).mean(), (((Lc - Rc) / 2) ** 2).mean()
            m["side_mid"] = rnd(float(np.sqrt(S2 / (M2 + 1e-20))), 2)
        ls = (lt >= a) & (lt < b)
        if ls.any():
            m["harm"], m["perc"] = rnd(float(hn[ls].mean()), 2), rnd(float(pn[ls].mean()), 2)
        # grid alignment of onsets to the 8th-note grid
        if len(beats) > 2:
            ons = onsets[(onsets >= a) & (onsets < b)]
            devs = []
            for o in ons:
                i = np.searchsorted(beats, o) - 1
                if 0 <= i < len(beats) - 1:
                    f = (o - beats[i]) / (beats[i + 1] - beats[i]) * 2
                    devs.append(abs(f - round(f)))
            if len(devs) >= 6:
                m["grid"] = rnd(1 - 2 * float(np.mean(devs)), 2)
        # chords
        cs = [c for c in chords if c["end"] > a and c["start"] < b and c["label"] != "N"]
        seq = []
        for c in cs:
            if not seq or seq[-1]["label"] != c["label"]:
                seq.append(c)
        m["chord_seq"] = [c["label"] for c in seq][:14]
        m["borrowed"] = sorted({c["label"] for c in cs if c.get("function") == "X"}, key=lambda x: m["chord_seq"].index(x) if x in m["chord_seq"] else 99)
        m["n_chords"] = len({c["label"] for c in cs})
        # stems in this chapter
        sh = {}
        for it in stems_items:
            tt, vv = _series_arr(it.get("energy"))
            e = _mean_in(tt, vv, a, b, -80)
            sh[it["name"]] = 10 ** (e / 10)
        tot = sum(sh.values()) + 1e-20
        m["stems"] = {k: rnd(v / tot * 100, 1) for k, v in sh.items()}
        return m

    chs = []
    for i, c in enumerate(raw):
        chs.append({"idx": i, "roman": ROMANS[i] if i < len(ROMANS) else str(i + 1),
                    "start": rnd(c["start"], 2), "end": rnd(c["end"], 2), "labels": c["labels"],
                    "break": bool(c.get("break")), "m": metrics(c["start"], c["end"])})

    _name_chapters(chs, dur)
    gm = metrics(0, dur)
    for c in chs:
        c["scenes"] = []
    _assign_scenes(chs)
    first_chroma = chs[0]["m"].get("chroma")
    for i, c in enumerate(chs):
        c["facts"] = _facts(c, chs, i, A, gm, flats, tonic, minor, first_chroma)
        c["tone"] = "red" if c["role"] in ("climax", "break", "dark", "burst") else ("blue" if c["role"] in ("prologue", "end") else "gold")

    # global headline numbers
    rng_lo = min((c["m"].get("range_lo", 999) for c in chs), default=None)
    rng_hi = max((c["m"].get("range_hi", -1) for c in chs), default=None)
    glob = {
        "duration": rnd(dur, 1), "bpm": R.get("bpm"), "time_signature": R.get("time_signature"),
        "key_cn": key.get("name_cn"), "lufs": L.get("integrated_lufs"), "lra": L.get("lra"),
        "range": f"{note(rng_lo, flats)} - {note(rng_hi, flats)}" if rng_lo and rng_hi and rng_hi > 0 else None,
        "range_lo": rng_lo, "range_hi": rng_hi, "n_chapters": len(chs),
        "first_last_sim": rnd(_cos(chs[0]["m"].get("chroma", [1] * 12), chs[-1]["m"].get("chroma", [1] * 12)), 2) if len(chs) > 1 else None,
    }
    return {"chapters": chs, "key_trail": trail, "layers": layers, "global": glob, "bands5": [b[0] for b in BANDS5],
            "bands5_edges": [[b[1], b[2]] for b in BANDS5]}


# ------------------------------------------------------------------------------------------------
NAMES = {
    "prologue": ("序章", None), "build": ("蓄势", "心跳般的打击"), "burst": ("全奏", "全频段爆发"),
    "dark": ("转暗", "和声沉入降号区"), "bright": ("转亮", "和声升入升号区"), "break": ("断层", None),
    "climax": ("高潮", "全曲最强段"), "end": ("归零", "回到原点"), "coda": ("终章", "最后的冲刺"),
    "fall": ("回落", "短暂的喘息"), "rise": ("攀升", "持续加压"), "return": ("再现", "主题回归"), "develop": ("展开", "动机的延伸"),
}


def _name_chapters(chs, dur):
    n = len(chs)
    for c in chs:
        c["role"] = None
    lufs = [c["m"].get("lufs", -60) for c in chs]
    if n >= 2:
        chs[0]["role"] = "prologue"
        last = chs[-1]
        last["role"] = "end" if lufs[-1] < max(lufs) - 5 or (n > 2 and lufs[-1] < lufs[-2] - 4) else "coda"
    for c in chs:
        if c["break"]:
            c["role"] = "break"
    mids = [i for i in range(n) if chs[i]["role"] is None]
    if mids:
        k = max(mids, key=lambda i: lufs[i])
        if lufs[k] >= np.median(lufs):
            chs[k]["role"] = "climax"
    # drums enter
    for i in range(1, n):
        if chs[i]["role"] is None:
            p0, p1 = chs[i - 1]["m"].get("perc", 0), chs[i]["m"].get("perc", 0)
            if p1 > 0.25 and p1 > p0 * 1.8:
                chs[i]["role"] = "build"
                break
    # biggest rise
    rises = [(lufs[i] - lufs[i - 1], i) for i in range(1, n) if chs[i]["role"] is None]
    if rises:
        d, i = max(rises)
        if d >= 3.5:
            chs[i]["role"] = "burst"
    # key drift on the circle of fifths
    for i, c in enumerate(chs):
        if c["role"] is None and c["m"].get("borrowed"):
            fl = sum(1 for b in c["m"]["borrowed"] if "b" in b or b in ("F", "Fm", "Cm", "Gm", "Dm"))
            if len(c["m"]["borrowed"]) >= 2:
                c["role"] = "dark" if fl >= len(c["m"]["borrowed"]) / 2 else "bright"
                break
    seen_labels = set()
    for i, c in enumerate(chs):
        if c["role"] is None:
            if i and set(c["labels"]) & seen_labels:
                c["role"] = "return"
            elif i and lufs[i] < lufs[i - 1] - 2.5:
                c["role"] = "fall"
            elif i and lufs[i] > lufs[i - 1] + 2:
                c["role"] = "rise"
            else:
                c["role"] = "develop"
        seen_labels |= set(c["labels"])
    used = {}
    for c in chs:
        nm, sub = NAMES[c["role"]]
        used[nm] = used.get(nm, 0) + 1
        c["name"] = nm if used[nm] == 1 else nm + " " + "ⅡⅢⅣⅤ"[min(3, used[nm] - 2)]
        m = c["m"]
        if c["role"] == "prologue":
            sub = "低音的阴影" if m.get("low150", 0) >= 45 else ("寂静中开始" if m.get("lufs", 0) < -20 else "一切的起点")
        if c["role"] == "break":
            sub = f"{c['end'] - c['start']:.0f} 秒真空"
        if c["role"] == "end" and m.get("chroma") is not None and chs[0]["m"].get("chroma") is not None:
            sub = "回到原点" if _cos(m["chroma"], chs[0]["m"]["chroma"]) > 0.93 else "余音"
        c["subtitle"] = sub


SCENES_BY_ROLE = {
    "prologue": ["pianoroll", "chromaclock"], "build": ["rhythmspiral", "drumgrid"],
    "burst": ["spectrumbars", "chordorbit"], "dark": ["keytrail"], "bright": ["keytrail"],
    "break": ["oscilloscope"], "climax": ["ridgeline", "lissajous"], "end": ["chromaradar"],
    "coda": ["radial", "chromaradar"], "fall": ["notefall"], "rise": ["stemgalaxy"],
    "return": ["chordorbit"], "develop": ["tonnetz"],
}
POOL = ["chordorbit", "stemgalaxy", "notefall", "spectrumbars", "ridgeline", "rhythmspiral", "radial",
        "pianoroll", "tonnetz", "lissajous", "chromaclock", "streamgraph", "keytrail", "drumgrid"]


def _assign_scenes(chs):
    used = set()
    for c in chs:
        d = c["end"] - c["start"]
        k = 1 if c["role"] == "break" else int(np.clip(round(d / 21), 1, 3))
        want = list(SCENES_BY_ROLE.get(c["role"], []))
        for s in POOL:
            if len(want) >= k:
                break
            if s not in used and s not in want:
                want.append(s)
        want = want[:k]
        used |= set(want)
        edges = np.linspace(c["start"], c["end"], len(want) + 1)
        c["scenes"] = [{"type": s, "start": rnd(float(a), 2), "end": rnd(float(b), 2)} for s, a, b in zip(want, edges[:-1], edges[1:])]


# ------------------------------------------------------------------------------------------------
TRIADS = [((r, (r + 4) % 12, (r + 7) % 12), r, "") for r in range(12)] + \
         [((r, (r + 3) % 12, (r + 7) % 12), r, "m") for r in range(12)]


def _facts(c, chs, i, A, gm, flats, tonic, minor, first_chroma):
    a, b = c["start"], c["end"]
    m = c["m"]
    names = NOTE_NAMES_FLAT if flats else NOTE_NAMES
    prev = chs[i - 1]["m"] if i else None
    first = chs[0]["m"]
    R, L = A.get("rhythm", {}), A.get("loudness", {})
    cand = []  # (priority, fact)

    def add(p, text=None, big=None, sub=None, accent="gold", kind=None):
        cand.append((p, {"text": text, "big": big, "sub": sub, "accent": accent, "kind": kind}))

    role = c["role"]
    perc, harm = m.get("perc", 0), m.get("harm", 0)
    # opening sentence ---------------------------------------------------------------------------
    if role == "prologue":
        if perc < 0.15:
            add(100, "开头没有任何打击乐，只有" + ("低沉、持续的声部在铺底。" if m.get("low150", 0) > 40 else "旋律与和声在缓缓展开。"))
        else:
            add(100, f"开场即带着律动进入，节奏层占据了相当的能量。")
        if m.get("low150", 0) >= 35:
            add(90, big=f"≈{m['low150']:.0f}%", sub="的能量集中在 150 Hz 以下的低频")
        elif m.get("centroid"):
            add(80, big=f"{m['centroid']:.0f} Hz", sub="频谱重心：声音整体的“亮度”")
        if m.get("range_hi"):
            hi = note(m["range_hi"], flats)
            if m["range_hi"] <= 72:
                add(85, f"音域上限只到 {hi} 附近：声音被压在低处，阴沉而克制。", accent="red")
            else:
                add(70, f"本段音域：{note(m.get('range_lo', 36), flats)} – {hi}。")
        ch = m.get("chroma")
        if ch is not None:
            top = list(np.argsort(ch)[::-1][:3])
            tri = next((t for t in TRIADS if set(t[0]) == set(top)), None)
            lbl = " · ".join(names[p] for p in sorted(top, key=lambda p: -ch[p]))
            if tri:
                add(88, big=lbl, sub=f"出现最多的三个音，正好组成 {names[tri[1]]}{'小' if tri[2] else '大'}三和弦", kind="notes")
            else:
                add(60, big=lbl, sub="出现最多的三个音", kind="notes")
        k = A.get("harmony", {}).get("key", {})
        if k:
            seq = m.get("chord_seq", [])
            stay = ""
            if seq:
                from collections import Counter
                top_c = Counter(seq).most_common(1)[0][0]
                stay = f"和弦多数时间停在 {top_c} 上。"
            corr = (k.get("scores") or [0] * 24)[k.get("index", 0)]
            add(75, f"调性检测结果：{k.get('name_cn')}（相关度 {corr:.2f}）。{stay}")
    elif role == "build":
        add(100, f"{mm(a)} 打击层进入，全曲的律动从这里开始。")
        if R.get("bpm"):
            bpb = R.get("beats_per_bar", 4)
            add(90, big=f"≈{R['bpm']:.0f} BPM", sub=f"{R.get('time_signature', '4/4')} 拍，一小节约 {60 / R['bpm'] * bpb:.1f} 秒")
        add(70, "把每小节绕成一圈：击点落在哪条“八分音符辐条”上，一目了然。")
        if m.get("grid") is not None:
            g = m["grid"]
            add(80, big=f"{g:.2f}", sub="击点与八分音符网格的对齐度（1 = 完全对齐）：" + ("速度稳如节拍器" if g > 0.8 else "带着明显的人性化摇摆"))
        d = (m.get("lufs_end") or 0) - (m.get("lufs_start") or 0)
        if abs(d) >= 3:
            add(78, big=f"{d:+.0f} dB", sub=f"{b - a:.0f} 秒内响度从 {m['lufs_start']:.0f} {'升' if d > 0 else '降'}到 {m['lufs_end']:.0f} LUFS" + ("，持续蓄力" if d > 0 else ""))
    elif role == "burst":
        add(100, f"{mm(a)} 全奏进入：所有频段在同一瞬间打开。")
        if prev:
            add(90, big=f"{prev['lufs']:.0f} → {m['lufs']:.0f}", sub=f"平均短时响度 (LUFS)，比上一段响了约 {m['lufs'] - prev['lufs']:.0f} dB", kind="arrow")
        if prev and m.get("bands") and prev.get("bands"):
            d = [m["bands"][k] - first["bands"][k] for k in range(5)]
            k = int(np.argmax(d))
            if d[k] > 3:
                nm = BANDS5[k]
                add(80, f"{nm[0]}（{nm[1]} Hz - {nm[2] if nm[2] < 1000 else str(nm[2] // 1000) + ' k'}Hz）的占比从序章的约 {first['bands'][k]:.0f}% 跃升到约 {m['bands'][k]:.0f}%，声音变得“有棱角”。")
        if m.get("range_hi") and first.get("range_hi") and m["range_hi"] - first["range_hi"] >= 5:
            add(75, f"音域上限扩展到 {note(m['range_hi'], flats)}，比序章高出 {m['range_hi'] - first['range_hi']} 个半音。")
        if m.get("chord_seq"):
            add(70, "和声开始流动。", accent="gold")
    elif role in ("dark", "bright"):
        bor = m.get("borrowed", [])
        zone = "降号区" if role == "dark" else "升号区"
        add(100, f"{mm(a)} 和声转向“{zone}”：{'、'.join(bor[:5])} 接连出现。")
        add(85, f"在五度圈上，调性重心{'逆' if role == 'dark' else '顺'}时针滑出{'2 - 3' if len(bor) > 2 else '1 - 2'} 格。")
        add(80, ("降号越多，听感越暗、越沉重——同样的力度，被染上了更深的颜色。" if role == "dark"
                 else "升号越多，听感越亮、越紧张——色彩被一点点提亮。"))
        if m.get("lufs") is not None:
            pk = f"；{mm(m['lufs_peak_t'])} 达到 {m['lufs_peak']:.1f} 的全曲短时峰值" if m.get("lufs_peak") is not None and abs(m["lufs_peak"] - (L.get("max_short_term") or 99)) < 0.3 else ""
            add(75, big=f"{m['lufs']:.1f} LUFS", sub="本段平均响度" + pk)
    elif role == "break":
        d = (prev["lufs"] - m["lufs"]) if prev else 0
        add(100, f"{mm(a)} {'打击层退出，' if perc < 0.3 else ''}能量骤降约 {d:.0f} dB", accent="white", kind="center")
        add(90, f"{b - a:.0f} 秒的“真空”，为接下来的段落让出呼吸。", accent="white", kind="center")
    elif role == "climax":
        add(100, f"{mm(a)} 最终高潮。" if i > len(chs) / 2 else f"{mm(a)} 全曲能量最高的段落。")
        add(92, big=f"{m['lufs']:.1f} LUFS", sub="全曲平均响度最高的段落")
        if m.get("range_hi") and gm.get("range_hi") and m["range_hi"] >= gm.get("range_hi", 0) - 1:
            lo = min(cc["m"].get("range_lo", 99) for cc in chs)
            octv = (m["range_hi"] - lo) / 12
            add(85, f"音域冲到 {note(m['range_hi'], flats)}，全曲最宽：从 {note(lo, flats)} 到 {note(m['range_hi'], flats)}，跨越 {octv:.0f} 个八度{'以上' if octv % 1 > 0.2 else ''}。")
        maj_tonic = names[tonic] if minor else None
        if minor and maj_tonic and maj_tonic in m.get("chord_seq", []):
            add(70, f"算法多次检测到 {maj_tonic} 大三和弦——在 {names[tonic]} 小调的语境里，像一道刺眼的亮光。", accent="red")
        if first.get("side_mid") and m.get("side_mid"):
            r = m["side_mid"] / (first["side_mid"] + 1e-9)
            add(80, "声像：左右声道画成李萨如图形。")
            add(78, big=f"{r:.2f} vs 1.00", sub="侧/中能量比：本段 vs 序章")
            add(65, "序章的声音弥散、包围四周；此刻能量向正中央聚拢，冲击力更直接。" if r < 0.9 else
                "此刻声场比序章更宽，声音向两侧张开、包围听者。")
    elif role in ("end", "coda"):
        if role == "end":
            add(100, f"{mm(a)} {'骤然' if (prev and prev['lufs'] - m['lufs'] > 8) else '逐渐'}收束。")
        else:
            add(100, f"{mm(a)} 进入终章。")
        if m.get("centroid_start") and m.get("centroid_end") and m["centroid_start"] > m["centroid_end"] * 1.6:
            add(90, big=f"{m['centroid_start']:.0f} → {m['centroid_end']:.0f} Hz", sub="频谱重心急坠，高频几乎全部消失", kind="arrow")
        if first_chroma is not None and m.get("chroma") is not None:
            s_first = _cos(m["chroma"], first_chroma)
            mids = [cc["m"]["chroma"] for cc in chs[1:-1] if cc["m"].get("chroma") is not None]
            s_mid = _cos(m["chroma"], np.mean(mids, 0)) if mids else None
            if s_first > 0.9:
                k = int(np.argmax(m["chroma"]))
                add(85, f"{'低频持续音回来了，' if m.get('low150', 0) > 40 else ''}{names[k]} 再次成为中心。红线逐渐贴合金色的序章轮廓。")
            add(80, big=f"{s_first:.2f}", sub="首尾音高分布的相似度" + (f"（与中段仅 {s_mid:.2f}）" if s_mid is not None else ""))
        add(40, f"{A['meta'].get('title') or '这首曲子'}——音乐在 {mm(b)} 后回到了出发的原点。" if role == "end" else None)
    else:  # fall / rise / return / develop
        if role == "return":
            add(100, f"{mm(a)} 熟悉的材料再次出现（结构标签 {'/'.join(sorted(set(c['labels'])))}）。")
        elif role == "fall":
            add(100, f"{mm(a)} 能量回落到 {m['lufs']:.0f} LUFS，编曲变得稀疏。")
        elif role == "rise":
            add(100, f"{mm(a)} 能量继续攀升至 {m['lufs']:.0f} LUFS。")
        else:
            add(100, f"{mm(a)} 动机在新的配器中展开。")
        st = m.get("stems") or {}
        if st:
            k = max(st, key=st.get)
            lab = {"vocals": "人声", "drums": "鼓组", "bass": "贝斯", "guitar": "吉他", "piano": "钢琴/键盘", "other": "其他乐器"}.get(k, k)
            add(85, big=f"{st[k]:.0f}%", sub=f"本段能量来自{lab}——此刻的主角")
        if m.get("chord_seq"):
            add(75, " - ".join(m["chord_seq"][:8]) + (" …" if len(m["chord_seq"]) > 8 else ""), kind="chords")
        if m.get("n_chords"):
            add(60, big=str(m["n_chords"]), sub="本段出现的不同和弦数量")
    # chord list for chord-orbit scenes
    if any(s["type"] == "chordorbit" for s in c["scenes"]) and m.get("chord_seq") and role != "develop":
        add(72, " - ".join(m["chord_seq"][:8]) + (" …" if len(m["chord_seq"]) > 8 else ""), kind="chords")
        if m.get("borrowed"):
            k = A.get("harmony", {}).get("key", {})
            add(68, f"金色是 {k.get('name_cn', '本调')} 自身的和弦；红色的 {'、'.join(m['borrowed'][:3])} 等是从调外“借来”的，让色彩忽明忽暗。")
    # vocals entrance (any role)
    st = m.get("stems") or {}
    pst = (prev or {}).get("stems") or {}
    if st.get("vocals", 0) > 15 and pst.get("vocals", 0) < 5:
        add(95, f"{mm(a)} 人声进入。")

    # choose & time facts --------------------------------------------------------------------------
    cand = [(p, f) for p, f in cand if f["text"] or f["big"]]
    dur = b - a
    max_n = int(np.clip(dur // 5, 1, 5))
    keep_first = [x for x in cand if x[0] == 100][:1]
    rest = sorted([x for x in cand if x not in keep_first], key=lambda x: -x[0])
    chosen = (keep_first + rest)[:max_n]
    # keep narrative order: opening first, then by priority order as generated
    order = {id(f): k for k, (_, f) in enumerate(cand)}
    chosen.sort(key=lambda x: order[id(x[1])])
    out = []
    step = dur / (len(chosen) + 0.5)
    for k, (_, f) in enumerate(chosen):
        f = {kk: v for kk, v in f.items() if v is not None}
        f["t"] = rnd(a + 0.4 + k * min(step, 7.0), 2)
        out.append(f)
    return out
