"""Independent beat agreement; scores are diagnostics, not probabilities."""
import numpy as np


def merge_cross_check(analysis, checked):
    # Agreement cannot restore missing full-track evidence. Keep the independent
    # score separately so the UI and the repair gate use the same bounded score.
    return {**analysis, **checked,
            "confidence": min(analysis["confidence"], checked["confidence"]),
            "crossCheckConfidence": checked["confidence"]}


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


def compare_beats(raw, reference, reference_bpm):
    primary = np.asarray(raw, dtype=float)
    reference = np.asarray(reference, dtype=float)
    agreement = beat_f1(primary, reference)
    aligned = agreement
    phase_shift = 0.0
    if len(primary) >= 8 and len(reference) >= 8:
        period = float(np.median(np.diff(primary)))
        primary_bpm = 60 / period
        ratio = reference_bpm / primary_bpm
        # A constant phase disagreement is not evidence of unreliable tempo.
        # Only compare coherent tempo interpretations; never alter render beats.
        if min(abs(ratio / factor - 1) for factor in (0.5, 1, 2)) <= 0.04:
            # Circular mean avoids the +/- half-period median discontinuity.
            at = np.searchsorted(reference, primary)
            left = reference[np.maximum(0, at - 1)]
            right = reference[np.minimum(len(reference) - 1, at)]
            nearest = np.where(abs(left - primary) <= abs(right - primary), left, right)
            shifts = primary - nearest
            common_period = min(period, float(np.median(np.diff(reference))))
            angles = shifts * (2 * np.pi / common_period)
            coherence = abs(np.mean(np.exp(1j * angles)))
            if coherence >= 0.8:
                shift = float(np.angle(np.mean(np.exp(1j * angles))) * common_period / (2 * np.pi))
                score = beat_f1(primary, reference + shift)
                if score > agreement:
                    aligned, phase_shift = score, shift
    return {"agreement": agreement, "phaseAlignedAgreement": aligned,
            "referencePhaseShiftMs": phase_shift * 1000}


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
    reference_bpm = float(np.asarray(tempo).reshape(-1)[0]) if np.size(tempo) else 0.0
    compared = compare_beats(raw, reference, reference_bpm)
    return {
        "referenceBpm": reference_bpm, **compared, "regularity": regularity,
        "confidence": float(np.clip(0.6 * compared["phaseAlignedAgreement"] + 0.4 * regularity, 0, 1)),
    }
