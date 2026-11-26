"""Polyphonic note transcription (Spotify basic-pitch, ONNX) per stem + multi-track MIDI export."""
from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from .common import SR, rnd

_MODEL = None

STEM_SETTINGS = {  # min_hz, max_hz, GM program, onset_thr, frame_thr, min_len_ms
    "vocals": (70, 1200, 53, 0.5, 0.3, 90),
    "bass": (28, 420, 33, 0.5, 0.3, 80),
    "piano": (27, 4200, 0, 0.5, 0.3, 60),
    "guitar": (70, 2000, 25, 0.5, 0.3, 60),
    "other": (40, 4200, 48, 0.55, 0.35, 80),
    "mix": (27, 4200, 0, 0.5, 0.3, 60),
}


def _model():
    global _MODEL
    if _MODEL is None:
        from basic_pitch import ICASSP_2022_MODEL_PATH
        from basic_pitch.inference import Model
        onnx = Path(ICASSP_2022_MODEL_PATH).parent / "nmp.onnx"
        _MODEL = Model(onnx if onnx.exists() else ICASSP_2022_MODEL_PATH)
    return _MODEL


def transcribe(y22: np.ndarray, stem: str) -> list:
    from basic_pitch.inference import predict

    lo, hi, _, on_t, fr_t, ml = STEM_SETTINGS.get(stem, STEM_SETTINGS["mix"])
    if np.sqrt(np.mean(y22 ** 2)) < 1e-4:
        return []
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / f"{stem}.wav"
        sf.write(p, y22, SR)
        _, _, events = predict(str(p), _model(), onset_threshold=on_t, frame_threshold=fr_t,
                               minimum_note_length=ml, minimum_frequency=lo, maximum_frequency=hi,
                               multiple_pitch_bends=False, melodia_trick=True)
    notes = [[rnd(s, 3), rnd(e, 3), int(p), rnd(float(a), 2)] for s, e, p, a, *_ in events]
    notes.sort(key=lambda n: (n[0], n[2]))
    return notes


def export_midi(path: Path, bpm: float | None, tracks: dict[str, list], drum_hits: list | None,
                time_sig: tuple[int, int] = (4, 4)) -> None:
    import pretty_midi

    pm = pretty_midi.PrettyMIDI(initial_tempo=float(bpm or 120))
    pm.time_signature_changes.append(pretty_midi.TimeSignature(time_sig[0], time_sig[1], 0))
    for stem, notes in tracks.items():
        if not notes:
            continue
        prog = STEM_SETTINGS.get(stem, STEM_SETTINGS["mix"])[2]
        inst = pretty_midi.Instrument(program=prog, name=stem)
        for s, e, p, a in notes:
            inst.notes.append(pretty_midi.Note(velocity=int(np.clip(40 + 87 * (a or 0.5), 1, 127)), pitch=int(p),
                                               start=float(s), end=float(max(e, s + 0.03))))
        pm.instruments.append(inst)
    if drum_hits:
        inst = pretty_midi.Instrument(program=0, is_drum=True, name="drums")
        for h in drum_hits:
            for t, v in zip(h["t"], h["v"]):
                inst.notes.append(pretty_midi.Note(velocity=int(np.clip(50 + 77 * (v or 0.5), 1, 127)), pitch=h["gm"],
                                                   start=float(t), end=float(t) + 0.08))
        pm.instruments.append(inst)
    pm.write(str(path))
