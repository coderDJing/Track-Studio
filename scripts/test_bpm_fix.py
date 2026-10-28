"""Run with the managed analysis Python: python scripts/test_bpm_fix.py.

Set FRKB_BPM_FIX_TEST_LIBRARY to the managed Rubber Band library to also run
native R3 checks. These use generated signals and do not touch the music library.
"""

import os
from pathlib import Path
import unittest
from unittest.mock import patch

import numpy as np
from bpm_fix_grid import (analyze_grid, grid_indices, plan_correction, verify_grid,
                          verification_diagnostics, walk_beats)
from bpm_fix_crosscheck import beat_f1
from bpm_fix_detection import detect_verification_beats, select_verification_beats


class GridTests(unittest.TestCase):
    def test_accelerated_verification_preserves_cpu_spectrogram_inference(self):
        import torch
        scores = torch.zeros(75)
        scores[[20, 24, 45]] = torch.tensor([5.0, 2.0, 6.0])

        class Predictor:
            device = "cpu"
            model = object()

            def signal2spect(self, mono, sr):
                return torch.zeros((12, 128))

            def spect2frames(self, spect):
                return scores, scores

            def frames2beats(self, beat, downbeat):
                return np.array([0.4, 0.48, 0.9]), np.array([0.4])

        predictor = Predictor()
        mono = np.zeros(22050, dtype=np.float32)
        expected, count = detect_verification_beats(predictor, mono, 22050, None, 120, 1)
        # DirectML does not use Audio2Frames.spect2frames/autocast. Exercise
        # that path with CPU tensors so this regression needs no GPU hardware.
        with patch.object(predictor, "spect2frames", side_effect=AssertionError("autocast")), \
                patch("beat_this.inference.split_predict_aggregate", return_value={
                    "beat": scores, "downbeat": scores}):
            selected, raw_count = detect_verification_beats(
                predictor, mono, 22050, lambda audio: torch.zeros((12, 128)), 120, 1)
        np.testing.assert_array_equal(selected, expected)
        np.testing.assert_array_equal(selected, [0.4, 0.9])
        self.assertEqual((count, raw_count), (3, 3))

    def test_competing_peaks_use_confidence_across_tempos(self):
        for bpm in (30, 60, 90, 120, 180, 240, 300):
            with self.subTest(bpm=bpm):
                true = np.round((0.4 + np.arange(40) * 60 / bpm) * 50) / 50
                extra = true[15] + round(60 / bpm * 0.2 * 50) / 50
                raw = np.sort(np.r_[true, extra])
                scores = np.zeros(round((raw[-1] + 1) * 50))
                scores[np.rint(true * 50).astype(int)] = 8
                scores[round(extra * 50)] = 2
                np.testing.assert_array_equal(select_verification_beats(raw, scores, bpm), true)

    def test_competing_peak_selection_cannot_prefer_the_target_grid(self):
        good = 0.4 + np.arange(180) * 0.5
        # An off-grid candidate wins when its model confidence is higher,
        # even though there is a weaker candidate exactly on the target grid.
        late = good[60] + 0.08
        raw = np.sort(np.r_[good, late])
        scores = np.ones(round((raw[-1] + 1) * 50))
        scores[round(late * 50)] = 8
        selected = select_verification_beats(raw, scores, 120)
        self.assertIn(late, selected)
        self.assertNotIn(good[60], selected)
        self.assertEqual(verify_grid(selected, 120, 0.4)["offGridBeats"], 1)
        # Both isolated and sustained timing errors must remain evidence;
        # original acceptance permits the former but rejects sustained drift.
        for bad in (np.r_[good[:60], good[60] + 0.08, good[61:]],
                    good + np.r_[np.zeros(90), np.full(90, 0.04)]):
            selected = select_verification_beats(bad, scores, 120)
            np.testing.assert_array_equal(selected, bad)
        self.assertFalse(verify_grid(selected, 120, 0.4)["passed"])

    def test_peak_selection_respects_beat_interpretation_and_half_beat_events(self):
        true = 0.4 + np.arange(40) * 0.5
        raw = np.sort(np.r_[true, true[15] + 0.08])
        scores = np.ones(round((raw[-1] + 1) * 50))
        scores[np.rint(true * 50).astype(int)] = 8
        for factor in (0.5, 1.0, 2.0):
            np.testing.assert_array_equal(
                select_verification_beats(raw, scores, 120 * factor, factor), true)
        # A distinct half-beat event is not a close duplicate: retain it so
        # that verification can reject it rather than selecting only on-grid beats.
        raw = np.sort(np.r_[true, true[15] + 0.25])
        np.testing.assert_array_equal(select_verification_beats(raw, scores, 120), raw)
        self.assertFalse(verify_grid(raw, 120, 0.4)["passed"])

    def test_crosscheck_matches_each_reference_beat_only_once(self):
        self.assertEqual(beat_f1([0.5, 0.53], [0.5]), 2 / 3)
        self.assertEqual(beat_f1([0.5, 1.0], [0.56, 1.06]), 1.0)
        self.assertEqual(beat_f1([0.5, 1.0], [0.58, 1.08]), 0.0)
        self.assertEqual(beat_f1([], []), 0.0)

    def test_beat_interpretation_does_not_double_audio_duration(self):
        beats = 0.4 + np.arange(180) * 0.5
        analysis = analyze_grid(beats, beats[::4], 90.4)
        plans = [plan_correction(analysis, 90400, 1000, tempo_factor=f) for f in (0.5, 1, 2)]
        self.assertEqual([p['targetBpm'] for p in plans], [60, 120, 240])
        for plan in plans[1:]:
            np.testing.assert_array_equal(plans[0]['to'], plan['to'])
        with self.assertRaisesRegex(ValueError, 'INVALID_TARGET'):
            plan_correction(analysis, 90400, 1000, target_bpm=float('nan'))

    def test_drift_never_adds_a_target_grid_beat(self):
        intervals = np.linspace(0.51, 0.48, 500)
        beats = np.r_[0.37, 0.37 + np.cumsum(intervals)]
        analysis = analyze_grid(beats, beats[::4], beats[-1] + 0.3)
        np.testing.assert_array_equal(analysis["indices"], np.arange(len(beats)))
        plan = plan_correction(analysis, round((beats[-1] + 0.3) * 48000), 48000)
        self.assertGreater(np.min(np.diff(plan["from"])), 0)
        self.assertGreater(np.min(np.diff(plan["to"])), 0)
        self.assertLess(len(plan["from"]), len(beats) / 2)
        self.assertEqual(plan["from"][1], round(0.37 * 48000))
        self.assertEqual(plan["to"][1], round(0.37 * 48000))

    def test_quantisation_does_not_modulate_every_beat(self):
        true = 0.4 + np.arange(240) * 60 / 123
        raw = np.round(true / 0.02) * 0.02
        analysis = analyze_grid(raw, raw[::4], raw[-1] + 0.4)
        plan = plan_correction(analysis, round((raw[-1] + 0.4) * 48000), 48000)
        self.assertEqual(plan["targetBpm"], 123)
        self.assertLess(len(plan["from"]), 70)
        self.assertLess(np.std(np.diff(analysis["smoothed"])[10:-10]), 0.002)

    def test_missing_detection_is_filled_and_extra_is_ignored(self):
        true = 0.4 + np.arange(180) * 0.5
        raw = np.sort(np.r_[np.delete(true, [40, 41]), true[80] + 0.24])
        beats, detected, ignored = walk_beats(raw, true[-1] + 0.4)
        np.testing.assert_allclose(beats, true, atol=1e-8)
        self.assertEqual(np.count_nonzero(~detected), 2)
        self.assertEqual(ignored, 1)

    def test_short_offbeat_excursion_does_not_become_audio_warp(self):
        true = 0.4 + np.arange(180) * 0.5
        raw = true.copy()
        raw[50:58] += 0.25
        beats, detected, _ = walk_beats(raw, true[-1] + 0.4)
        np.testing.assert_allclose(beats, true, atol=1e-8)
        self.assertEqual(np.count_nonzero(~detected), 8)

    def test_persistent_half_beat_hiccup_is_preserved_for_correction(self):
        raw = 0.4 + np.arange(180) * 0.5
        raw[50:] += 0.25
        beats, _, _ = walk_beats(raw, raw[-1] + 0.4)
        np.testing.assert_allclose(beats, raw, atol=1e-8)
        # A 1.5-period discontinuity advances two metrical beats. Slow drift
        # still advances exactly one (covered separately above).
        self.assertEqual(grid_indices(beats)[-1], len(beats))

    def test_verification_accepts_phase_and_isolated_error_but_rejects_drift(self):
        good = 0.4 + np.arange(180) * 0.5
        self.assertTrue(verify_grid(good, 120, 0.4)["passed"])
        shifted = verify_grid(good + 0.013, 120, 0.4)
        self.assertTrue(shifted["passed"])
        self.assertAlmostEqual(shifted["phaseShiftMs"], 13)
        self.assertTrue(verify_grid(good + 0.15, 120, 0.4)["passed"])
        self.assertEqual(verification_diagnostics(good + 0.15, 120, 0.4,
                         verify_grid(good + 0.15, 120, 0.4))["reasons"], [])
        bad = good.copy()
        bad += 0.013
        bad[60] += 0.08
        self.assertTrue(verify_grid(bad, 120, 0.4)["passed"])
        self.assertEqual(verify_grid(bad, 120, 0.4)["offGridBeats"], 1)
        bad = good.copy()
        bad[90:] += 0.04
        self.assertFalse(verify_grid(bad, 120, 0.4)["passed"])

    def test_verification_rejects_remaining_missing_and_extra_beats(self):
        good = 0.4 + np.arange(180) * 0.5
        for raw in (np.delete(good, 60), np.sort(np.r_[good, good[60] + 0.1])):
            result = verify_grid(raw, 120, 0.4)
            self.assertFalse(result["passed"])
            self.assertGreater(result["remainingAnomalies"], 0)
            self.assertIn("remaining_anomalies",
                          verification_diagnostics(raw, 120, 0.4, result)["reasons"])
        # Original anomaly acceptance ignores the boundary positions, while
        # preserving the global BPM and RMS gates.
        result = verify_grid(np.delete(good, 1), 120, 0.4)
        self.assertTrue(result["passed"])
        self.assertEqual(result["remainingAnomalies"], 0)

    def test_verification_rejects_wrong_bpm_even_with_small_grid_rms(self):
        raw = 0.4 + np.arange(8) * 60 / 120.8
        result = verify_grid(raw, 120, 0.4)
        self.assertLess(result["gridRmsMs"], 14)
        self.assertGreater(result["bpmError"], 0.6)
        self.assertFalse(result["passed"])
        self.assertEqual(verification_diagnostics(raw, 120, 0.4, result)["reasons"],
                         ["bpm_error"])

    def test_sparse_detection_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "NOT_ENOUGH_BEATS"):
            analyze_grid([0.3, 1, 2], [], 30)

    def test_verification_diagnostics_identify_outlier_without_dumping_all_beats(self):
        raw = 0.4 + np.arange(180) * 0.5
        raw[60] += 0.08
        result = verify_grid(raw, 120, 0.4)
        details = verification_diagnostics(raw, 120, 0.4, result)
        self.assertTrue(details["passed"])
        self.assertEqual(details["reasons"], [])
        self.assertEqual(details["notices"], ["off_grid_beats"])
        self.assertEqual(details["beatCount"], 180)
        self.assertEqual(len(details["worstBeats"]), 8)
        self.assertEqual(details["worstBeats"][0]["beatIndex"], 60)
        self.assertAlmostEqual(details["worstBeats"][0]["errorMs"], 80)
        self.assertEqual(details["beatNoticeMs"], 70)
        self.assertNotIn("maxBeatErrorMs", details["thresholds"])
        self.assertNotIn("maxPhaseShiftMs", details["thresholds"])

    def test_verification_diagnostics_distinguish_rms_and_too_few_beats(self):
        raw = 0.4 + np.arange(180) * 0.5 + np.tile([-0.02, 0.02], 90)
        details = verification_diagnostics(raw, 120, 0.4, verify_grid(raw, 120, 0.4))
        self.assertEqual(details["reasons"], ["grid_rms"])
        self.assertEqual(details["thresholds"]["maxPlannedBeatErrorMs"], 25)
        details = verification_diagnostics([], 120, 0.4, None)
        self.assertEqual(details["reasons"], ["insufficient_beats"])
        self.assertEqual(details["worstBeats"], [])
        self.assertIsNone(details["metrics"])

    @unittest.skipUnless(os.environ.get("FRKB_BPM_FIX_TEST_LIBRARY"), "Managed native library not selected")
    def test_native_keyframe_map_preserves_known_transient_positions(self):
        from bpm_fix_rubberband import render_r3
        # Exact generated pulse positions provide timing truth independent of
        # Beat This and of any real song used during diagnosis.
        beats = np.r_[0.4, 0.4 + np.cumsum(np.r_[
            np.full(16, 0.5), np.linspace(0.5, 0.56, 16), np.linspace(0.56, 0.45, 16)])]
        for sr in (44100, 48000, 96000):
            with self.subTest(sample_rate=sr):
                frames = round((beats[-1] + 0.8) * sr)
                audio = np.zeros((frames, 2), dtype=np.float32)
                t = np.arange(round(sr * 0.02)) / sr
                pulse = np.sin(2 * np.pi * 180 * t) * np.exp(-t * 120)
                for beat in beats:
                    start = round(beat * sr)
                    audio[start:start + len(pulse)] += pulse[:, None]
                analysis = analyze_grid(beats, beats[::4], frames / sr)
                plan = plan_correction(analysis, frames, sr, 120)
                rendered = render_r3(audio, sr, plan, os.environ["FRKB_BPM_FIX_TEST_LIBRARY"])
                expected = np.interp(beats * sr, plan["from"], plan["to"])
                errors = []
                for target in expected:
                    lo, hi = round(target - sr * 0.1), round(target + sr * 0.1)
                    peak = lo + int(np.argmax(np.sum(rendered[lo:hi] ** 2, axis=1)))
                    errors.append(abs(peak - target) / sr)
                self.assertLess(max(errors), 0.005)

    @unittest.skipUnless(os.environ.get("FRKB_BPM_FIX_TEST_LIBRARY"), "Managed native library not selected")
    def test_native_variable_map_keeps_pitch_channels_and_length(self):
        from bpm_fix_rubberband import render_r3
        sr, frames = 48000, 48000 * 6
        signal = np.sin(2 * np.pi * 110 * np.arange(frames) / sr).astype(np.float32) * 0.2
        samples = np.stack([signal, signal], axis=1)
        plan = {
            "from": np.array([0, 48000, 144000, frames]),
            "to": np.array([0, 48000, 158400, 302400]),
            "outputFrames": 302400,
        }
        rendered = render_r3(samples, sr, plan, Path(os.environ["FRKB_BPM_FIX_TEST_LIBRARY"]))
        self.assertEqual(rendered.shape, (302400, 2))
        np.testing.assert_array_equal(rendered[:, 0], rendered[:, 1])
        for start in [48000, 180000]:
            section = rendered[start:start + sr, 0]
            peak = np.argmax(np.abs(np.fft.rfft(section * np.hanning(len(section)))))
            self.assertLess(abs(peak * sr / len(section) - 110), 0.5)


if __name__ == "__main__":
    unittest.main()
