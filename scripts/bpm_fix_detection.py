"""Confidence-based peak selection for a known constant-tempo output.

The model's default 70 ms peak window can emit two candidates for one beat.
Resolve only nearby peak competitors by model score, never by distance
to the target grid. An isolated off-grid detection remains verification evidence.
"""

import numpy as np


def select_verification_beats(raw, logits, target_bpm, tempo_factor=1.0, fps=50):
    beats = np.asarray(raw, dtype=float)
    scores = np.asarray(logits, dtype=float)
    if not np.isfinite(target_bpm) or not 30 <= target_bpm <= 300:
        raise ValueError("BPM_FIX_INVALID_TARGET")
    if tempo_factor not in (0.5, 1.0, 2.0):
        raise ValueError("BPM_FIX_INVALID_TARGET")
    if not len(beats):
        return beats
    # Half the expected detector-beat period is a refractory interval, not an
    # acceptance tolerance. No phase/offset or grid residual participates.
    separation = 0.5 * 60.0 / target_bpm * tempo_factor
    frames = np.rint(beats * fps).astype(np.int64)
    if (scores.ndim != 1 or np.any(~np.isfinite(beats)) or
            np.any(np.diff(beats) <= 0) or np.any(frames < 0) or
            np.any(frames >= len(scores)) or np.any(~np.isfinite(scores[frames]))):
        raise ValueError("BPM_FIX_INVALID_BEAT_EVIDENCE")
    blocked = np.zeros(len(beats), dtype=bool)
    keep = np.zeros(len(beats), dtype=bool)
    for i in np.argsort(-scores[frames], kind="stable"):
        if blocked[i]:
            continue
        keep[i] = True
        lo = np.searchsorted(beats, beats[i] - separation, side="right")
        hi = np.searchsorted(beats, beats[i] + separation, side="left")
        blocked[lo:hi] = True
    return beats[keep]


def detect_verification_beats(predictor, mono, sr, cpu_spect, target_bpm, tempo_factor):
    if cpu_spect is None:
        spect = predictor.signal2spect(mono, sr)
        beat_logits, downbeat_logits = predictor.spect2frames(spect)
    else:
        # Preserve the bridge's CPU spectrogram path on accelerated devices.
        import soxr
        import torch
        from beat_this.inference import split_predict_aggregate
        if sr != 22050:
            mono = soxr.resample(mono, in_rate=sr, out_rate=22050)
        spect = cpu_spect(torch.tensor(mono, dtype=torch.float32, device="cpu"))
        spect = spect.detach().to(predictor.device)
        # The bridge deliberately bypasses spect2frames/autocast on DirectML.
        with torch.no_grad():
            prediction = split_predict_aggregate(
                spect=spect, chunk_size=1500, border_size=6,
                overlap_mode="keep_first", model=predictor.model)
            beat_logits = prediction["beat"].float()
            downbeat_logits = prediction["downbeat"].float()
    raw, _ = predictor.frames2beats(beat_logits, downbeat_logits)
    selected = select_verification_beats(
        raw, beat_logits.detach().cpu().numpy(), target_bpm, tempo_factor)
    return selected, len(raw)
