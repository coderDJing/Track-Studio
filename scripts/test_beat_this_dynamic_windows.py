import ast
import contextlib
import io
import json
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

import beat_this_dynamic_windows as dynamic_windows
from beat_this_dynamic_windows import (
    BeatWindowProtocolError,
    analyze_beat_windows,
    build_beat_windows_response,
    handle_analyze_beat_windows_command,
    parse_beat_windows_request,
    resolve_declared_byte_length,
    validate_response_size,
)

SCRIPT_DIR = Path(__file__).resolve().parent
SAMPLE_RATE = 8000
CHUNK_DURATION_SEC = 120.0
CHUNK_BYTES = int(CHUNK_DURATION_SEC * SAMPLE_RATE * 4)


def build_header(
    *,
    chunk_start_audio_sec: float = 0.0,
    windows: list[dict[str, Any]] | None = None,
    request_id: str = 'req-1',
    protocol_version: Any = 1,
    byte_length: int = CHUNK_BYTES,
    command_type: str = 'analyze_beat_windows',
    downbeat_match_tolerance_sec: float | None = None,
) -> dict[str, Any]:
    header: dict[str, Any] = {
        'type': command_type,
        'protocolVersion': protocol_version,
        'requestId': request_id,
        'chunkStartAudioSec': chunk_start_audio_sec,
        'sampleRate': SAMPLE_RATE,
        'channels': 1,
        'byteLength': byte_length,
        'windows': windows
        if windows is not None
        else [{'windowId': 'w1', 'localStartSec': 0.0, 'durationSec': 30.0}],
    }
    if downbeat_match_tolerance_sec is not None:
        header['downbeatMatchToleranceSec'] = downbeat_match_tolerance_sec
    return header


def frames(duration_sec: float) -> list[int]:
    return [0] * int(duration_sec * SAMPLE_RATE)


def fixed_predictor(beats: list[float], downbeats: list[float]):
    def predict(_window: Any, _duration: float) -> tuple[list[float], list[float]]:
        return list(beats), list(downbeats)

    return predict


class ParseRequestTests(unittest.TestCase):
    def test_accepts_a_well_formed_request(self) -> None:
        request = parse_beat_windows_request(
            build_header(
                chunk_start_audio_sec=105.0,
                windows=[
                    {'windowId': 'a', 'localStartSec': 0.0, 'durationSec': 30.0},
                    {'windowId': 'b', 'localStartSec': 15.0, 'durationSec': 30.0},
                ],
            )
        )

        self.assertEqual(request['requestId'], 'req-1')
        self.assertEqual(request['chunkStartAudioSec'], 105.0)
        self.assertAlmostEqual(request['declaredChunkDurationSec'], CHUNK_DURATION_SEC)
        self.assertEqual([window['windowId'] for window in request['windows']], ['a', 'b'])

    def test_rejects_wrong_protocol_version(self) -> None:
        with self.assertRaises(BeatWindowProtocolError):
            parse_beat_windows_request(build_header(protocol_version=2))

    def test_rejects_float_protocol_version(self) -> None:
        for value in (1.0, '1', True):
            with self.assertRaises(BeatWindowProtocolError):
                parse_beat_windows_request(build_header(protocol_version=value))

    def test_rejects_misaligned_byte_length(self) -> None:
        with self.assertRaises(BeatWindowProtocolError):
            parse_beat_windows_request(build_header(byte_length=CHUNK_BYTES + 1))

    def test_rejects_unknown_downbeat_tolerance(self) -> None:
        with self.assertRaises(BeatWindowProtocolError):
            parse_beat_windows_request(
                build_header(downbeat_match_tolerance_sec=0.5)
            )

    def test_rejects_wrong_command_type(self) -> None:
        with self.assertRaises(BeatWindowProtocolError):
            parse_beat_windows_request(build_header(command_type='analyze_pcm'))

    def test_rejects_empty_request_id(self) -> None:
        with self.assertRaises(BeatWindowProtocolError):
            parse_beat_windows_request(build_header(request_id='  '))

    def test_rejects_duplicate_window_ids(self) -> None:
        with self.assertRaises(BeatWindowProtocolError):
            parse_beat_windows_request(
                build_header(
                    windows=[
                        {'windowId': 'dup', 'localStartSec': 0.0, 'durationSec': 30.0},
                        {'windowId': 'dup', 'localStartSec': 30.0, 'durationSec': 30.0},
                    ]
                )
            )

    def test_rejects_window_shorter_than_inference_floor(self) -> None:
        with self.assertRaises(BeatWindowProtocolError):
            parse_beat_windows_request(
                build_header(
                    windows=[{'windowId': 'short', 'localStartSec': 0.0, 'durationSec': 7.5}]
                )
            )

    def test_rejects_window_outside_the_declared_chunk(self) -> None:
        with self.assertRaises(BeatWindowProtocolError):
            parse_beat_windows_request(
                build_header(
                    windows=[{'windowId': 'late', 'localStartSec': 100.0, 'durationSec': 30.0}]
                )
            )

    def test_rejects_window_count_over_limit(self) -> None:
        windows = [
            {'windowId': f'w{index}', 'localStartSec': 0.0, 'durationSec': 8.0}
            for index in range(dynamic_windows.MAX_WINDOWS_PER_REQUEST + 1)
        ]
        with self.assertRaises(BeatWindowProtocolError):
            parse_beat_windows_request(build_header(windows=windows))

    def test_rejects_non_finite_local_start(self) -> None:
        with self.assertRaises(BeatWindowProtocolError):
            parse_beat_windows_request(
                build_header(
                    windows=[{'windowId': 'bad', 'localStartSec': float('nan'), 'durationSec': 10.0}]
                )
            )

    def test_declared_byte_length_only_accepts_aligned_safe_positive_integers(self) -> None:
        self.assertEqual(
            resolve_declared_byte_length({'byteLength': 4096, 'channels': 1}), 4096
        )
        self.assertEqual(
            resolve_declared_byte_length({'byteLength': 4096, 'channels': 2}), 4096
        )
        self.assertEqual(
            resolve_declared_byte_length({'byteLength': 4097, 'channels': 2}), 0
        )
        self.assertEqual(resolve_declared_byte_length({'byteLength': 0, 'channels': 1}), 0)
        self.assertEqual(resolve_declared_byte_length({'byteLength': -4, 'channels': 1}), 0)
        self.assertEqual(
            resolve_declared_byte_length({'byteLength': '4096', 'channels': 1}), 0
        )
        self.assertEqual(resolve_declared_byte_length({'byteLength': 4096}), 0)
        self.assertEqual(
            resolve_declared_byte_length(
                {'byteLength': dynamic_windows.MAX_PCM_BYTES + 4, 'channels': 1}
            ),
            0,
        )


class AnalyzeWindowTests(unittest.TestCase):
    def _request(self, **overrides: Any) -> dict[str, Any]:
        header = build_header(
            chunk_start_audio_sec=105.0,
            windows=[{'windowId': 'w1', 'localStartSec': 15.0, 'durationSec': 30.0}],
        )
        header.update(overrides)
        return parse_beat_windows_request(header)

    def test_adds_chunk_and_window_offset_exactly_once(self) -> None:
        request = self._request()
        result = analyze_beat_windows(
            request,
            frames(CHUNK_DURATION_SEC),
            fixed_predictor([0.25, 0.75], [0.25]),
        )

        self.assertEqual(len(result), 1)
        evidence = result[0]
        self.assertAlmostEqual(evidence['startAudioSec'], 120.0)
        self.assertAlmostEqual(evidence['analyzedDurationSec'], 30.0)
        self.assertEqual(evidence['status'], 'ok')
        self.assertEqual(evidence['beatsAudioSec'], [120.25, 120.75])
        self.assertEqual(evidence['downbeatsAudioSec'], [120.25])

    def test_empty_prediction_is_explicit_no_beats(self) -> None:
        result = analyze_beat_windows(
            self._request(), frames(CHUNK_DURATION_SEC), fixed_predictor([], [])
        )

        self.assertEqual(result[0]['status'], 'no-beats')
        self.assertEqual(result[0]['beatsAudioSec'], [])
        self.assertEqual(result[0]['downbeatsAudioSec'], [])

    def test_downbeats_without_beats_is_an_error(self) -> None:
        with self.assertRaises(BeatWindowProtocolError):
            analyze_beat_windows(
                self._request(), frames(CHUNK_DURATION_SEC), fixed_predictor([], [12.0])
            )

    def test_rejects_non_finite_beats(self) -> None:
        with self.assertRaises(BeatWindowProtocolError):
            analyze_beat_windows(
                self._request(),
                frames(CHUNK_DURATION_SEC),
                fixed_predictor([float('inf')], []),
            )

    def test_rejects_non_monotonic_beats(self) -> None:
        with self.assertRaises(BeatWindowProtocolError):
            analyze_beat_windows(
                self._request(),
                frames(CHUNK_DURATION_SEC),
                fixed_predictor([1.0, 1.0], []),
            )

    def test_rejects_beats_that_collapse_after_rounding(self) -> None:
        with self.assertRaises(BeatWindowProtocolError):
            analyze_beat_windows(
                self._request(),
                frames(CHUNK_DURATION_SEC),
                fixed_predictor([1.0000001, 1.0000002], []),
            )

    def test_rejects_two_downbeats_matching_the_same_beat(self) -> None:
        with self.assertRaises(BeatWindowProtocolError):
            analyze_beat_windows(
                self._request(),
                frames(CHUNK_DURATION_SEC),
                fixed_predictor([1.0, 1.5], [1.0, 1.005]),
            )

    def test_downbeat_tolerance_comes_from_the_request(self) -> None:
        strict_request = self._request(downbeatMatchToleranceSec=0.001)
        with self.assertRaises(BeatWindowProtocolError):
            analyze_beat_windows(
                strict_request,
                frames(CHUNK_DURATION_SEC),
                fixed_predictor([1.0], [1.02]),
            )

        default_request = self._request()
        result = analyze_beat_windows(
            default_request,
            frames(CHUNK_DURATION_SEC),
            fixed_predictor([1.0], [1.02]),
        )
        self.assertEqual(result[0]['downbeatsAudioSec'], [121.02])

    def test_rejects_beats_beyond_the_window(self) -> None:
        with self.assertRaises(BeatWindowProtocolError):
            analyze_beat_windows(
                self._request(),
                frames(CHUNK_DURATION_SEC),
                fixed_predictor([30.5], []),
            )

    def test_rejects_downbeats_that_do_not_match_beats(self) -> None:
        with self.assertRaises(BeatWindowProtocolError):
            analyze_beat_windows(
                self._request(),
                frames(CHUNK_DURATION_SEC),
                fixed_predictor([1.0, 1.5], [2.4]),
            )

    def test_rejects_too_many_beats(self) -> None:
        beats = [index * 0.01 for index in range(dynamic_windows.MAX_BEATS_PER_WINDOW + 1)]
        with self.assertRaises(BeatWindowProtocolError):
            analyze_beat_windows(
                self._request(), frames(CHUNK_DURATION_SEC), fixed_predictor(beats, [])
            )

    def test_rejects_decoded_duration_mismatch(self) -> None:
        with self.assertRaises(BeatWindowProtocolError):
            analyze_beat_windows(self._request(), frames(60.0), fixed_predictor([1.0], []))

    def test_progress_reports_completed_windows(self) -> None:
        calls: list[tuple[int, int]] = []
        analyze_beat_windows(
            self._request(),
            frames(CHUNK_DURATION_SEC),
            fixed_predictor([1.0], []),
            progress=lambda completed, total: calls.append((completed, total)),
        )

        self.assertEqual(calls, [(1, 1)])

    def test_response_byte_limit_is_enforced(self) -> None:
        payload = build_beat_windows_response(
            {'requestId': 'req-1'},
            [
                {
                    'windowId': 'w1',
                    'startAudioSec': 0.0,
                    'analyzedDurationSec': 30.0,
                    'status': 'ok',
                    'beatsAudioSec': [1.0],
                    'downbeatsAudioSec': [],
                }
            ],
        )
        with mock.patch.object(dynamic_windows, 'MAX_RESPONSE_JSON_BYTES', 8):
            with self.assertRaises(BeatWindowProtocolError):
                validate_response_size(payload)


class CommandHandlerTests(unittest.TestCase):
    def test_invalid_request_emits_error_and_drains_pcm(self) -> None:
        emitted: list[dict[str, Any]] = []
        drained: list[int] = []
        header = build_header(protocol_version=9, byte_length=4096)

        handled = handle_analyze_beat_windows_command(
            header,
            'req-1',
            read_exact=lambda size: drained.append(size) or b'\x00' * size,
            decode_signal=lambda _pcm, _channels: frames(CHUNK_DURATION_SEC),
            predict_beats=lambda _signal, _sample_rate: ([], []),
            emit=emitted.append,
        )

        self.assertTrue(handled)
        self.assertEqual(drained, [4096])
        self.assertEqual(len(emitted), 1)
        self.assertEqual(emitted[0]['type'], 'error')
        self.assertIn('dynamic-window-protocol', emitted[0]['error'])

    def test_unrecoverable_byte_length_terminates_the_session(self) -> None:
        emitted: list[dict[str, Any]] = []
        drained: list[int] = []

        handled = handle_analyze_beat_windows_command(
            build_header(protocol_version=9, byte_length=4097),
            'req-1',
            read_exact=lambda size: drained.append(size) or b'\x00' * size,
            decode_signal=lambda _pcm, _channels: frames(CHUNK_DURATION_SEC),
            predict_beats=lambda _signal, _sample_rate: ([], []),
            emit=emitted.append,
        )

        self.assertFalse(handled)
        self.assertEqual(drained, [])
        self.assertEqual(emitted[0]['type'], 'error')

    def test_pcm_read_failure_terminates_the_session(self) -> None:
        emitted: list[dict[str, Any]] = []

        def fail_read(_size: int) -> bytes:
            raise RuntimeError('unexpected EOF')

        handled = handle_analyze_beat_windows_command(
            build_header(),
            'req-1',
            read_exact=fail_read,
            decode_signal=lambda _pcm, _channels: frames(CHUNK_DURATION_SEC),
            predict_beats=lambda _signal, _sample_rate: ([], []),
            emit=emitted.append,
        )

        self.assertFalse(handled)
        self.assertEqual(emitted[0]['type'], 'error')

    def test_inference_failure_emits_error_not_no_beats(self) -> None:
        emitted: list[dict[str, Any]] = []

        def explode(_signal: Any, _sample_rate: int) -> tuple[list[float], list[float]]:
            raise RuntimeError('model exploded')

        handled = handle_analyze_beat_windows_command(
            build_header(),
            'req-1',
            read_exact=lambda size: b'\x00' * size,
            decode_signal=lambda _pcm, _channels: frames(CHUNK_DURATION_SEC),
            predict_beats=explode,
            emit=emitted.append,
        )

        self.assertTrue(handled)
        self.assertEqual(len(emitted), 1)
        self.assertEqual(emitted[0]['type'], 'error')
        self.assertIn('model exploded', emitted[0]['error'])

    def test_progress_goes_to_stderr_while_payload_goes_to_stdout_channel(self) -> None:
        emitted: list[dict[str, Any]] = []
        stderr = io.StringIO()

        with contextlib.redirect_stderr(stderr):
            handle_analyze_beat_windows_command(
                build_header(),
                'req-1',
                read_exact=lambda size: b'\x00' * size,
                decode_signal=lambda _pcm, _channels: frames(CHUNK_DURATION_SEC),
                predict_beats=lambda _signal, _sample_rate: ([1.0], [1.0]),
                emit=emitted.append,
            )

        self.assertEqual(emitted[0]['type'], 'beat-windows-result')
        self.assertEqual(emitted[0]['protocolVersion'], 1)
        self.assertEqual(emitted[0]['requestId'], 'req-1')
        self.assertIn('beat-windows: 1/1', stderr.getvalue())
        self.assertNotIn('beat-windows:', json.dumps(emitted))


class BridgeRegressionTests(unittest.TestCase):
    def test_bridge_keeps_normal_analyze_pcm_branch_intact(self) -> None:
        source = (SCRIPT_DIR / 'beat_this_bridge.py').read_text(encoding='utf-8')
        tree = ast.parse(source)
        serve = next(
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == 'serve'
        )
        call_names = {
            node.func.id
            for node in ast.walk(serve)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }

        self.assertIn('_prepare_analysis_windows', call_names)
        self.assertIn('_analyze_prepared_windows_to_track_result', call_names)
        self.assertIn('_to_public_downbeat_result', call_names)
        self.assertIn('handle_analyze_beat_windows_command', call_names)
        self.assertIn('command != "analyze_pcm"', source)
        self.assertIn('command == "analyze_beat_windows"', source)


if __name__ == '__main__':
    unittest.main()
