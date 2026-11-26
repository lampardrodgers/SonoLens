"""Decoding (via ffmpeg) and file metadata."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

from .common import SR, SR_HI


def probe(path: Path) -> dict:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, check=True).stdout
        info = json.loads(out)
    except Exception:  # noqa: BLE001
        return {}
    fmt = info.get("format", {})
    st = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), {})
    tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
    return {
        "format": fmt.get("format_long_name") or fmt.get("format_name"),
        "codec": st.get("codec_long_name") or st.get("codec_name"),
        "sample_rate": int(st["sample_rate"]) if st.get("sample_rate") else None,
        "channels": st.get("channels"),
        "channel_layout": st.get("channel_layout"),
        "bit_rate": int(fmt["bit_rate"]) if fmt.get("bit_rate") else None,
        "bits_per_sample": st.get("bits_per_raw_sample") or st.get("bits_per_sample") or None,
        "size_bytes": int(fmt["size"]) if fmt.get("size") else None,
        "title": tags.get("title"), "artist": tags.get("artist"), "album": tags.get("album"),
        "genre": tags.get("genre"), "date": tags.get("date"),
    }


class Audio:
    """Holds the decoded signal at the analysis rates."""

    def __init__(self, stereo_hi: np.ndarray, orig_channels: int):
        self.st = stereo_hi                      # (2, n) float32 @ 44.1k
        self.mono_hi = stereo_hi.mean(axis=0)
        self.mono = librosa.resample(self.mono_hi, orig_sr=SR_HI, target_sr=SR, res_type="soxr_hq")
        self.duration = stereo_hi.shape[1] / SR_HI
        self.orig_channels = orig_channels


def decode(src: Path, out_dir: Path) -> tuple[Audio, Path]:
    """Decode anything ffmpeg understands to a 44.1 kHz FLAC (kept for playback), return Audio."""
    mix = out_dir / "audio" / "mix.flac"
    mix.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-vn", "-ar", str(SR_HI),
                    "-sample_fmt", "s16", "-c:a", "flac", str(mix)], check=True)
    y, sr = sf.read(mix, dtype="float32", always_2d=True)
    y = y.T
    ch = y.shape[0]
    if ch == 1:
        y = np.vstack([y, y])
    elif ch > 2:
        y = y[:2]
    return Audio(np.ascontiguousarray(y), ch), mix
