"""Run: managed Python -m unittest discover -s scripts -p test_bpm_fix*.py."""
import unittest
import numpy as np
from bpm_fix_grid import analyze_grid, walk_beats
from bpm_fix_verification import audio_features, verify_audio


class AudioVerificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sr = 8000
        cls.beats = 0.6 + np.arange(64) * 0.5
        cls.frames = int((cls.beats[-1] + 0.6) * cls.sr)
        cls.analysis = analyze_grid(cls.beats, cls.beats[::4], cls.frames / cls.sr)
        cls.plan = {'from': [0, cls.frames], 'to': [0, cls.frames],
                    'targetBpm': 120, 'gridOffsetSec': 0.6, 'outputFrames': cls.frames}
        cls.source = cls.signal(cls.beats)
        cls.features = audio_features(cls.source, cls.sr)

    @classmethod
    def signal(cls, beats):
        rng = np.random.default_rng(12)
        audio = np.zeros(cls.frames, dtype=np.float32)
        t = np.arange(800) / cls.sr
        for i, beat in enumerate(beats):
            pulse = (np.sin(2 * np.pi * (90 + i % 5 * 40) * t) + rng.normal(0, .4, len(t))) * np.exp(-t * 55)
            at = round(beat * cls.sr)
            if at + len(t) < len(audio):
                audio[at:at + len(t)] += pulse
        return np.column_stack([audio, -audio])

    def check(self, output, analysis=None):
        return verify_audio(self.features, audio_features(output, self.sr),
                            self.analysis if analysis is None else analysis, self.plan, self.sr)

    def test_follows_real_audio_with_opposite_phase_stereo_and_codec_latency(self):
        for shift in (0, .06):
            result = self.check(self.signal(self.beats + shift))
            self.assertTrue(result['passed'], result)
            self.assertLess(result['gridRmsMs'], 2)
            self.assertAlmostEqual(result['phaseShiftMs'], shift * 1000, delta=2)

    def test_sustained_local_drift_is_not_snapped_to_the_requested_grid(self):
        result = self.check(self.signal(self.beats + np.r_[np.zeros(32), np.full(32, .06)]))
        self.assertFalse(result['passed'], result)
        self.assertIn('grid_rms', result['reasons'])

    def test_missing_middle_wrong_tempo_and_silence_are_rejected(self):
        missing = self.source.copy()
        missing[10 * self.sr:15 * self.sr] = 0
        for output in (missing, self.signal(.6 + np.arange(64) * 60 / 124),
                       np.zeros_like(missing), self.source[:-self.sr]):
            result = self.check(output)
            self.assertFalse(result['passed'], result)

    def test_sparse_source_evidence_cannot_pass_even_if_audio_follows_its_map(self):
        analysis = {**self.analysis, 'detected': np.tile([True, False], 32)}
        result = self.check(self.source, analysis)
        self.assertFalse(result['passed'])
        self.assertIn('insufficient_audio_matches', result['reasons'])

    def test_intro_cannot_lock_the_full_song_to_a_wrong_tempo(self):
        raw = np.r_[np.arange(20) * .75, 15 + np.arange(300) * .5]
        beats, detected, ignored = walk_beats(raw, raw[-1] + .5)
        self.assertGreater(np.count_nonzero(detected), 290)
        self.assertLess(ignored, 30)


if __name__ == '__main__':
    unittest.main()
