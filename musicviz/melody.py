"""Monophonic pitch tracking (pYIN) for the vocal line and the bass line."""
from __future__ import annotations

import librosa
import numpy as np

from .common import NOTE_NAMES, SR, midi_to_name, rnd

HOP = 512


def track(y: np.ndarray, fmin: float, fmax: float, frame_length: int = 2048) -> dict:
    f0, voiced, vprob = librosa.pyin(y, fmin=fmin, fmax=fmax, sr=SR, frame_length=frame_length,
                                     hop_length=HOP, fill_na=np.nan, max_transition_rate=35.92, resolution=0.1)
    rms = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=HOP)[0]
    rms = np.resize(rms, len(f0))
    gate = rms > max(rms.max() * 0.02, 1e-4)
    ok = voiced & gate & np.isfinite(f0)
    midi = np.full(len(f0), np.nan)
    midi[ok] = librosa.hz_to_midi(f0[ok])
    res = {"t0": 0.0, "dt": HOP / SR, "midi": rnd(midi, 2), "voiced_ratio": rnd(float(ok.mean()), 3)}
    if ok.sum() > 20:
        m = midi[ok]
        lo, hi = np.percentile(m, 2), np.percentile(m, 98)
        res.update({
            "low": midi_to_name(lo), "high": midi_to_name(hi), "low_midi": rnd(lo, 2), "high_midi": rnd(hi, 2),
            "median": midi_to_name(np.median(m)), "range_semitones": rnd(float(hi - lo), 1),
            "abs_low": midi_to_name(m.min()), "abs_high": midi_to_name(m.max()),
        })
        notes = np.round(m).astype(int)
        lo_i, hi_i = int(notes.min()), int(notes.max())
        hist = np.bincount(notes - lo_i, minlength=hi_i - lo_i + 1)
        res["note_hist"] = {"midi0": lo_i, "counts": hist.astype(int).tolist(),
                            "names": [midi_to_name(i) for i in range(lo_i, hi_i + 1)]}
        pc = np.bincount(notes % 12, minlength=12).astype(float)
        res["pitch_class_hist"] = rnd(pc / pc.max(), 3)
        # intonation: deviation from the nearest semitone (cents) on stable frames
        dev = (m - np.round(m)) * 100
        stable = np.abs(np.diff(midi, prepend=np.nan))[ok] < 0.15
        if stable.sum() > 10:
            d = dev[stable]
            res["intonation"] = {"mean_cents": rnd(float(np.mean(d)), 1), "std_cents": rnd(float(np.std(d)), 1),
                                 "hist": np.histogram(d, bins=20, range=(-50, 50))[0].astype(int).tolist()}
        # vibrato estimate: modulation in 4-8 Hz band of voiced runs
        runs, cur = [], []
        for i, v in enumerate(ok):
            if v:
                cur.append(midi[i])
            elif cur:
                runs.append(cur)
                cur = []
        if cur:
            runs.append(cur)
        rates, depths = [], []
        fps = SR / HOP
        for r in runs:
            if len(r) < int(fps * 0.6):
                continue
            x = np.array(r) - np.convolve(r, np.ones(9) / 9, mode="same")
            x = x[4:-4]
            if len(x) < 16:
                continue
            sp = np.abs(np.fft.rfft(x * np.hanning(len(x))))
            fr = np.fft.rfftfreq(len(x), 1 / fps)
            band = (fr >= 4) & (fr <= 8)
            if band.any() and sp[band].max() > 0.5 * sp[1:].max():
                rates.append(fr[band][np.argmax(sp[band])])
                depths.append(np.std(x) * 2 * 100)
        if rates:
            res["vibrato"] = {"rate_hz": rnd(float(np.median(rates)), 2), "depth_cents": rnd(float(np.median(depths)), 0),
                              "phrases_with_vibrato": len(rates)}
    return res


def segment_notes(track_res: dict, min_dur: float = 0.09) -> list:
    """Turn a pitch contour into note events (for piano roll / MIDI)."""
    midi = np.array([np.nan if v is None else v for v in track_res["midi"]], dtype=float)
    dt = track_res["dt"]
    notes, start, cur = [], None, None
    for i, m in enumerate(np.r_[midi, np.nan]):
        r = None if not np.isfinite(m) else int(round(m))
        if r != cur:
            if cur is not None and (i - start) * dt >= min_dur:
                notes.append([rnd(start * dt, 3), rnd(i * dt, 3), cur])
            start, cur = i, r
    return notes


PC_NAMES = NOTE_NAMES
