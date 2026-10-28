"""Run with the managed analysis Python: python scripts/test_bpm_fix_transients.py."""

import os
import unittest

import numpy as np

from bpm_fix_transients import align_time_map, refine_time_map, transient_times


class TransientMapTests(unittest.TestCase):
    def plan(self):
        return {
            "from": np.arange(6) * 1000,
            "to": np.array([0, 1000, 2100, 3050, 4050, 5050]),
            "outputFrames": 5050, "gridOffsetSec": 0.4,
        }

    def test_moves_corner_without_snapping_attack_to_original_beat(self):
        plan = self.plan()
        refined = align_time_map(plan, 1000, np.array([1.98]))
        at = np.flatnonzero(refined["from"] == 1980)
        self.assertEqual(len(at), 1)
        self.assertEqual(refined["to"][at[0]], 2078)
        self.assertNotEqual(refined["to"][at[0]], 2100)
        self.assertEqual(refined["transientAlignedAnchors"], 1)
        self.assertLessEqual(refined["timeMapDeviationMs"], 5)
        # Inputs are not mutated; all musical decisions still originate in
        # the original analysis and map rather than an inferred integer grid.
        np.testing.assert_array_equal(plan["from"], np.arange(6) * 1000)

    def test_rejects_corner_move_that_exceeds_timing_budget(self):
        plan = self.plan()
        plan["to"] = np.array([0, 500, 2000, 2500, 4000, 5000])
        refined = align_time_map(plan, 1000, np.array([1.951]))
        np.testing.assert_array_equal(refined["from"], plan["from"])
        np.testing.assert_array_equal(refined["to"], plan["to"])
        self.assertEqual(refined["transientAlignedAnchors"], 0)

    def test_simplifies_redundant_corners_and_preserves_joins(self):
        source = np.arange(101, dtype=np.int64) * 1000
        target = source + np.rint(np.sin(np.arange(101) / 10) * 3).astype(np.int64)
        plan = {"from": source, "to": target, "outputFrames": int(target[-1])}
        refined = align_time_map(plan, 1000, np.arange(0.02, 100, 1))
        self.assertLess(len(refined["from"]), 10)
        np.testing.assert_array_equal(refined["from"][[0, 1, -2, -1]], source[[0, 1, -2, -1]])
        np.testing.assert_array_equal(refined["to"][[0, 1, -2, -1]], target[[0, 1, -2, -1]])
        self.assertEqual(refined["outputFrames"], plan["outputFrames"])
        self.assertLessEqual(refined["timeMapDeviationMs"], 5)

    def test_maintains_monotonicity_and_rate_bounds_with_close_attacks(self):
        refined = align_time_map(self.plan(), 1000, np.array([1.96, 1.96, 2.015, 3.015]))
        self.assertTrue(np.all(np.diff(refined["from"]) > 0))
        self.assertTrue(np.all(np.diff(refined["to"]) > 0))
        ratios = np.diff(refined["to"]) / np.diff(refined["from"])
        self.assertTrue(np.all((ratios >= 0.5) & (ratios <= 2)))
        self.assertLessEqual(refined["timeMapDeviationMs"], 5)

    def test_empty_transients_and_two_point_map(self):
        plan = {"from": np.array([0, 1000]), "to": np.array([0, 1100]), "outputFrames": 1100}
        refined = align_time_map(plan, 1000, np.array([]))
        np.testing.assert_array_equal(refined["from"], plan["from"])
        np.testing.assert_array_equal(refined["to"], plan["to"])

    def test_invalid_maps_are_rejected_before_integer_conversion(self):
        for source, target, attacks in (
            ([0, np.nan], [0, 1000], []),
            ([0, 1000], [0, np.inf], []),
            ([0, 1000], [0, 1000], [np.nan]),
            ([0, 1000.1], [0, 1000], []),
            ([0, 1000, 500], [0, 1000, 1500], []),
            ([0, 1000], [0, 3000], []),
        ):
            with self.subTest(source=source, target=target, attacks=attacks):
                with self.assertRaises(ValueError):
                    align_time_map({"from": source, "to": target}, 1000, attacks)

    def test_random_maps_keep_global_budget_in_both_directions(self):
        rng, sr = np.random.default_rng(7391), 48000
        for _ in range(60):
            count = int(rng.integers(6, 150))
            source = np.r_[0, np.cumsum(rng.integers(12000, 40000, count))]
            target = np.r_[0, np.cumsum(np.rint(np.diff(source) * rng.uniform(
                0.6, 1.8, count)).astype(np.int64))]
            attacks = source / sr + rng.uniform(-0.049, 0.049, count + 1)
            revised = align_time_map({"from": source, "to": target}, sr, attacks)
            ratios = np.diff(revised["to"]) / np.diff(revised["from"])
            self.assertTrue(np.all((ratios >= 0.5) & (ratios <= 2)))
            for original, changed, inverse, changed_inverse in (
                (source, revised["from"], target, revised["to"]),
                (target, revised["to"], source, revised["from"]),
            ):
                np.testing.assert_array_equal(changed[[0, 1, -2, -1]], original[[0, 1, -2, -1]])
                positions = np.unique(np.r_[np.linspace(0, original[-1], 10001), original, changed])
                error = np.abs(np.interp(positions, original, inverse) -
                               np.interp(positions, changed, changed_inverse))
                self.assertLessEqual(float(np.max(error)) / sr, 0.005 + 1e-12)

    def test_detects_known_attacks_at_multiple_rates_without_stereo_cancellation(self):
        true = np.array([0.4, 1.1, 1.8])
        for sr in (44100, 48000, 96000):
            with self.subTest(sample_rate=sr):
                mono = np.zeros(round(sr * 2.2), dtype=np.float32)
                t = np.arange(round(sr * 0.025)) / sr
                pulse = np.sin(2 * np.pi * 180 * t) * np.exp(-t * 120)
                for time in true:
                    start = round(time * sr)
                    mono[start:start + len(pulse)] += pulse
                stereo = np.stack([mono, -mono], axis=1)
                detected = transient_times(stereo, sr)
                self.assertEqual(len(detected), len(true))
                np.testing.assert_allclose(detected, true, atol=0.005)
                np.testing.assert_allclose(transient_times(stereo * 0.003, sr), detected, atol=0.0025)

    def test_silence_and_sustained_tone_do_not_produce_interior_attacks(self):
        sr = 48000
        self.assertEqual(len(transient_times(np.zeros((sr, 2)), sr)), 0)
        t = np.arange(sr * 2) / sr
        for frequency in (55, 440):
            tone = np.sin(2 * np.pi * frequency * t).astype(np.float32)
            attacks = transient_times(tone, sr)
            self.assertFalse(np.any((attacks > 0.1) & (attacks < 1.9)))

    @unittest.skipUnless(os.environ.get("FRKB_BPM_FIX_TEST_LIBRARY"), "Managed native library not selected")
    def test_refined_map_renders_generated_attacks_at_the_expected_times(self):
        from bpm_fix_grid import analyze_grid, plan_correction
        from bpm_fix_rubberband import render_r3

        sr = 48000
        beats = np.r_[0.4, 0.4 + np.cumsum(np.r_[np.full(12, 0.5),
            np.linspace(0.5, 0.56, 12), np.linspace(0.56, 0.45, 12)])]
        frames = round((beats[-1] + 0.8) * sr)
        samples = np.zeros((frames, 2), dtype=np.float32)
        t = np.arange(round(sr * 0.02)) / sr
        pulse = np.sin(2 * np.pi * 180 * t) * np.exp(-t * 120)
        for beat in beats:
            start = round(beat * sr)
            samples[start:start + len(pulse)] += pulse[:, None]
        original = plan_correction(analyze_grid(beats, beats[::4], frames / sr), frames, sr, 120)
        revised = refine_time_map(original, samples, sr)
        rendered = render_r3(samples, sr, revised, os.environ["FRKB_BPM_FIX_TEST_LIBRARY"])
        self.assertEqual(rendered.shape, (original["outputFrames"], 2))
        np.testing.assert_array_equal(rendered[:, 0], rendered[:, 1])
        # Compare to the original intended timing, not just the revised map.
        for destination in np.interp(beats * sr, original["from"], original["to"]):
            lo, hi = round(destination - sr * 0.1), round(destination + sr * 0.1)
            peak = lo + int(np.argmax(np.sum(rendered[lo:hi] ** 2, axis=1)))
            self.assertLess(abs(peak - destination) / sr, 0.010)


if __name__ == "__main__":
    unittest.main()
