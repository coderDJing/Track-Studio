"""Run with the managed analysis Python: python scripts/test_bpm_fix.py.

Set FRKB_BPM_FIX_TEST_LIBRARY to the managed Rubber Band library to also run
native R3 checks. These use generated signals and do not touch the music library.
"""

import os
from pathlib import Path
import unittest

import numpy as np
from bpm_fix_grid import (analyze_grid, grid_indices, plan_correction, verify_grid,
                          verification_diagnostics, walk_beats)
from bpm_fix_crosscheck import beat_f1


class GridTests(unittest.TestCase):
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

    def test_verification_cannot_hide_bad_output_phase(self):
        good = 0.4 + np.arange(180) * 0.5
        self.assertTrue(verify_grid(good, 120, 0.4)["passed"])
        self.assertFalse(verify_grid(good + 0.15, 120, 0.4)["passed"])
        bad = good.copy()
        bad[60] += 0.2
        self.assertFalse(verify_grid(bad, 120, 0.4)["passed"])

    def test_sparse_detection_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "NOT_ENOUGH_BEATS"):
            analyze_grid([0.3, 1, 2], [], 30)

    def test_verification_diagnostics_identify_outlier_without_dumping_all_beats(self):
        raw = 0.4 + np.arange(180) * 0.5
        raw[60] += 0.08
        result = verify_grid(raw, 120, 0.4)
        details = verification_diagnostics(raw, 120, 0.4, result)
        self.assertFalse(details["passed"])
        self.assertEqual(details["reasons"], ["off_grid_beats"])
        self.assertEqual(details["beatCount"], 180)
        self.assertEqual(len(details["worstBeats"]), 8)
        self.assertEqual(details["worstBeats"][0]["beatIndex"], 60)
        self.assertAlmostEqual(details["worstBeats"][0]["errorMs"], 80)
        self.assertEqual(details["thresholds"]["maxBeatErrorMs"], 70)

    def test_verification_diagnostics_distinguish_rms_and_too_few_beats(self):
        raw = 0.4 + np.arange(180) * 0.5 + 0.02
        details = verification_diagnostics(raw, 120, 0.4, verify_grid(raw, 120, 0.4))
        self.assertEqual(details["reasons"], ["grid_rms"])
        self.assertEqual(details["thresholds"]["maxPlannedBeatErrorMs"], 25)
        details = verification_diagnostics([], 120, 0.4, None)
        self.assertEqual(details["reasons"], ["insufficient_beats"])
        self.assertEqual(details["worstBeats"], [])
        self.assertIsNone(details["metrics"])

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
