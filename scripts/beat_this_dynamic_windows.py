"""Stateless dynamic beat-window protocol for the Beat This! bridge.

The module only owns protocol parsing, per-window inference dispatch and evidence
validation.  It never keeps cross-request state and never runs the fixed-grid
global arbitration used by ``analyze_pcm``.
"""

from __future__ import annotations

import json
import math
import numbers
import sys
from typing import Any, Callable

PROTOCOL_VERSION = 1
COMMAND_TYPE = "analyze_beat_windows"
RESULT_TYPE = "beat-windows-result"

MIN_WINDOW_DURATION_SEC = 8.0
MAX_WINDOWS_PER_REQUEST = 2048
MAX_BEATS_PER_WINDOW = 2048
MAX_DOWNBEATS_PER_WINDOW = 512
MAX_REQUEST_ID_LENGTH = 128
MAX_WINDOW_ID_LENGTH = 128
MAX_PCM_BYTES = 1024 * 1024 * 1024
MAX_RESPONSE_JSON_BYTES = 16 * 1024 * 1024
MIN_SAMPLE_RATE = 8000
MAX_SAMPLE_RATE = 384000
MAX_CHANNELS = 8
BYTES_PER_SAMPLE = 4

BEAT_EDGE_TOLERANCE_SEC = 0.05
# 默认值与 TS policy 的 downbeatMatchToleranceSec 保持一致；请求可显式覆盖，
# 由 TS 把同一 policy 值传给 Python，避免两套容差无理由分叉。
DOWNBEAT_MATCH_TOLERANCE_SEC = 0.03
MAX_DOWNBEAT_TOLERANCE_SEC = 0.2
WINDOW_SPAN_TOLERANCE_SEC = 0.001
PCM_DURATION_TOLERANCE_SEC = 0.05


class BeatWindowProtocolError(ValueError):
    """Raised when a dynamic window request or its evidence is malformed."""


def _require_number(value: Any, field: str, *, minimum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, numbers.Real):
        raise BeatWindowProtocolError(f"{field} must be a finite number")
    numeric = float(value)
    if not math.isfinite(numeric):
        raise BeatWindowProtocolError(f"{field} must be a finite number")
    if minimum is not None and numeric < minimum:
        raise BeatWindowProtocolError(f"{field} must be >= {minimum}")
    return numeric


def _require_int(value: Any, field: str, *, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise BeatWindowProtocolError(f"{field} must be an integer")
    if value < minimum or value > maximum:
        raise BeatWindowProtocolError(f"{field} must be within {minimum}-{maximum}")
    return value


def _require_text(value: Any, field: str, *, max_length: int) -> str:
    if not isinstance(value, str):
        raise BeatWindowProtocolError(f"{field} must be a string")
    normalized = value.strip()
    if not normalized:
        raise BeatWindowProtocolError(f"{field} must not be empty")
    if len(normalized) > max_length:
        raise BeatWindowProtocolError(f"{field} is too long")
    return normalized


def resolve_declared_byte_length(header: dict[str, Any]) -> int:
    """Return a safely drainable frame-aligned byteLength, else 0.

    When this returns 0 the stdin stream cannot be re-synchronised reliably and
    the session must terminate instead of interpreting binary PCM as JSON.
    """

    try:
        raw_length = header.get("byteLength")
        raw_channels = header.get("channels")
    except AttributeError:
        return 0
    if isinstance(raw_length, bool) or not isinstance(raw_length, int):
        return 0
    if isinstance(raw_channels, bool) or not isinstance(raw_channels, int):
        return 0
    if raw_channels < 1 or raw_channels > MAX_CHANNELS:
        return 0
    if raw_length <= 0 or raw_length > MAX_PCM_BYTES:
        return 0
    if raw_length % (raw_channels * BYTES_PER_SAMPLE) != 0:
        return 0
    return raw_length


def parse_beat_windows_request(header: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(header, dict):
        raise BeatWindowProtocolError("header must be a JSON object")
    if header.get("type") != COMMAND_TYPE:
        raise BeatWindowProtocolError(f"unexpected command type: {header.get('type')!r}")

    protocol_version = header.get("protocolVersion")
    if (
        isinstance(protocol_version, bool)
        or not isinstance(protocol_version, int)
        or protocol_version != PROTOCOL_VERSION
    ):
        raise BeatWindowProtocolError(
            f"unsupported protocolVersion: {protocol_version!r} (expected integer {PROTOCOL_VERSION})"
        )

    request_id = _require_text(
        header.get("requestId"), "requestId", max_length=MAX_REQUEST_ID_LENGTH
    )
    sample_rate = _require_int(
        header.get("sampleRate"),
        "sampleRate",
        minimum=MIN_SAMPLE_RATE,
        maximum=MAX_SAMPLE_RATE,
    )
    channels = _require_int(header.get("channels"), "channels", minimum=1, maximum=MAX_CHANNELS)
    byte_length = _require_int(
        header.get("byteLength"), "byteLength", minimum=BYTES_PER_SAMPLE, maximum=MAX_PCM_BYTES
    )
    frame_bytes = channels * BYTES_PER_SAMPLE
    if byte_length % frame_bytes != 0:
        raise BeatWindowProtocolError(
            f"byteLength must be frame-aligned to channels*{BYTES_PER_SAMPLE} bytes "
            f"(got {byte_length}, frame size {frame_bytes})"
        )
    chunk_start_audio_sec = _require_number(
        header.get("chunkStartAudioSec"), "chunkStartAudioSec", minimum=0.0
    )
    downbeat_match_tolerance_sec = _require_number(
        header.get("downbeatMatchToleranceSec", DOWNBEAT_MATCH_TOLERANCE_SEC),
        "downbeatMatchToleranceSec",
        minimum=0.000001,
    )
    if downbeat_match_tolerance_sec > MAX_DOWNBEAT_TOLERANCE_SEC:
        raise BeatWindowProtocolError(
            f"downbeatMatchToleranceSec must be <= {MAX_DOWNBEAT_TOLERANCE_SEC}"
        )

    raw_windows = header.get("windows")
    if not isinstance(raw_windows, list) or not raw_windows:
        raise BeatWindowProtocolError("windows must be a non-empty array")
    if len(raw_windows) > MAX_WINDOWS_PER_REQUEST:
        raise BeatWindowProtocolError(
            f"windows exceeds limit {MAX_WINDOWS_PER_REQUEST} (got {len(raw_windows)})"
        )

    declared_chunk_duration_sec = byte_length / float(BYTES_PER_SAMPLE * channels * sample_rate)
    windows: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, raw_window in enumerate(raw_windows):
        if not isinstance(raw_window, dict):
            raise BeatWindowProtocolError(f"windows[{index}] must be a JSON object")
        window_id = _require_text(
            raw_window.get("windowId"),
            f"windows[{index}].windowId",
            max_length=MAX_WINDOW_ID_LENGTH,
        )
        if window_id in seen_ids:
            raise BeatWindowProtocolError(f"duplicate windowId: {window_id}")
        seen_ids.add(window_id)

        local_start_sec = _require_number(
            raw_window.get("localStartSec"), f"windows[{index}].localStartSec", minimum=0.0
        )
        duration_sec = _require_number(
            raw_window.get("durationSec"),
            f"windows[{index}].durationSec",
            minimum=MIN_WINDOW_DURATION_SEC,
        )
        if (
            local_start_sec + duration_sec
            > declared_chunk_duration_sec + WINDOW_SPAN_TOLERANCE_SEC
        ):
            raise BeatWindowProtocolError(
                f"windows[{index}] exceeds decoded chunk duration "
                f"({local_start_sec + duration_sec:.6f} > {declared_chunk_duration_sec:.6f})"
            )
        windows.append(
            {
                "windowId": window_id,
                "localStartSec": local_start_sec,
                "durationSec": duration_sec,
            }
        )

    return {
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "chunkStartAudioSec": chunk_start_audio_sec,
        "sampleRate": sample_rate,
        "channels": channels,
        "byteLength": byte_length,
        "windows": windows,
        "downbeatMatchToleranceSec": downbeat_match_tolerance_sec,
        "declaredChunkDurationSec": declared_chunk_duration_sec,
    }


def _signal_frame_count(signal: Any) -> int:
    shape = getattr(signal, "shape", None)
    if shape is not None:
        try:
            return int(shape[0])
        except (IndexError, TypeError):
            pass
    return len(signal)


def _slice_frames(signal: Any, start_frame: int, end_frame: int) -> Any:
    return signal[start_frame:end_frame]


def _absolute_times(
    values: Any,
    field: str,
    *,
    window_origin_audio_sec: float,
    window_duration_sec: float,
    limit: int,
) -> list[float]:
    if values is None:
        return []
    if hasattr(values, "tolist"):
        values = values.tolist()
    if not isinstance(values, (list, tuple)):
        raise BeatWindowProtocolError(f"{field} must be an array")
    if len(values) > limit:
        raise BeatWindowProtocolError(f"{field} exceeds array limit {limit} (got {len(values)})")

    result: list[float] = []
    previous_rounded: float | None = None
    for index, raw_value in enumerate(values):
        local_sec = _require_number(raw_value, f"{field}[{index}]", minimum=0.0)
        absolute_sec = window_origin_audio_sec + local_sec
        if absolute_sec > window_origin_audio_sec + window_duration_sec + BEAT_EDGE_TOLERANCE_SEC:
            raise BeatWindowProtocolError(
                f"{field}[{index}] exceeds window end "
                f"({absolute_sec:.6f} > "
                f"{window_origin_audio_sec + window_duration_sec + BEAT_EDGE_TOLERANCE_SEC:.6f})"
            )
        rounded_sec = round(absolute_sec, 6)
        if previous_rounded is not None and rounded_sec <= previous_rounded:
            raise BeatWindowProtocolError(
                f"{field} must be strictly increasing after rounding at index {index}"
            )
        previous_rounded = rounded_sec
        result.append(rounded_sec)
    return result


def _assert_downbeats_match_beats(
    downbeats: list[float],
    beats: list[float],
    tolerance_sec: float,
) -> None:
    if not downbeats:
        return
    beat_index = 0
    for downbeat_index, downbeat in enumerate(downbeats):
        while (
            beat_index < len(beats)
            and beats[beat_index] < downbeat - tolerance_sec
        ):
            beat_index += 1
        if beat_index >= len(beats):
            raise BeatWindowProtocolError(
                f"downbeats[{downbeat_index}] does not match any beat"
            )
        error_sec = abs(beats[beat_index] - downbeat)
        if error_sec > tolerance_sec:
            raise BeatWindowProtocolError(
                f"downbeats[{downbeat_index}] does not match any beat "
                f"(nearest error {error_sec:.3f}s)"
            )
        # One-to-one matching: a beat may back at most one downbeat.
        beat_index += 1


def validate_response_size(payload: dict[str, Any]) -> int:
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(encoded) > MAX_RESPONSE_JSON_BYTES:
        raise BeatWindowProtocolError(
            f"response exceeds byte limit {MAX_RESPONSE_JSON_BYTES} (got {len(encoded)})"
        )
    return len(encoded)


def analyze_beat_windows(
    request: dict[str, Any],
    signal: Any,
    predict_window: Callable[[Any, float], tuple[Any, Any]],
    progress: Callable[[int, int], None] | None = None,
) -> list[dict[str, Any]]:
    """Infer every requested window exactly once and return absolute evidence.

    Absolute audio time is produced by adding three values exactly once:
    chunk start + actual window frame origin + local prediction time.
    """

    sample_rate = int(request["sampleRate"])
    chunk_start_audio_sec = float(request["chunkStartAudioSec"])
    total_frames = _signal_frame_count(signal)
    if total_frames <= 0:
        raise BeatWindowProtocolError("decoded PCM is empty")
    actual_chunk_duration_sec = total_frames / float(sample_rate)
    declared_chunk_duration_sec = float(request["declaredChunkDurationSec"])
    if abs(actual_chunk_duration_sec - declared_chunk_duration_sec) > PCM_DURATION_TOLERANCE_SEC:
        raise BeatWindowProtocolError(
            f"decoded PCM duration mismatch "
            f"({actual_chunk_duration_sec:.6f}s != {declared_chunk_duration_sec:.6f}s)"
        )

    windows = request["windows"]
    results: list[dict[str, Any]] = []
    for index, window in enumerate(windows):
        local_start_sec = float(window["localStartSec"])
        requested_duration_sec = float(window["durationSec"])
        start_frame = int(round(local_start_sec * sample_rate))
        end_frame = min(total_frames, start_frame + int(round(requested_duration_sec * sample_rate)))
        actual_frames = end_frame - start_frame
        if actual_frames <= 0:
            raise BeatWindowProtocolError(
                f"windows[{index}] produced an empty PCM slice"
            )
        window_duration_sec = actual_frames / float(sample_rate)
        if window_duration_sec < MIN_WINDOW_DURATION_SEC - WINDOW_SPAN_TOLERANCE_SEC:
            raise BeatWindowProtocolError(
                f"windows[{index}] is shorter than the {MIN_WINDOW_DURATION_SEC:.0f}s "
                f"inference floor ({window_duration_sec:.6f}s)"
            )

        window_origin_audio_sec = chunk_start_audio_sec + start_frame / float(sample_rate)
        window_signal = _slice_frames(signal, start_frame, end_frame)
        raw_beats, raw_downbeats = predict_window(window_signal, window_duration_sec)
        beats = _absolute_times(
            raw_beats,
            f"windows[{index}].beats",
            window_origin_audio_sec=window_origin_audio_sec,
            window_duration_sec=window_duration_sec,
            limit=MAX_BEATS_PER_WINDOW,
        )
        downbeats = _absolute_times(
            raw_downbeats,
            f"windows[{index}].downbeats",
            window_origin_audio_sec=window_origin_audio_sec,
            window_duration_sec=window_duration_sec,
            limit=MAX_DOWNBEATS_PER_WINDOW,
        )
        if downbeats and not beats:
            raise BeatWindowProtocolError(
                f"windows[{index}] returned downbeats without beats"
            )
        _assert_downbeats_match_beats(
            downbeats,
            beats,
            float(request["downbeatMatchToleranceSec"]),
        )

        results.append(
            {
                "windowId": window["windowId"],
                "startAudioSec": round(window_origin_audio_sec, 6),
                "analyzedDurationSec": round(window_duration_sec, 6),
                "status": "ok" if beats else "no-beats",
                "beatsAudioSec": beats,
                "downbeatsAudioSec": downbeats,
            }
        )
        if progress is not None:
            progress(index + 1, len(windows))

    return results


def build_beat_windows_response(
    request: dict[str, Any], windows: list[dict[str, Any]]
) -> dict[str, Any]:
    return {
        "type": RESULT_TYPE,
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request["requestId"],
        "windows": windows,
    }


def _default_progress(completed: int, total: int) -> None:
    try:
        sys.stderr.write(f"beat-windows: {completed}/{total}\n")
        sys.stderr.flush()
    except Exception:
        pass


def handle_analyze_beat_windows_command(
    header: dict[str, Any],
    request_id: str,
    *,
    read_exact: Callable[[int], bytes],
    decode_signal: Callable[[bytes, int], Any],
    predict_beats: Callable[[Any, int], tuple[Any, Any]],
    emit: Callable[[dict[str, Any]], None],
    progress: Callable[[int, int], None] | None = None,
) -> bool:
    """Handle one request; False means stdin is desynchronised and serve must exit."""

    try:
        request = parse_beat_windows_request(header)
    except BeatWindowProtocolError as error:
        emit(
            {
                "type": "error",
                "requestId": request_id,
                "error": f"dynamic-window-protocol: {error}",
            }
        )
        declared_byte_length = resolve_declared_byte_length(header)
        if declared_byte_length <= 0:
            return False
        try:
            read_exact(declared_byte_length)
        except Exception:
            return False
        return True

    try:
        pcm_bytes = read_exact(int(request["byteLength"]))
    except Exception as error:
        emit(
            {
                "type": "error",
                "requestId": request["requestId"],
                "error": f"dynamic-window-pcm: {error}",
            }
        )
        return False

    try:
        signal = decode_signal(pcm_bytes, int(request["channels"]))
        sample_rate = int(request["sampleRate"])
        results = analyze_beat_windows(
            request,
            signal,
            lambda window_signal, window_duration: predict_beats(window_signal, sample_rate),
            progress=progress or _default_progress,
        )
        payload = build_beat_windows_response(request, results)
        validate_response_size(payload)
        emit(payload)
    except BeatWindowProtocolError as error:
        emit(
            {
                "type": "error",
                "requestId": request["requestId"],
                "error": f"dynamic-window-protocol: {error}",
            }
        )
    except Exception as error:  # Inference/runtime failure must not become no-beats.
        emit({"type": "error", "requestId": request["requestId"], "error": str(error)})
    return True
