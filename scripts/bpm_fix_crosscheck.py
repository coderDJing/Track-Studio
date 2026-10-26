"""Independent beat agreement; scores are diagnostics, not probabilities."""
import numpy as np


def beat_f1(primary, reference, tolerance=0.070):
    primary = np.sort(np.asarray(primary, dtype=float))
    reference = np.sort(np.asarray(reference, dtype=float))
    i = j = hits = 0
    while i < len(primary) and j < len(reference):
        delta = primary[i] - reference[j]
        if abs(delta) <= tolerance:
            hits += 1
            i += 1
            j += 1
        elif delta < 0:
            i += 1
        else:
            j += 1
    return 2.0 * hits / max(1, len(primary) + len(reference))


def cross_check(raw, mono, sr):
    try:
        import librosa
        # Downsample only the independent detector. R3 always receives the
        # original sample rate, channels and waveform.
        signal = librosa.resample(mono, orig_sr=sr, target_sr=22050)
        tempo, reference = librosa.beat.beat_track(y=signal, sr=22050, units="time", trim=False)
    except (ImportError, ModuleNotFoundError) as error:
        raise RuntimeError("BPM_FIX_LIBROSA_UNAVAILABLE") from error
    intervals = np.diff(np.asarray(raw, dtype=float))
    local = np.asarray([np.median(intervals[max(0, i - 8):i + 9]) for i in range(len(intervals))])
    regularity = float(np.mean(np.abs(intervals - local) < 0.15 * local)) if len(local) else 0.0
    agreement = beat_f1(raw, reference)
    return {
        "referenceBpm": float(np.asarray(tempo).reshape(-1)[0]) if np.size(tempo) else 0.0,
        "agreement": agreement, "regularity": regularity,
        "confidence": float(np.clip(0.6 * agreement + 0.4 * regularity, 0, 1)),
    }
