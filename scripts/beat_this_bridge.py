import os
import contextlib
import json
import math
import statistics
import sys
from typing import Any

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_BEAT_THIS_EXTRA_SITE_DIRS = "FRKB_BEAT_THIS_EXTRA_SITE_DIRS"
ENV_BEAT_THIS_EXTRA_DLL_DIRS = "FRKB_BEAT_THIS_EXTRA_DLL_DIRS"
ENV_BEAT_THIS_CHECKPOINT = "FRKB_BEAT_THIS_CHECKPOINT"
ENV_BEAT_THIS_ANCHOR_TUNING_JSON = "FRKB_BEAT_THIS_ANCHOR_TUNING_JSON"
DEFAULT_BEAT_THIS_CHECKPOINT_RELATIVE_PATH = os.path.join("beat-this-checkpoints", "final0.ckpt")
_DLL_DIR_HANDLES: list[Any] = []
WINDOW_MIN_DURATION_SEC = 8.0


def _split_env_paths(env_name: str) -> list[str]:
    raw_value = str(os.environ.get(env_name) or "").strip()
    if not raw_value:
        return []
    return [part for part in raw_value.split(os.pathsep) if part]


def _bootstrap_extra_paths() -> None:
    if os.name == "nt" and hasattr(os, "add_dll_directory"):
        for dll_dir in _split_env_paths(ENV_BEAT_THIS_EXTRA_DLL_DIRS):
            try:
                if os.path.isdir(dll_dir):
                    _DLL_DIR_HANDLES.append(os.add_dll_directory(dll_dir))
            except Exception:
                continue

    for site_dir in _split_env_paths(ENV_BEAT_THIS_EXTRA_SITE_DIRS):
        if os.path.isdir(site_dir) and site_dir not in sys.path:
            sys.path.append(site_dir)


_bootstrap_extra_paths()

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.append(SCRIPT_DIR)

import numpy as np
import soxr
import torch
from beat_this_anchor_tuning_defaults import DEFAULT_ANCHOR_TUNING

import beat_this.inference as _beat_this_inference
from beat_this.inference import Audio2Beats, split_predict_aggregate
from beat_this.preprocessing import LogMelSpect
from beat_this_grid_solver import (
    build_attack_envelope as _build_attack_envelope,
    clamp01 as _clamp01,
    estimate_anchor_correction as _estimate_anchor_correction,
    estimate_grid_phase_correction as _estimate_grid_phase_correction,
    estimate_head_bootstrap_candidate as _estimate_head_bootstrap_candidate,
    estimate_lowband_firstbeat_offset as _estimate_lowband_firstbeat_offset,
    normalize_phase_ms as _normalize_phase_ms,
    phase_delta_ms as _phase_delta_ms,
    score_anchor_offset as _score_anchor_offset,
    should_block_ambiguous_positive_correction as _should_block_ambiguous_positive_correction,
    should_preserve_grid_solver_bpm as _should_preserve_grid_solver_bpm,
    stabilize_bpm_for_grid as _stabilize_bpm_for_grid,
)
from beat_this_candidate_solver import (
    build_grid_candidate as _build_grid_candidate,
    select_grid_candidate as _select_grid_candidate,
)
from beat_this_grid_rescue import (
    apply_half_double_bpm_rescue_to_result as _apply_half_double_bpm_rescue_to_result,
    apply_integer_bpm_rescue_to_result as _apply_integer_bpm_rescue_to_result,
    generate_octave_bpm_candidates as _generate_octave_bpm_candidates,
    solve_global_track_grid as _solve_global_track_grid,
)
from beat_this_full_logit_rescue import (
    apply_full_track_logit_rescue as _apply_full_track_logit_rescue,
)
from beat_this_phase_rescue import (
    apply_full_logit_head_zero_overrun_guard_to_result as _apply_full_logit_head_zero_overrun_guard_to_result,
    apply_phase_rescue_rules as _apply_phase_rescue_rules,
    apply_stream_start_frame_prezero_to_result as _apply_stream_start_frame_prezero_to_result,
    apply_window_phase_consensus as _apply_window_phase_consensus,
)
from beat_this_phase_arbitration import apply_final_phase_arbitration as _apply_final_phase_arbitration
from beat_this_bpm_metrics import estimate_bpm_drift_proxy as _estimate_bpm_drift_proxy
from beat_this_runtime_constant_grid import (
    try_solve_runtime_constant_grid_dp as _try_solve_runtime_constant_grid_dp,
)
from beat_this_window_selection import select_anchor_window_result as _select_anchor_window_result
from beat_this_dynamic_windows import handle_analyze_beat_windows_command

_ORIGINAL_BEAT_THIS_LOAD_MODEL = _beat_this_inference.load_model
_ORIGINAL_TORCH_AUTOCAST = torch.autocast


def _mps_safe_autocast(*args: Any, **kwargs: Any) -> Any:
    device_type = kwargs.get("device_type")
    if device_type is None and args:
        device_type = args[0]
    if str(device_type or "").strip().lower().startswith("mps"):
        return contextlib.nullcontext()
    return _ORIGINAL_TORCH_AUTOCAST(*args, **kwargs)


torch.autocast = _mps_safe_autocast


def _is_directml_device(device: Any) -> bool:
    normalized = str(device or "").strip().lower()
    return normalized == "directml" or normalized.startswith("privateuseone")


def _resolve_directml_device(device: Any) -> str:
    normalized = str(device or "").strip()
    if not _is_directml_device(normalized):
        return normalized

    try:
        import torch_directml
    except Exception as error:
        raise RuntimeError(f"DirectML device requested but torch_directml is unavailable: {error}") from error

    if normalized.lower() == "directml":
        directml_device = torch_directml.device()
        if not directml_device:
            raise RuntimeError("DirectML device requested but no torch_directml device is available")
        return str(directml_device)
    return normalized


def _load_model_with_directml_cpu_checkpoint(
    checkpoint_path: str | None = "final0",
    device: str | torch.device = "cpu",
) -> torch.nn.Module:
    resolved_device = _resolve_directml_device(device)
    if _is_directml_device(resolved_device):
        model = _ORIGINAL_BEAT_THIS_LOAD_MODEL(checkpoint_path, "cpu")
        return model.to(resolved_device).eval()
    return _ORIGINAL_BEAT_THIS_LOAD_MODEL(checkpoint_path, resolved_device)


_beat_this_inference.load_model = _load_model_with_directml_cpu_checkpoint


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def _read_exact(byte_length: int) -> bytes:
    remaining = max(0, int(byte_length))
    chunks: list[bytes] = []
    while remaining > 0:
        chunk = sys.stdin.buffer.read(remaining)
        if not chunk:
            raise RuntimeError(f"expected {byte_length} bytes of PCM data, got EOF")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _to_float_list(values: Any) -> list[float]:
    if values is None:
        return []
    if hasattr(values, "tolist"):
        values = values.tolist()
    result: list[float] = []
    for value in values:
        try:
            numeric = float(value)
        except Exception:
            continue
        if not math.isfinite(numeric) or numeric < 0.0:
            continue
        result.append(numeric)
    return result


def _derive_bpm(beats: list[float]) -> float | None:
    if len(beats) < 2:
        return None
    intervals = [
        current - previous
        for previous, current in zip(beats[:-1], beats[1:])
        if 0.18 <= current - previous <= 2.0
    ]
    if not intervals:
        return None

    if len(beats) >= 8:
        indices = list(range(len(beats)))
        mean_index = statistics.fmean(indices)
        mean_beat = statistics.fmean(beats)
        numerator = sum(
            (index - mean_index) * (beat - mean_beat)
            for index, beat in zip(indices, beats)
        )
        denominator = sum((index - mean_index) ** 2 for index in indices)
        beat_interval = numerator / denominator if denominator > 0 else statistics.median(intervals)
    else:
        beat_interval = statistics.median(intervals)

    if not math.isfinite(beat_interval) or beat_interval <= 0.0:
        return None
    bpm = 60.0 / beat_interval
    return bpm if math.isfinite(bpm) and bpm > 0.0 else None


def _resolve_float_config(config: dict[str, Any], key: str, minimum: float) -> float:
    try:
        value = float(config.get(key))
    except Exception:
        value = float(DEFAULT_ANCHOR_TUNING[key])
    if not math.isfinite(value):
        value = float(DEFAULT_ANCHOR_TUNING[key])
    return max(minimum, value)


def _resolve_int_config(config: dict[str, Any], key: str, minimum: int) -> int:
    try:
        value = int(round(float(config.get(key))))
    except Exception:
        value = int(DEFAULT_ANCHOR_TUNING[key])
    return max(minimum, value)


def _resolve_anchor_tuning() -> dict[str, Any]:
    payload = dict(DEFAULT_ANCHOR_TUNING)
    raw_value = str(os.environ.get(ENV_BEAT_THIS_ANCHOR_TUNING_JSON) or "").strip()
    if raw_value:
        try:
            parsed = json.loads(raw_value)
            if isinstance(parsed, dict):
                payload.update(parsed)
        except Exception:
            pass

    payload["focusMode"] = (
        "full" if str(payload.get("focusMode") or "").strip().lower() == "full" else "low"
    )
    payload["envelopeSampleRateLow"] = _resolve_int_config(payload, "envelopeSampleRateLow", 200)
    payload["envelopeSampleRateFull"] = _resolve_int_config(payload, "envelopeSampleRateFull", 400)
    payload["scoreWindowMs"] = _resolve_float_config(payload, "scoreWindowMs", 1.0)
    payload["bpmSnapIntegerThreshold"] = _resolve_float_config(payload, "bpmSnapIntegerThreshold", 0.0)
    payload["maxShiftSecCap"] = _resolve_float_config(payload, "maxShiftSecCap", 0.001)
    payload["maxShiftSecFloor"] = _resolve_float_config(payload, "maxShiftSecFloor", 0.001)
    payload["maxShiftIntervalRatio"] = _resolve_float_config(payload, "maxShiftIntervalRatio", 0.001)
    payload["stepMs"] = _resolve_float_config(payload, "stepMs", 0.5)
    payload["maxBeats"] = _resolve_int_config(payload, "maxBeats", 8)
    payload["backtrackThresholdRatio"] = _resolve_float_config(payload, "backtrackThresholdRatio", 0.001)
    payload["backtrackThresholdFloor"] = _resolve_float_config(payload, "backtrackThresholdFloor", 0.0001)
    payload["valleySearchBack"] = _resolve_int_config(payload, "valleySearchBack", 1)
    payload["valleySearchForward"] = _resolve_int_config(payload, "valleySearchForward", 1)
    payload["backtrackSafetyFrames"] = _resolve_int_config(payload, "backtrackSafetyFrames", 4)
    payload["backtrackDropRatio"] = _resolve_float_config(payload, "backtrackDropRatio", 0.0)
    payload["backtrackThresholdMultiplier"] = _resolve_float_config(
        payload, "backtrackThresholdMultiplier", 0.1
    )
    payload["localPeakMin"] = _resolve_float_config(payload, "localPeakMin", 0.001)
    payload["refineRadiusMs"] = _resolve_float_config(payload, "refineRadiusMs", 1.0)
    payload["confidenceFloor"] = _resolve_float_config(payload, "confidenceFloor", 0.0)
    payload["relativeGainScale"] = _resolve_float_config(payload, "relativeGainScale", 0.001)
    payload["scoreContrastScale"] = _resolve_float_config(payload, "scoreContrastScale", 0.001)
    payload["matchRatioCenter"] = _resolve_float_config(payload, "matchRatioCenter", 0.0)
    payload["matchRatioScale"] = _resolve_float_config(payload, "matchRatioScale", 0.001)
    payload["offsetMadCenterMs"] = _resolve_float_config(payload, "offsetMadCenterMs", 0.001)
    payload["offsetMadScaleMs"] = _resolve_float_config(payload, "offsetMadScaleMs", 0.001)
    payload["positiveShiftPolicy"] = (
        "allow" if str(payload.get("positiveShiftPolicy") or "").strip().lower() == "allow" else "zero"
    )
    payload["positiveMinRawFirstBeatMs"] = _resolve_float_config(payload, "positiveMinRawFirstBeatMs", 0.0)
    payload["positiveMinShiftMs"] = _resolve_float_config(payload, "positiveMinShiftMs", 0.0)
    payload["positiveMaxShiftMs"] = _resolve_float_config(payload, "positiveMaxShiftMs", 0.0)
    payload["positiveMatchRatioMin"] = _resolve_float_config(payload, "positiveMatchRatioMin", 0.0)
    payload["positiveOffsetMadMaxMs"] = _resolve_float_config(payload, "positiveOffsetMadMaxMs", 0.001)
    payload["positiveRelativeGainMin"] = _resolve_float_config(payload, "positiveRelativeGainMin", 0.0)
    payload["positiveScoreContrastMin"] = _resolve_float_config(payload, "positiveScoreContrastMin", 0.0)
    payload["positiveConfidenceMin"] = _resolve_float_config(payload, "positiveConfidenceMin", 0.0)
    payload["positiveAmbiguityGuardRawFirstBeatMinMs"] = _resolve_float_config(
        payload, "positiveAmbiguityGuardRawFirstBeatMinMs", 0.0
    )
    payload["positiveAmbiguityGuardMinCorrectionMs"] = _resolve_float_config(
        payload, "positiveAmbiguityGuardMinCorrectionMs", 0.0
    )
    payload["positiveAmbiguityGuardWideLeadMs"] = _resolve_float_config(
        payload, "positiveAmbiguityGuardWideLeadMs", 0.0
    )
    payload["positiveAmbiguityGuardWideScoreRatioMin"] = _resolve_float_config(
        payload, "positiveAmbiguityGuardWideScoreRatioMin", 1.0
    )
    payload["lowbandFallbackMinMatchRatio"] = _resolve_float_config(
        payload, "lowbandFallbackMinMatchRatio", 0.0
    )
    payload["lowbandFallbackMaxOffsetMadMs"] = _resolve_float_config(
        payload, "lowbandFallbackMaxOffsetMadMs", 0.0
    )
    payload["headBootstrapMinRawFirstBeatMs"] = _resolve_float_config(
        payload, "headBootstrapMinRawFirstBeatMs", 0.0
    )
    payload["headBootstrapMinShiftMs"] = _resolve_float_config(
        payload, "headBootstrapMinShiftMs", 0.0
    )
    payload["headBootstrapMaxShiftMs"] = _resolve_float_config(
        payload, "headBootstrapMaxShiftMs", 0.0
    )
    payload["headBootstrapMinPeak"] = _resolve_float_config(
        payload, "headBootstrapMinPeak", 0.0
    )
    payload["headBootstrapMinSupport"] = _resolve_int_config(
        payload, "headBootstrapMinSupport", 1
    )
    payload["negativeMinShiftMs"] = _resolve_float_config(payload, "negativeMinShiftMs", 0.0)
    payload["negativeMaxShiftMs"] = _resolve_float_config(payload, "negativeMaxShiftMs", 0.0)
    payload["negativeMatchRatioMin"] = _resolve_float_config(payload, "negativeMatchRatioMin", 0.0)
    payload["negativeOffsetMadMaxMs"] = _resolve_float_config(payload, "negativeOffsetMadMaxMs", 0.001)
    payload["negativeRelativeGainMin"] = _resolve_float_config(payload, "negativeRelativeGainMin", 0.0)
    payload["negativeScoreContrastMin"] = _resolve_float_config(payload, "negativeScoreContrastMin", 0.0)
    payload["negativeConfidenceMin"] = _resolve_float_config(payload, "negativeConfidenceMin", 0.0)
    payload["gridSolverPolicy"] = (
        "conservative"
        if str(payload.get("gridSolverPolicy") or "").strip().lower() == "conservative"
        else "off"
    )
    payload["gridSolverMinRawFirstBeatMs"] = _resolve_float_config(
        payload, "gridSolverMinRawFirstBeatMs", 0.0
    )
    payload["gridSolverMaxAnchorCorrectionMs"] = _resolve_float_config(
        payload, "gridSolverMaxAnchorCorrectionMs", 0.0
    )
    payload["gridSolverMinCorrectionMs"] = _resolve_float_config(
        payload, "gridSolverMinCorrectionMs", 0.0
    )
    payload["gridSolverMaxCorrectionMs"] = _resolve_float_config(
        payload, "gridSolverMaxCorrectionMs", 0.0
    )
    payload["gridSolverMinCorrectionGainMs"] = _resolve_float_config(
        payload, "gridSolverMinCorrectionGainMs", 0.0
    )
    payload["gridSolverMinRelativeGain"] = _resolve_float_config(
        payload, "gridSolverMinRelativeGain", 0.0
    )
    payload["gridSolverMinScoreContrast"] = _resolve_float_config(
        payload, "gridSolverMinScoreContrast", 0.0
    )
    payload["snapToZeroRawFirstBeatMaxMs"] = _resolve_float_config(payload, "snapToZeroRawFirstBeatMaxMs", 0.0)
    payload["snapToZeroCorrectedMaxMs"] = _resolve_float_config(payload, "snapToZeroCorrectedMaxMs", 0.0)
    payload["snapToZeroMinNegativeShiftMs"] = _resolve_float_config(payload, "snapToZeroMinNegativeShiftMs", 0.0)
    return payload


def _derive_interval(beats: list[float]) -> float | None:
    if len(beats) < 2:
        return None
    intervals = [
        current - previous
        for previous, current in zip(beats[:-1], beats[1:])
        if 0.18 <= current - previous <= 2.0
    ]
    if not intervals:
        return None
    return statistics.median(intervals)


def _derive_stability(events: list[float], target_interval: float, multiplier: float = 1.0) -> float:
    if len(events) < 3 or not math.isfinite(target_interval) or target_interval <= 0.0:
        return 0.0
    intervals = [
        current - previous
        for previous, current in zip(events[:-1], events[1:])
        if 0.18 <= current - previous <= 8.0
    ]
    if len(intervals) < 2:
        return 0.0
    expected = target_interval * multiplier
    deviations = [abs(interval - expected) / expected for interval in intervals if expected > 0]
    if not deviations:
        return 0.0
    mad = statistics.median(deviations)
    return _clamp01(1.0 - mad / 0.2)


def _derive_bar_beat_offset(beats: list[float], downbeats: list[float]) -> int:
    if not beats or not downbeats:
        return 0
    first_downbeat = downbeats[0]
    nearest_index = min(range(len(beats)), key=lambda index: abs(beats[index] - first_downbeat))
    if abs(beats[nearest_index] - first_downbeat) > 0.12:
        return 0
    return nearest_index % 32


def _decode_signal(pcm_bytes: bytes, channels: int) -> np.ndarray:
    if channels <= 0:
        raise RuntimeError("channels must be positive")
    signal = np.frombuffer(pcm_bytes, dtype="<f4")
    usable_samples = signal.size - (signal.size % channels)
    if usable_samples <= 0:
        raise RuntimeError("PCM data is empty")
    signal = signal[:usable_samples]
    if channels == 1:
        return signal.astype("float64", copy=False)
    return signal.reshape((-1, channels)).astype("float64", copy=False)


def _slice_signal_window(
    signal: np.ndarray,
    sample_rate: int,
    start_sec: float,
    duration_sec: float,
) -> tuple[np.ndarray, float]:
    total_frames = signal.shape[0]
    start_frame = max(0, int(max(0.0, start_sec) * sample_rate))
    duration_frames = max(1, int(max(0.0, duration_sec) * sample_rate))
    end_frame = min(total_frames, start_frame + duration_frames)
    actual_frames = max(0, end_frame - start_frame)
    if actual_frames <= 0:
        return signal[:0], 0.0
    return signal[start_frame:end_frame], actual_frames / sample_rate


def _derive_quality_metrics(
    beat_list: list[float],
    downbeat_list: list[float],
    beat_interval: float,
    duration_sec: float,
) -> dict[str, float]:
    expected_beat_count = duration_sec / beat_interval if beat_interval > 0 else 0.0
    expected_downbeat_count = expected_beat_count / 4.0 if expected_beat_count > 0 else 0.0
    beat_coverage_score = _clamp01(
        len(beat_list) / max(8.0, expected_beat_count * 0.85 if expected_beat_count > 0 else 8.0)
    )
    downbeat_coverage_score = _clamp01(
        len(downbeat_list)
        / max(2.0, expected_downbeat_count * 0.6 if expected_downbeat_count > 0 else 2.0)
    )
    beat_stability_score = _derive_stability(beat_list, beat_interval, 1.0)
    downbeat_stability_score = _derive_stability(downbeat_list, beat_interval, 4.0)
    quality_score = (
        beat_coverage_score * 0.4
        + beat_stability_score * 0.35
        + downbeat_coverage_score * 0.1
        + downbeat_stability_score * 0.15
    )
    return {
        "beatCoverageScore": round(beat_coverage_score, 6),
        "beatStabilityScore": round(beat_stability_score, 6),
        "downbeatCoverageScore": round(downbeat_coverage_score, 6),
        "downbeatStabilityScore": round(downbeat_stability_score, 6),
        "qualityScore": round(quality_score, 6),
    }


def _prepare_analysis_windows(
    predictor: Audio2Beats,
    cpu_spect: LogMelSpect | None,
    signal: np.ndarray,
    sample_rate: int,
    device: str,
    window_sec: float,
    max_scan_sec: float,
) -> list[dict[str, Any]]:
    total_duration_sec = signal.shape[0] / sample_rate if sample_rate > 0 else 0.0
    scan_limit_sec = min(total_duration_sec, max_scan_sec)
    tuning = _resolve_anchor_tuning()
    prepared_windows: list[dict[str, Any]] = []
    window_index = 0

    for window_start_sec in [offset for offset in range(0, int(scan_limit_sec), int(window_sec))]:
        remaining_sec = scan_limit_sec - float(window_start_sec)
        if remaining_sec < WINDOW_MIN_DURATION_SEC:
            break
        window_duration_sec = min(window_sec, remaining_sec)
        window_signal, actual_duration_sec = _slice_signal_window(
            signal,
            sample_rate,
            float(window_start_sec),
            window_duration_sec,
        )
        if actual_duration_sec < WINDOW_MIN_DURATION_SEC or window_signal.size == 0:
            break

        beats, downbeats = _predict_beats(predictor, window_signal, sample_rate, device, cpu_spect)
        beat_list = _to_float_list(beats)
        downbeat_list = _to_float_list(downbeats)
        raw_bpm = _derive_bpm(beat_list)
        raw_beat_interval = _derive_interval(beat_list)
        if raw_bpm is None or raw_beat_interval is None or not beat_list:
            window_index += 1
            continue

        bpm = _stabilize_bpm_for_grid(raw_bpm, tuning)
        beat_interval = 60.0 / bpm if bpm > 0 else raw_beat_interval
        quality_metrics = _derive_quality_metrics(
            beat_list,
            downbeat_list,
            beat_interval,
            actual_duration_sec,
        )
        prepared_windows.append(
            {
                "signal": window_signal,
                "beats": beat_list,
                "downbeats": downbeat_list,
                "rawBpm": round(raw_bpm, 6),
                "rawBeatInterval": round(raw_beat_interval, 6),
                "windowIndex": window_index,
                "windowStartSec": round(float(window_start_sec), 3),
                "windowDurationSec": round(actual_duration_sec, 3),
                "beatCount": len(beat_list),
                "downbeatCount": len(downbeat_list),
                **quality_metrics,
            }
        )
        window_index += 1

    return prepared_windows


def _finalize_prepared_window(
    prepared_window: dict[str, Any],
    sample_rate: int,
    tuning: dict[str, Any],
    *,
    force_legacy_anchor: bool,
) -> dict[str, Any]:
    beat_list = list(prepared_window["beats"])
    downbeat_list = list(prepared_window["downbeats"])
    raw_bpm = float(prepared_window["rawBpm"])
    raw_beat_interval = float(prepared_window["rawBeatInterval"])
    window_start_sec = float(prepared_window["windowStartSec"])
    window_duration_sec = float(prepared_window["windowDurationSec"])
    window_signal = prepared_window["signal"]
    bpm = _stabilize_bpm_for_grid(raw_bpm, tuning)
    beat_interval = 60.0 / bpm if bpm > 0 else raw_beat_interval
    raw_first_beat_ms_local = beat_list[0] * 1000.0

    if force_legacy_anchor:
        anchor_correction_ms = 0.0
        anchor_confidence_score = 0.0
        anchor_matched_beat_count = 0
        anchor_strategy = "legacy"
        corrected_first_beat_ms_local = raw_first_beat_ms_local
    else:
        anchor_tuning = dict(tuning)
        if raw_first_beat_ms_local <= 0.001 or raw_first_beat_ms_local >= 55.0:
            anchor_tuning["positiveMaxShiftMs"] = max(float(tuning["positiveMaxShiftMs"]), 10.0)
        (
            anchor_correction_ms,
            anchor_confidence_score,
            anchor_matched_beat_count,
        ) = _estimate_anchor_correction(
            window_signal,
            sample_rate,
            beat_list,
            raw_beat_interval,
            anchor_tuning,
        )
        grid_phase_correction = _estimate_grid_phase_correction(
            window_signal,
            sample_rate,
            beat_list,
            raw_beat_interval,
            anchor_correction_ms,
            tuning,
        )
        if grid_phase_correction is not None:
            (
                anchor_correction_ms,
                anchor_confidence_score,
                anchor_matched_beat_count,
            ) = grid_phase_correction
            anchor_strategy = "grid-solver"
            if _should_preserve_grid_solver_bpm(raw_bpm, bpm):
                bpm = round(raw_bpm, 6)
                beat_interval = 60.0 / bpm if bpm > 0 else raw_beat_interval
        else:
            anchor_strategy = "refined"
        if anchor_correction_ms > 0.0 and raw_first_beat_ms_local <= 0.001:
            head_lowband_offset = _estimate_lowband_firstbeat_offset(
                window_signal,
                sample_rate,
                beat_list,
                tuning,
            )
            head_lowband_match_ratio = (
                float(head_lowband_offset.get("matchRatio") or 0.0)
                if head_lowband_offset is not None
                else 0.0
            )
            head_lowband_offset_mad_ms = (
                float(head_lowband_offset.get("offsetMadMs") or 999.0)
                if head_lowband_offset is not None
                else 999.0
            )
            if (
                float(prepared_window.get("qualityScore") or 0.0) < 0.9
                or head_lowband_match_ratio < 0.9
                or head_lowband_offset_mad_ms > 4.5
            ):
                anchor_correction_ms = 0.0
                anchor_strategy = f"{anchor_strategy}-head-positive-guard"
        if (
            anchor_correction_ms > 0.0
            and _should_block_ambiguous_positive_correction(
                window_signal,
                sample_rate,
                beat_list,
                raw_beat_interval,
                raw_first_beat_ms_local,
                anchor_correction_ms,
                tuning,
            )
        ):
            anchor_correction_ms = 0.0
            anchor_strategy = f"{anchor_strategy}-positive-guard"
        if str(anchor_strategy).endswith("positive-guard"):
            lowband_offset = _estimate_lowband_firstbeat_offset(
                window_signal,
                sample_rate,
                beat_list,
                tuning,
            )
            if (
                lowband_offset is not None
                and float(lowband_offset.get("matchRatio") or 0.0)
                >= float(tuning["lowbandFallbackMinMatchRatio"])
                and float(lowband_offset.get("offsetMadMs") or 999.0)
                <= float(tuning["lowbandFallbackMaxOffsetMadMs"])
            ):
                anchor_correction_ms = float(lowband_offset["offsetMs"])
                anchor_strategy = f"{anchor_strategy}-lowband"
        if window_start_sec <= 0.001 and str(anchor_strategy).endswith("positive-guard-lowband"):
            head_bootstrap = _estimate_head_bootstrap_candidate(
                window_signal,
                sample_rate,
                raw_first_beat_ms_local,
                bpm,
                tuning,
            )
            if head_bootstrap is not None:
                anchor_correction_ms = float(head_bootstrap["shiftMs"])
                anchor_strategy = f"{anchor_strategy}-head-bootstrap"
        corrected_first_beat_ms_local = max(0.0, raw_first_beat_ms_local + anchor_correction_ms)
    beat_interval_ms = beat_interval * 1000.0 if beat_interval > 0 else 0.0
    absolute_first_beat_ms = corrected_first_beat_ms_local + window_start_sec * 1000.0
    absolute_raw_first_beat_ms = raw_first_beat_ms_local + window_start_sec * 1000.0
    normalized_first_beat_ms = (
        round(absolute_first_beat_ms % beat_interval_ms, 3) if beat_interval_ms > 0 else 0.0
    )
    normalized_raw_first_beat_ms = (
        round(absolute_raw_first_beat_ms % beat_interval_ms, 3) if beat_interval_ms > 0 else 0.0
    )
    normalized_beat_shift = 0
    if beat_interval_ms > 0.0:
        normalized_beat_shift = int(
            round((absolute_first_beat_ms - normalized_first_beat_ms) / beat_interval_ms)
        )
    return {
        "bpm": round(bpm, 6),
        "rawBpm": round(raw_bpm, 6),
        "firstBeatMs": normalized_first_beat_ms,
        "rawFirstBeatMs": normalized_raw_first_beat_ms,
        "absoluteFirstBeatMs": round(absolute_first_beat_ms, 3),
        "absoluteRawFirstBeatMs": round(absolute_raw_first_beat_ms, 3),
        "barBeatOffset": (_derive_bar_beat_offset(beat_list, downbeat_list) + normalized_beat_shift) % 32,
        "beatCount": int(prepared_window["beatCount"]),
        "downbeatCount": int(prepared_window["downbeatCount"]),
        "durationSec": round(window_duration_sec, 3),
        "beatIntervalSec": round(beat_interval, 6),
        "beatCoverageScore": float(prepared_window["beatCoverageScore"]),
        "beatStabilityScore": float(prepared_window["beatStabilityScore"]),
        "downbeatCoverageScore": float(prepared_window["downbeatCoverageScore"]),
        "downbeatStabilityScore": float(prepared_window["downbeatStabilityScore"]),
        "qualityScore": float(prepared_window["qualityScore"]),
        "anchorCorrectionMs": round(anchor_correction_ms, 3),
        "anchorConfidenceScore": round(anchor_confidence_score, 6),
        "anchorMatchedBeatCount": int(anchor_matched_beat_count),
        "anchorStrategy": anchor_strategy,
        "windowStartSec": round(window_start_sec, 3),
        "windowDurationSec": round(window_duration_sec, 3),
        "windowIndex": int(prepared_window["windowIndex"]),
    }


def _analyze_prepared_windows_to_track_result(
    prepared_windows: list[dict[str, Any]],
    signal: np.ndarray,
    sample_rate: int,
    duration_sec: float,
    tuning: dict[str, Any],
    source_file_path: str,
    *,
    force_legacy_anchor: bool,
    use_global_solver: bool,
    predictor: Audio2Beats | None = None,
    cpu_spect: LogMelSpect | None = None,
    device: str = "cpu",
    time_basis: dict[str, Any] | None = None,
    use_runtime_constant_grid: bool = False,
    min_bpm: float = 70.0,
    max_bpm: float = 200.0,
) -> dict[str, Any]:
    if not prepared_windows:
        raise RuntimeError(f"no valid beat-this result for {source_file_path}")

    finalized_results = [
        _finalize_prepared_window(
            prepared_window,
            sample_rate,
            tuning,
            force_legacy_anchor=force_legacy_anchor,
        )
        for prepared_window in prepared_windows
    ]

    candidates: list[dict[str, Any]] = []

    def _with_bpm_metrics(result: dict[str, Any]) -> dict[str, Any]:
        proxy = _estimate_bpm_drift_proxy(finalized_results, result)
        if not proxy:
            return result
        next_result = dict(result)
        next_result.update(proxy)
        return next_result

    def _add_candidate(source: str, result: dict[str, Any], details: dict[str, Any] | None = None) -> None:
        candidates.append(_build_grid_candidate(source, _with_bpm_metrics(result), details))

    def _changed(left: dict[str, Any], right: dict[str, Any]) -> bool:
        return right is not left or any(
            left.get(key) != right.get(key)
            for key in ("bpm", "firstBeatMs", "barBeatOffset", "anchorStrategy", "bpmRefinementStrategy")
        )

    anchor_window = _select_anchor_window_result(finalized_results)
    for item in finalized_results:
        _add_candidate("window", item, {"windowIndex": int(item.get("windowIndex") or 0)})
    _add_candidate("window-anchor", anchor_window)

    scan_duration_sec = max(
        (
            float(item.get("windowStartSec") or 0.0) + float(item.get("windowDurationSec") or 0.0)
            for item in finalized_results
        ),
        default=duration_sec,
    )
    global_result = None
    if use_global_solver and not force_legacy_anchor:
        global_result = _solve_global_track_grid(
            signal,
            sample_rate,
            min(duration_sec, scan_duration_sec),
            finalized_results,
            tuning,
            anchor_window=anchor_window,
        )
        if global_result:
            _add_candidate("global-solver", global_result)

    legacy_base = anchor_window
    if (
        global_result
        and float(anchor_window.get("anchorConfidenceScore") or 0.0) < 0.95
        and float(anchor_window.get("firstBeatMs") or 0.0) > 0.0
        and float(global_result.get("anchorConfidenceScore") or 0.0) >= 0.95
        and abs(float(global_result.get("qualityScore") or 0.0) - float(anchor_window.get("qualityScore") or 0.0)) <= 0.02
        and 4.0 <= abs(float(global_result.get("firstBeatMs") or 0.0) - float(anchor_window.get("firstBeatMs") or 0.0)) <= 8.0
    ):
        legacy_base = global_result
    _add_candidate("legacy-base", legacy_base)
    if not force_legacy_anchor:
        for octave_candidate in _generate_octave_bpm_candidates(signal, sample_rate, legacy_base, tuning):
            _add_candidate("bpm-octave", octave_candidate)

    next_result = legacy_base
    if not force_legacy_anchor:
        for source, transform in (
            (
                "legacy-half-double-bpm",
                lambda item: _apply_half_double_bpm_rescue_to_result(
                    signal, sample_rate, finalized_results, item, tuning
                ),
            ),
            (
                "legacy-integer-bpm",
                lambda item: _apply_integer_bpm_rescue_to_result(
                    signal, sample_rate, finalized_results, item, tuning
                ),
            ),
        ):
            transformed = transform(next_result)
            if _changed(next_result, transformed):
                next_result = transformed
                _add_candidate(source, next_result)

        next_result = _with_bpm_metrics(next_result)
        transformed = _apply_phase_rescue_rules(
            prepared_windows,
            finalized_results,
            next_result,
            sample_rate,
            tuning,
            time_basis=time_basis,
        )
        if _changed(next_result, transformed):
            next_result = transformed
            _add_candidate("legacy-phase-rescue", next_result)
        transformed = _apply_window_phase_consensus(finalized_results, next_result)
        if _changed(next_result, transformed):
            next_result = transformed
            _add_candidate("legacy-window-phase-consensus", next_result)

    next_result = _with_bpm_metrics(next_result)
    if not force_legacy_anchor and predictor is not None:
        transformed = _apply_full_track_logit_rescue(
            predictor,
            cpu_spect,
            signal,
            sample_rate,
            device,
            next_result,
            tuning,
        )
        if _changed(next_result, transformed):
            next_result = transformed
            _add_candidate("full-logit", next_result)
        transformed = _apply_full_logit_head_zero_overrun_guard_to_result(
            next_result,
            time_basis=time_basis,
        )
        if _changed(next_result, transformed):
            next_result = transformed
            _add_candidate("full-logit-head-zero", next_result)
        transformed = _apply_stream_start_frame_prezero_to_result(
            next_result,
            time_basis=time_basis,
        )
        if _changed(next_result, transformed):
            next_result = transformed
            _add_candidate("stream-start-time-basis", next_result)
        transformed = _apply_integer_bpm_rescue_to_result(
            signal,
            sample_rate,
            finalized_results,
            next_result,
            tuning,
        )
        if _changed(next_result, transformed):
            next_result = transformed
            _add_candidate("post-logit-integer-bpm", next_result)

    next_result = _with_bpm_metrics(next_result)
    transformed = _apply_final_phase_arbitration(finalized_results, next_result, time_basis=time_basis)
    if _changed(next_result, transformed):
        next_result = transformed
        _add_candidate("final-phase-arbitration", next_result)
    _add_candidate("legacy-final", next_result)
    selected_result = _select_grid_candidate(
        candidates,
        finalized_results,
        signal=signal,
        sample_rate=sample_rate,
        tuning=tuning,
    )
    if use_runtime_constant_grid and not force_legacy_anchor and predictor is not None:
        constant_grid_result = _try_solve_runtime_constant_grid_dp(
            prepared_windows=prepared_windows,
            signal=signal,
            sample_rate=sample_rate,
            duration_sec=duration_sec,
            tuning=tuning,
            legacy_result=selected_result,
            predictor=predictor,
            cpu_spect=cpu_spect,
            device=device,
            time_basis=time_basis,
            min_bpm=min_bpm,
            max_bpm=max_bpm,
        )
        if constant_grid_result is not None:
            return constant_grid_result
    return selected_result


def _to_public_downbeat_result(result: dict[str, Any]) -> dict[str, Any]:
    next_result = dict(result)
    raw_offset = next_result.pop("downbeatBeatOffset", next_result.pop("barBeatOffset", 0))
    try:
        downbeat_beat_offset = int(round(float(raw_offset))) % 4
    except Exception:
        downbeat_beat_offset = 0
    next_result["downbeatBeatOffset"] = downbeat_beat_offset
    return next_result

def _uses_accelerated_device(device: str) -> bool:
    normalized = str(device or "").strip().lower()
    return normalized not in {"", "cpu"}


def _predict_beats_with_accelerated_device(
    predictor: Audio2Beats,
    cpu_spect: LogMelSpect,
    signal: np.ndarray,
    sample_rate: int,
) -> tuple[Any, Any]:
    if signal.ndim == 2:
        signal = signal.mean(1)
    elif signal.ndim != 1:
        raise RuntimeError(f"expected mono/stereo signal, got shape {signal.shape}")

    if sample_rate != 22050:
        signal = soxr.resample(signal, in_rate=sample_rate, out_rate=22050)

    signal_tensor = torch.tensor(signal, dtype=torch.float32, device="cpu")
    spect = cpu_spect(signal_tensor).detach().to(predictor.device)

    with torch.no_grad():
        model_prediction = split_predict_aggregate(
            spect=spect,
            chunk_size=1500,
            border_size=6,
            overlap_mode="keep_first",
            model=predictor.model,
        )
        beat_logits = model_prediction["beat"].float()
        downbeat_logits = model_prediction["downbeat"].float()

    return predictor.frames2beats(beat_logits, downbeat_logits)


def _predict_beats(
    predictor: Audio2Beats,
    signal: np.ndarray,
    sample_rate: int,
    device: str,
    cpu_spect: LogMelSpect | None,
) -> tuple[Any, Any]:
    if cpu_spect is None or not _uses_accelerated_device(device):
        return predictor(signal, sample_rate)
    return _predict_beats_with_accelerated_device(predictor, cpu_spect, signal, sample_rate)


def _resolve_checkpoint_path() -> str:
    env_checkpoint = str(os.environ.get(ENV_BEAT_THIS_CHECKPOINT) or "").strip()
    if env_checkpoint and os.path.isfile(env_checkpoint):
        return env_checkpoint

    executable_dir = os.path.dirname(os.path.abspath(sys.executable))
    runtime_dir = executable_dir
    if os.path.basename(executable_dir).lower() == "scripts":
        runtime_dir = os.path.dirname(executable_dir)
    bundled_checkpoint = os.path.join(runtime_dir, DEFAULT_BEAT_THIS_CHECKPOINT_RELATIVE_PATH)
    if os.path.isfile(bundled_checkpoint):
        return bundled_checkpoint
    return "final0"


def serve(device: str, dbn: bool) -> int:
    predictor = Audio2Beats(checkpoint_path=_resolve_checkpoint_path(), device=device, dbn=dbn)
    cpu_spect = LogMelSpect(device="cpu") if _uses_accelerated_device(device) else None
    _emit({"type": "ready"})

    while True:
        header_line = sys.stdin.buffer.readline()
        if not header_line:
            return 0

        try:
            header = json.loads(header_line.decode("utf-8"))
        except Exception as error:
            _emit({"type": "fatal", "error": f"invalid header json: {error}"})
            return 1

        command = str(header.get("type") or "").strip()
        request_id = str(header.get("requestId") or "").strip()

        if command == "shutdown":
            _emit({"type": "shutdown", "requestId": request_id})
            return 0

        if command == "analyze_beat_windows":
            if not handle_analyze_beat_windows_command(
                header,
                request_id,
                read_exact=_read_exact,
                decode_signal=_decode_signal,
                predict_beats=lambda window_signal, sample_rate: _predict_beats(
                    predictor, window_signal, sample_rate, device, cpu_spect
                ),
                emit=_emit,
            ):
                # Malformed PCM framing cannot be resynchronised; never parse
                # the remaining binary audio as the next JSON header.
                return 1
            continue

        if command != "analyze_pcm":
            _emit(
                {
                    "type": "error",
                    "requestId": request_id,
                    "error": f"unsupported command: {command or '<empty>'}",
                }
            )
            continue

        try:
            sample_rate = int(header.get("sampleRate") or 0)
            channels = int(header.get("channels") or 0)
            byte_length = int(header.get("byteLength") or 0)
            source_file_path = str(header.get("sourceFilePath") or "").strip()
            time_basis = header.get("timeBasis") if isinstance(header.get("timeBasis"), dict) else None
            window_sec = max(1.0, float(header.get("windowSec") or 30.0))
            max_scan_sec = max(window_sec, float(header.get("maxScanSec") or 120.0))
            min_bpm = max(1.0, float(header.get("minBpm") or 70.0))
            max_bpm = max(min_bpm, float(header.get("maxBpm") or 200.0))
            if sample_rate <= 0:
                raise RuntimeError("sampleRate must be positive")
            if channels <= 0:
                raise RuntimeError("channels must be positive")
            if byte_length <= 0:
                raise RuntimeError("byteLength must be positive")

            pcm_bytes = _read_exact(byte_length)
            signal = _decode_signal(pcm_bytes, channels)
            duration_sec = signal.shape[0] / float(sample_rate) if sample_rate > 0 else 0.0
            tuning = _resolve_anchor_tuning()
            prepared_windows = _prepare_analysis_windows(
                predictor,
                cpu_spect,
                signal,
                sample_rate,
                device,
                window_sec,
                max_scan_sec,
            )
            result = _analyze_prepared_windows_to_track_result(
                prepared_windows,
                signal,
                sample_rate,
                min(duration_sec, max_scan_sec),
                tuning,
                source_file_path,
                force_legacy_anchor=False,
                use_global_solver=True,
                predictor=predictor,
                cpu_spect=cpu_spect,
                device=device,
                time_basis=time_basis,
                use_runtime_constant_grid=str(tuning.get("gridSolverPolicy") or "") != "off",
                min_bpm=min_bpm,
                max_bpm=max_bpm,
            )

            result_bpm = float(result.get("bpm") or 0.0)
            if not (min_bpm <= result_bpm <= max_bpm):
                raise RuntimeError(
                    f"analyzed BPM {result_bpm:.6f} is outside configured range "
                    f"{min_bpm:.6f}-{max_bpm:.6f}"
                )

            _emit(
                {
                    "type": "result",
                    "requestId": request_id,
                    "result": _to_public_downbeat_result(result),
                }
            )
        except Exception as error:
            _emit({"type": "error", "requestId": request_id, "error": str(error)})


def main() -> int:
    args = sys.argv[1:]
    if args and args[0] == "--serve":
        device = args[1] if len(args) >= 2 and args[1].strip() else "cpu"
        dbn = len(args) >= 3 and args[2].strip().lower() in {"1", "true", "yes", "on"}
        return serve(device=device, dbn=dbn)

    _emit({"type": "fatal", "error": "bridge only supports --serve mode"})
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
