"""Sparse time-map corners placed near attacks without quantising the audio.

The original map remains the timing authority. Moving a corner samples that
map at the attack time; it never assigns the attack an integer beat number.
Both forward and inverse map deviation are bounded over every linear segment.
"""

import numpy as np

MAP_TOLERANCE_SEC = 0.005
TRANSIENT_SEARCH_SEC = 0.050


def transient_times(samples, sr):
    import soxr
    from scipy.signal import find_peaks

    audio = np.asarray(samples, dtype=np.float32)
    if audio.ndim == 1:
        audio = audio[:, None]
    if audio.ndim != 2 or not len(audio) or sr <= 0 or not np.all(np.isfinite(audio)):
        raise ValueError("BPM_FIX_INVALID_AUDIO")
    peak = float(np.max(np.abs(audio)))
    if peak <= 1e-9:
        return np.empty(0)
    rate = min(sr, 8000)
    if rate != sr:
        audio = soxr.resample(audio, sr, rate)
    audio = audio / peak
    hop = max(1, round(rate * 0.0025))
    window_size = round(rate * 0.064)
    window = np.hanning(window_size)
    padded = np.pad(audio, ((window_size // 2, window_size // 2), (0, 0)))
    windows = np.lib.stride_tricks.sliding_window_view(padded, window_size, axis=0)[::hop]
    flux = np.zeros(len(windows))
    previous = np.zeros((audio.shape[1], window_size // 2 + 1))
    # Bound temporary FFT allocations, including for long/high-rate material.
    for start in range(0, len(windows), 1024):
        spectrum = np.abs(np.fft.rfft(windows[start:start + 1024] * window, axis=-1))
        spectrum = np.log1p(spectrum / np.sum(window) * 100)
        difference = np.diff(spectrum, axis=0, prepend=previous[None])
        flux[start:start + len(spectrum)] = np.maximum(difference, 0).sum(axis=(1, 2))
        previous = spectrum[-1]
    median = float(np.median(flux))
    mad = float(np.median(np.abs(flux - median)))
    threshold = max(median + 6 * mad, float(np.max(flux)) * 0.05, 1e-8)
    peaks, _ = find_peaks(flux, height=threshold, prominence=threshold / 2,
                         distance=max(1, round(rate / hop / 15)))
    count = len(audio) // hop
    if not count:
        return np.empty(0)
    # Spectral flux distinguishes attacks from carrier oscillations; the
    # channel-energy rise localises them without cancelling opposite phases.
    level = np.sqrt(np.mean(audio[:count * hop].reshape(count, hop, -1) ** 2, axis=(1, 2)))
    rise = np.maximum(np.diff(level, prepend=0), 0)
    radius = window_size // (2 * hop)
    candidates = []
    for peak_index in peaks:
        lo, hi = max(0, peak_index - radius), min(count, peak_index + radius + 1)
        if hi <= lo:
            continue
        index = lo + int(np.argmax(rise[lo:hi]))
        if rise[index] > 1e-8:
            candidates.append((index, float(flux[peak_index])))
    selected = []
    blocked = np.zeros(count, dtype=bool)
    separation = max(1, int(np.ceil(rate / hop / 15)))
    for index, strength in sorted(candidates, key=lambda item: -item[1]):
        if blocked[index]:
            continue
        selected.append(index)
        blocked[max(0, index - separation + 1):min(count, index + separation)] = True
    return np.asarray(sorted(selected), dtype=float) * hop / rate


def _map_error(source, target, reference_source, reference_target):
    positions = np.union1d(source, reference_source)
    forward = np.max(np.abs(np.interp(positions, source, target) -
                            np.interp(positions, reference_source, reference_target)))
    positions = np.union1d(target, reference_target)
    inverse = np.max(np.abs(np.interp(positions, target, source) -
                            np.interp(positions, reference_target, reference_source)))
    return max(float(forward), float(inverse))


def align_time_map(plan, sr, transients):
    source = np.asarray(plan["from"], dtype=float)
    target = np.asarray(plan["to"], dtype=float)
    attacks = np.asarray(transients, dtype=float)
    if (not np.isfinite(sr) or sr <= 0 or source.ndim != 1 or target.ndim != 1 or
            attacks.ndim != 1 or len(source) < 2 or len(source) != len(target) or
            not np.all(np.isfinite(source)) or not np.all(np.isfinite(target)) or
            not np.all(np.isfinite(attacks)) or source[0] != 0 or target[0] != 0 or
            np.any(source != np.rint(source)) or np.any(target != np.rint(target)) or
            source[-1] >= 2 ** 32 or target[-1] >= 2 ** 32 or
            np.any(np.diff(source) <= 0) or np.any(np.diff(target) <= 0)):
        raise ValueError("BPM_FIX_NON_MONOTONIC_MAP")
    ratios = np.diff(target) / np.diff(source)
    if np.any((ratios < 0.5) | (ratios > 2)):
        raise ValueError("BPM_FIX_UNSAFE_STRETCH_RATIO")
    source, target = source.astype(np.int64), target.astype(np.int64)
    attacks = attacks[(attacks >= 0) & (attacks <= source[-1] / sr)]
    attacks = np.unique(np.rint(attacks * sr).astype(np.int64))
    tolerance = sr * MAP_TOLERANCE_SEC
    # Retain the lead-in and tail joins as well as exact file endpoints.
    retained = {0, 1, len(source) - 2, len(source) - 1}
    edges = sorted(retained)
    pending = list(zip(edges[:-1], edges[1:]))
    while pending:
        lo, hi = pending.pop()
        if hi - lo < 2:
            continue
        section = slice(lo + 1, hi)
        forward = np.abs(target[section] - np.interp(source[section], source[[lo, hi]],
                                                   target[[lo, hi]]))
        inverse = np.abs(source[section] - np.interp(target[section], target[[lo, hi]],
                                                   source[[lo, hi]]))
        errors = np.maximum(forward, inverse)
        if float(np.max(errors)) > tolerance:
            split = lo + 1 + int(np.argmax(errors))
            retained.add(split)
            pending.extend(((lo, split), (split, hi)))
    indices = np.asarray(sorted(retained))
    revised_source, revised_target = source[indices].copy(), target[indices].copy()
    used = set()
    moved = 0
    for i in range(2, len(indices) - 2):
        at = revised_source[i]
        lo = np.searchsorted(attacks, at - sr * TRANSIENT_SEARCH_SEC, side="right")
        hi = np.searchsorted(attacks, at + sr * TRANSIENT_SEARCH_SEC, side="left")
        candidates = sorted(attacks[lo:hi], key=lambda value: abs(int(value) - at))
        for attack in candidates:
            attack = int(attack)
            if attack in used or not revised_source[i - 1] < attack < revised_source[i + 1]:
                continue
            destination = round(float(np.interp(attack, source, target)))
            if not revised_target[i - 1] < destination < revised_target[i + 1]:
                continue
            previous_source, previous_target = revised_source[i], revised_target[i]
            revised_source[i], revised_target[i] = attack, destination
            ratios = np.diff(revised_target[i - 1:i + 2]) / np.diff(revised_source[i - 1:i + 2])
            if (np.all((ratios >= 0.5) & (ratios <= 2)) and
                    _map_error(revised_source, revised_target, source, target) <= tolerance):
                used.add(attack)
                moved += int(attack != previous_source)
                break
            revised_source[i], revised_target[i] = previous_source, previous_target
    return {
        **plan, "from": revised_source, "to": revised_target,
        "anchorsBeforeRefinement": len(source), "transientAlignedAnchors": moved,
        "timeMapDeviationMs": _map_error(revised_source, revised_target, source, target) / sr * 1000,
        "noticeableSegments": int(np.count_nonzero(
            (np.diff(revised_target) / np.diff(revised_source) < 0.9) |
            (np.diff(revised_target) / np.diff(revised_source) > 1.15))),
    }


def refine_time_map(plan, samples, sr):
    return align_time_map(plan, sr, transient_times(samples, sr))
