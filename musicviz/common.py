"""Shared helpers: binary matrix export, pooling, JSON-friendly rounding, music constants."""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
NOTE_NAMES_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]

SR_HI = 44100      # stereo / loudness / full-band spectrum
SR = 22050         # most music features
HOP = 512          # hop at SR  -> ~43 fps
FPS = SR / HOP


def midi_to_name(m: float) -> str:
    m = int(round(m))
    return f"{NOTE_NAMES[m % 12]}{m // 12 - 1}"


def hz_to_name(f: float) -> str:
    if not f or f <= 0 or not math.isfinite(f):
        return "-"
    return midi_to_name(69 + 12 * math.log2(f / 440.0))


def rnd(x, nd: int = 3):
    """Round arrays / scalars for compact JSON; NaN/inf -> None."""
    if x is None:
        return None
    if isinstance(x, (list, tuple)):
        return [rnd(v, nd) for v in x]
    if isinstance(x, np.ndarray):
        a = np.asarray(x, dtype=np.float64)
        out = np.round(a, nd).astype(object)
        out[~np.isfinite(a)] = None
        return out.tolist()
    if isinstance(x, (np.floating, float)):
        xf = float(x)
        return round(xf, nd) if math.isfinite(xf) else None
    if isinstance(x, (np.integer,)):
        return int(x)
    return x


def pool_time(mat: np.ndarray, max_frames: int, how: str = "max"):
    """Reduce the time axis (last axis) to at most max_frames by pooling. Returns (mat, factor)."""
    n = mat.shape[-1]
    if n <= max_frames:
        return mat, 1
    f = int(math.ceil(n / max_frames))
    pad = (-n) % f
    if pad:
        mat = np.concatenate([mat, np.repeat(mat[..., -1:], pad, axis=-1)], axis=-1)
    shp = mat.shape[:-1] + (mat.shape[-1] // f, f)
    m = mat.reshape(shp)
    return (m.max(axis=-1) if how == "max" else m.mean(axis=-1)), f


def pool_1d(x: np.ndarray, max_len: int, how: str = "mean"):
    y, f = pool_time(np.asarray(x, dtype=np.float32)[None, :], max_len, how)
    return y[0], f


def to_u8(mat: np.ndarray, lo: float, hi: float) -> np.ndarray:
    m = (np.asarray(mat, dtype=np.float32) - lo) / max(hi - lo, 1e-9)
    return (np.clip(np.nan_to_num(m, nan=0.0), 0, 1) * 255 + 0.5).astype(np.uint8)


class Store:
    """Writes binary blobs next to analysis.json; returns descriptors the frontend understands."""

    def __init__(self, out_dir: Path):
        self.out = Path(out_dir)
        (self.out / "bin").mkdir(parents=True, exist_ok=True)

    def heatmap(self, name: str, mat: np.ndarray, *, lo: float, hi: float, t0: float, t1: float,
                axis: dict, max_frames: int = 12000, pool: str = "max", unit: str = "dB",
                cmap: str = "magma") -> dict:
        """mat: [bins, frames], bin 0 = bottom. Quantised to uint8 over [lo, hi]."""
        mat, _ = pool_time(np.asarray(mat, dtype=np.float32), max_frames, pool)
        u8 = np.ascontiguousarray(to_u8(mat, lo, hi))
        fn = f"bin/{name}.u8"
        u8.tofile(self.out / fn)
        return {"file": fn, "rows": int(u8.shape[0]), "cols": int(u8.shape[1]), "lo": float(lo),
                "hi": float(hi), "t0": float(t0), "t1": float(t1), "axis": axis, "unit": unit, "cmap": cmap}

    def raw(self, name: str, arr: np.ndarray, dtype: str) -> dict:
        a = np.ascontiguousarray(np.asarray(arr).astype(dtype))
        fn = f"bin/{name}.{dtype}"
        a.tofile(self.out / fn)
        return {"file": fn, "shape": list(a.shape), "dtype": dtype}


def series(x: np.ndarray, t0: float, dt: float, nd: int = 3, max_len: int = 6000, how: str = "mean") -> dict:
    """Uniformly-sampled time series, pooled to at most max_len points."""
    x = np.asarray(x, dtype=np.float64)
    if len(x) > max_len:
        y, f = pool_1d(x, max_len, how)
        x, dt = y.astype(np.float64), dt * f
    return {"t0": float(t0), "dt": float(dt), "v": rnd(x, nd)}


def write_json(path: Path, obj) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))


def db(x, ref=1.0, floor=-120.0):
    return np.maximum(20 * np.log10(np.maximum(np.abs(x), 1e-12) / ref), floor)


def pdb(p, floor=-120.0):
    return np.maximum(10 * np.log10(np.maximum(p, 1e-20)), floor)
