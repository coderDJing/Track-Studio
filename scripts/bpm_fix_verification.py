"""Measure rendered beat positions by matching the source audio to the output.

Re-running a beat model can change metrical interpretation after stretching.
Local spectral matching instead follows the same musical event through the
render. Matches are measured, never snapped to the requested beat grid.
"""
import numpy as np


def audio_features(audio, sr):
    import soxr

    signal = np.asarray(audio, dtype=np.float32)
    if signal.ndim == 1:
        signal = signal[:, None]
    if sr != 8000:
        signal = soxr.resample(signal, sr, 8000)
    window_size, hop = 256, 40
    padded = np.pad(signal, ((window_size // 2, window_size // 2), (0, 0)))
    windows = np.lib.stride_tricks.sliding_window_view(padded, window_size, axis=0)[::hop]
    window = np.hanning(window_size)
    frequency = np.fft.rfftfreq(window_size, 1 / 8000)
    edges = (0, 125, 250, 500, 1000, 2000, 4001)
    bands = [(frequency >= lo) & (frequency < hi) for lo, hi in zip(edges, edges[1:])]
    features = np.empty((len(windows), len(bands)))
    for start in range(0, len(windows), 1024):
        spectrum = np.abs(np.fft.rfft(windows[start:start + 1024] * window, axis=-1)) ** 2
        # Channel power keeps opposite-phase stereo attacks intact.
        values = np.column_stack([np.sqrt(np.mean(spectrum[:, :, band], axis=(1, 2)))
                                  / window.sum() for band in bands])
        features[start:start + len(values)] = np.log1p(values * 100)
    return np.arange(len(features)) * hop / 8000, features


def match_audio_beats(source_features, output_features, analysis, plan, sr):
    t, source = source_features
    u, output = output_features
    a, b = np.asarray(plan['from']) / sr, np.asarray(plan['to']) / sr
    beats = np.asarray(analysis['beats'])
    detected = np.asarray(analysis['detected'], dtype=bool)
    expected = np.interp(beats, a, b)
    offsets = np.arange(-0.3, 0.301, 0.005)
    search = np.arange(-0.15, 0.151, 0.005)
    measured, indices, correlations = [], [], []
    eligible = 0
    for at in np.flatnonzero(detected):
        center = expected[at]
        if center < 0.5 or center > u[-1] - 0.5:
            continue
        eligible += 1
        source_times = np.interp(center + offsets, b, a)
        template = np.column_stack([np.interp(source_times, t, source[:, k]) for k in range(6)])
        template -= template.mean(axis=0)
        norm = np.linalg.norm(template)
        if norm < 1e-5:
            continue
        candidates = np.stack([np.column_stack([
            np.interp(center + offsets + shift, u, output[:, k]) for k in range(6)
        ]) for shift in search])
        candidates -= candidates.mean(axis=1, keepdims=True)
        score = (candidates * template).sum(axis=(1, 2)) / np.maximum(
            1e-10, norm * np.sqrt((candidates ** 2).sum(axis=(1, 2))))
        best = int(np.argmax(score))
        # A weak/ambiguous match is missing evidence, never a zero-error beat.
        if score[best] < 0.8 or best in (0, len(search) - 1):
            continue
        distant = np.abs(search - search[best]) >= 0.04
        if score[best] - np.max(score[distant]) < 0.03:
            continue
        denominator = score[best - 1] - 2 * score[best] + score[best + 1]
        delta = search[best]
        if denominator < 0:
            delta += 0.005 * 0.5 * (score[best - 1] - score[best + 1]) / denominator
        measured.append(center + delta)
        indices.append(at)
        correlations.append(float(score[best]))
    return np.asarray(measured), np.asarray(indices, dtype=int), eligible, correlations


def verify_audio(source_features, output_features, analysis, plan, sr, tempo_factor=1.0):
    from bpm_fix_grid import MAX_VERIFICATION_BPM_ERROR, MAX_VERIFICATION_RMS_MS, _line

    measured, at, eligible, correlations = match_audio_beats(
        source_features, output_features, analysis, plan, sr)
    coverage = len(measured) / max(1, eligible)
    detected = np.asarray(analysis['detected'], dtype=bool)
    source_support = float(np.mean(detected))
    # Check temporal coverage too: a good opening cannot validate an unmatched
    # middle/end. Sparse source detections cannot authorize an invented grid.
    bins = np.minimum(7, np.arange(len(detected)) * 8 // len(detected))
    matched_bins = np.bincount(bins[at], minlength=8)
    real_bins = np.bincount(bins[detected], minlength=8)
    local_support = matched_bins / np.maximum(1, real_bins)
    supported = (len(measured) >= 16 and coverage >= 0.9 and source_support >= 0.8 and
                 analysis['coverage'] >= 0.8 and np.all(local_support >= 0.7) and
                 abs(output_features[0][-1] - plan['outputFrames'] / sr) <= 0.1)
    if len(measured) < 8:
        return {'passed': False, 'method': 'audio-match', 'matchedBeats': len(measured),
                'matchCoverage': coverage, 'sourceSupport': source_support,
                'reasons': ['insufficient_audio_matches']}
    grid = (np.asarray(analysis['indices'])[at] - analysis['indices'][0]) * tempo_factor
    expected = plan['gridOffsetSec'] + grid * 60 / plan['targetBpm']
    errors = measured - expected
    # Account for constant codec/renderer latency; retain all local errors.
    phase = float(np.median(errors))
    residual = errors - phase
    period, _ = _line(grid, measured)
    bpm = 60 / period
    rms = float(np.sqrt(np.mean(residual ** 2)) * 1000)
    error = abs(bpm - plan['targetBpm'])
    reasons = []
    if not supported:
        reasons.append('insufficient_audio_matches')
    if error > MAX_VERIFICATION_BPM_ERROR:
        reasons.append('bpm_error')
    if rms > MAX_VERIFICATION_RMS_MS:
        reasons.append('grid_rms')
    return {'passed': not reasons, 'method': 'audio-match', 'detectedBpm': round(bpm, 4),
            'bpmError': round(error, 4), 'gridRmsMs': round(rms, 3),
            'offGridBeats': int(np.count_nonzero(abs(residual) > 0.070)),
            'phaseShiftMs': round(phase * 1000, 3), 'matchedBeats': len(measured),
            'matchCoverage': coverage, 'sourceSupport': source_support,
            'minLocalCoverage': float(np.min(local_support)),
            'medianCorrelation': float(np.median(correlations)), 'reasons': reasons}
