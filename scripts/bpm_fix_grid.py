"""Audio-independent planning for constant-tempo correction (seconds throughout).

Keep metrical beat indices separate from target tempo: a drifting source must
not gain or lose a beat just because it crosses a target-grid boundary.
"""

import numpy as np


def _line(x, y):
    center = float(np.mean(x))
    slope, intercept = np.linalg.lstsq(
        np.column_stack((x - center, np.ones(len(x)))), y, rcond=None
    )[0]
    return float(slope), float(intercept - slope * center)


def _period(beats, detected, initial, history=16):
    start = max(0, len(beats) - history)
    x = np.arange(start, len(beats), dtype=float)
    mask = np.asarray(detected[start:], dtype=bool)
    if np.count_nonzero(mask) < 4:
        return initial
    period, _ = _line(x[mask], np.asarray(beats[start:])[mask])
    return period if initial * 0.6 < period < initial * 1.4 else initial


def walk_beats(raw, duration):
    raw = np.unique(np.asarray(raw, dtype=float))
    raw = raw[np.isfinite(raw) & (raw >= 0) & (raw < duration)]
    if len(raw) < 8:
        raise ValueError("BPM_FIX_NOT_ENOUGH_BEATS")
    initial = float(np.median(np.diff(raw[:min(33, len(raw))])))
    if not 0.15 <= initial <= 2.0:
        raise ValueError("BPM_FIX_UNRELIABLE_BEATS")
    beats, detected = [float(raw[0])], [True]
    cursor = 1
    while cursor < len(raw):
        period = _period(beats, detected, initial)
        expected = beats[-1] + period
        if expected > raw[-1] + period * 0.3:
            break
        lo, hi = np.searchsorted(raw, [expected - 0.2 * period, expected + 0.2 * period])
        lo = max(cursor, int(lo))
        if lo < hi:
            hit = lo + int(np.argmin(np.abs(raw[lo:hi] - expected)))
            beats.append(float(raw[hit]))
            detected.append(True)
            cursor = hit + 1
            continue
        # Keep a real timing discontinuity only if subsequent detections support
        # the new phase. A short off-beat excursion must not warp valid audio.
        lo, hi = np.searchsorted(raw, [expected - 0.6 * period, expected + 0.6 * period])
        candidates = range(max(cursor, int(lo)), int(hi))
        accepted = None
        for hit in sorted(candidates, key=lambda i: abs(raw[i] - expected)):
            future = raw[hit + 1:min(len(raw), hit + 34)]
            if len(future) < 8:
                continue
            new_error = np.abs((future - raw[hit] + period / 2) % period - period / 2)
            old_error = np.abs((future - expected + period / 2) % period - period / 2)
            next_two = raw[hit] + period * np.arange(1, 3)
            confirms = all(np.min(np.abs(future - t)) < 0.2 * period for t in next_two)
            if confirms and np.mean(new_error) + period * 0.06 < np.mean(old_error):
                accepted = hit
                break
        if accepted is not None:
            beats.append(float(raw[accepted]))
            detected.append(True)
            cursor = accepted + 1
        else:
            beats.append(expected)
            detected.append(False)
            cursor = max(cursor, int(np.searchsorted(raw, expected + period * 0.2)))
        if len(beats) > duration / 0.1 + 8:
            raise ValueError("BPM_FIX_UNRELIABLE_BEATS")
    return np.asarray(beats), np.asarray(detected), int(len(raw) - sum(detected))


def grid_indices(beats):
    intervals = np.diff(beats)
    indices = np.zeros(len(beats), dtype=int)
    for i, gap in enumerate(intervals):
        neighborhood = intervals[max(0, i - 8):i + 9]
        period = float(np.median(neighborhood))
        normal = neighborhood[(neighborhood > period * 0.6) & (neighborhood < period * 1.4)]
        if normal.size:
            period = float(np.median(normal))
        step = max(1, min(3, int(np.floor(gap / period + 0.5))))
        indices[i + 1] = indices[i] + step
    return indices


def _attack_strength(mono, sr, times):
    # Compare positive short-term energy rises, not the raw amplitude of a bass
    # waveform. Only consulted to distinguish a timing event from tracker jitter.
    frame = max(1, int(sr * 0.003))
    count = len(mono) // frame
    if count < 3:
        return np.zeros(len(times))
    levels = np.mean(np.abs(mono[:count * frame].reshape(count, frame)), axis=1)
    rise = np.maximum(0.0, levels - np.roll(levels, 2))
    result = []
    for t in times:
        center = int(t * sr / frame)
        section = rise[max(0, center - 3):min(count, center + 4)]
        result.append(float(np.max(section)) if section.size else 0.0)
    return np.asarray(result)


def smooth_beats(beats, detected, indices, mono=None, sr=44100):
    smooth = beats.copy()
    for i in range(len(beats)):
        lo, hi = max(0, i - 8), min(len(beats), i + 9)
        mask = detected[lo:hi].copy()
        if np.count_nonzero(mask) < 4:
            continue
        x, y = indices[lo:hi][mask], beats[lo:hi][mask]
        slope, intercept = _line(x, y)
        inliers = np.abs(y - (slope * x + intercept)) <= 0.025
        if np.count_nonzero(inliers) >= 4:
            slope, intercept = _line(x[inliers], y[inliers])
        predicted = slope * indices[i] + intercept
        if abs(beats[i] - predicted) > 0.025:
            if mono is None:
                continue
            measured_attack, line_attack = _attack_strength(mono, sr, [beats[i], predicted])
            if measured_attack > 1.5 * max(line_attack, 1e-9):
                continue
        smooth[i] = predicted
    # The first beat anchors the opening; never squeeze the lead-in to fit a
    # regression through the middle of a drifting song.
    smooth[0] = beats[0]
    if np.any(np.diff(smooth) <= 0):
        raise ValueError("BPM_FIX_NON_MONOTONIC_GRID")
    return smooth


def analyze_grid(raw, downbeats, duration, mono=None, sr=44100):
    beats, detected, ignored = walk_beats(raw, duration)
    indices = grid_indices(beats)
    if np.count_nonzero(detected) < 8:
        raise ValueError("BPM_FIX_NOT_ENOUGH_BEATS")
    period, _ = _line(indices[detected], beats[detected])
    bpm = 60.0 / period
    intervals = np.diff(beats)
    local = np.asarray([np.median(intervals[max(0, i - 8):i + 9]) for i in range(len(intervals))])
    regularity = float(np.mean(np.abs(intervals - local) <= local * 0.15))
    detected_fraction = float(np.mean(detected))
    coverage = float(min(1.0, (beats[-1] - beats[0] + period) / duration))
    confidence = min(regularity, detected_fraction, coverage)
    if not np.isfinite(bpm) or not 30 <= bpm <= 300:
        raise ValueError("BPM_FIX_LOW_CONFIDENCE")
    smoothed = smooth_beats(beats, detected, indices, mono, sr)
    return {
        "beats": beats, "detected": detected, "indices": indices, "smoothed": smoothed,
        "downbeats": np.asarray(downbeats, dtype=float), "bpm": bpm,
        "confidence": confidence, "ignored": ignored, "coverage": coverage,
        "filled": int(np.count_nonzero(~detected)), "regularity": regularity,
    }


def plan_correction(analysis, frames, sr, target_bpm=None, tempo_factor=1.0):
    source = analysis["smoothed"]
    indices = analysis["indices"]
    if tempo_factor not in (0.5, 1.0, 2.0):
        raise ValueError("BPM_FIX_INVALID_TARGET")
    bpm = float(target_bpm) if target_bpm is not None else float(np.floor(analysis["bpm"] * tempo_factor + 0.5))
    if not np.isfinite(bpm) or not 30 <= bpm <= 300:
        raise ValueError("BPM_FIX_INVALID_TARGET")
    period = 60.0 / bpm * tempo_factor
    targets = source[0] + (indices - indices[0]) * period
    selected = {0, len(source) - 1}
    downbeats = analysis["downbeats"]
    if len(downbeats):
        for t in downbeats:
            at = int(np.argmin(np.abs(analysis["beats"] - t)))
            if abs(analysis["beats"][at] - t) < 0.2:
                selected.add(at)
    else:
        selected.update(range(0, len(source), 4))
    # Add only genuine timing outliers; anchoring every 20 ms tracker frame
    # quantisation error would create audible wow on sustained tones.
    for _ in range(4):
        chosen = np.asarray(sorted(selected))
        mapped = np.interp(source, source[chosen], targets[chosen])
        missing = np.flatnonzero(np.abs(mapped - targets) > 0.025)
        if not len(missing):
            break
        selected.update(int(i) for i in missing)
    chosen = np.asarray(sorted(selected))
    from_frames = np.rint(source[chosen] * sr).astype(np.int64)
    to_frames = np.rint(targets[chosen] * sr).astype(np.int64)
    keep = (from_frames > 0) & (from_frames < frames) & (to_frames > 0)
    from_frames, to_frames = from_frames[keep], to_frames[keep]
    tail_ratio = period / float(np.median(np.diff(source)[-16:]))
    output_frames = int(round(to_frames[-1] + (frames - from_frames[-1]) * tail_ratio))
    from_frames = np.r_[0, from_frames, frames].astype(np.int64)
    to_frames = np.r_[0, to_frames, output_frames].astype(np.int64)
    if np.any(np.diff(from_frames) <= 0) or np.any(np.diff(to_frames) <= 0):
        raise ValueError("BPM_FIX_NON_MONOTONIC_MAP")
    ratios = np.diff(to_frames) / np.diff(from_frames)
    if np.any(ratios < 0.5) or np.any(ratios > 2.0):
        raise ValueError("BPM_FIX_EXTREME_STRETCH")
    return {
        "from": from_frames, "to": to_frames, "targetBpm": bpm,
        "gridOffsetSec": float(source[0]), "outputFrames": output_frames,
        "noticeableSegments": int(np.count_nonzero((ratios < 0.9) | (ratios > 1.15))),
    }


def verify_grid(raw, target_bpm, offset):
    beats = np.asarray(raw, dtype=float)
    if len(beats) < 8:
        raise ValueError("BPM_FIX_VERIFICATION_FAILED")
    period = 60.0 / target_bpm
    # Measure raw redetected beats, including outliers, so verification cannot
    # hide renderer errors by cleaning/replacing the evidence it evaluates.
    grid = np.rint((beats - offset) / period)
    residual = beats - (offset + grid * period)
    unique = np.r_[True, np.diff(grid) > 0]
    measured_period, _ = _line(grid[unique], beats[unique])
    detected_bpm = 60.0 / measured_period
    rms_ms = float(np.sqrt(np.mean(residual ** 2)) * 1000)
    off_grid = int(np.count_nonzero(np.abs(residual) > 0.07))
    bpm_error = abs(detected_bpm - target_bpm)
    return {
        "passed": bool(bpm_error <= 0.6 and rms_ms <= 14.0 and off_grid == 0),
        "detectedBpm": round(detected_bpm, 4), "bpmError": round(bpm_error, 4),
        "gridRmsMs": round(rms_ms, 3), "offGridBeats": off_grid,
    }
