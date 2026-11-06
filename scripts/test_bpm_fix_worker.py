"""Protocol/lifetime tests: python scripts/test_bpm_fix_worker.py."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from bpm_fix import emit, serve


class WorkerTests(unittest.TestCase):
    def test_reuses_model_cache_and_continues_after_a_song_failure(self):
        args = ["--input", "source", "--output", "dest", "--ffmpeg", "ffmpeg",
                "--ffprobe", "ffprobe", "--rubberband", "managed"]
        requests = [json.dumps({"requestId": i, "args": args, "analysis": {"id": i}})
                    for i in range(1, 4)]
        caches = []
        def process_track(request, models):
            caches.append(models)
            models.setdefault("predictor", object())
            if request.analysis["id"] == 2:
                raise ValueError("bad song")
            emit({"type": "result", "result": {"ok": True}})
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            serve(requests, process_track=process_track)
        messages = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([m["requestId"] for m in messages], [1, 2, 3])
        self.assertEqual([m["type"] for m in messages], ["result", "error", "result"])
        self.assertTrue(all(cache is caches[0] for cache in caches))

    @unittest.skipUnless(os.environ.get("FRKB_BPM_FIX_TEST_E2E"), "Managed end-to-end test not selected")
    def test_real_worker_analyzes_then_repairs_generated_audio(self):
        import numpy as np
        from bpm_fix_media import run_media
        ffmpeg, ffprobe = (os.environ["FRKB_BPM_FIX_TEST_" + name] for name in ("FFMPEG", "FFPROBE"))
        with tempfile.TemporaryDirectory(prefix="bpm-fix-worker-test-") as directory:
            folder = Path(directory)
            sr = 44100
            audio = np.zeros((sr * 32, 2), dtype="<f4")
            rng = np.random.default_rng(42)
            t = np.arange(round(sr * .08)) / sr
            for i, beat in enumerate(np.arange(.4, 31.5, .5)):
                pulse = (np.sin(2 * np.pi * (80 * t - 150 * t * t)) +
                         rng.normal(0, .25, len(t))) * np.exp(-t * 70) * .4
                at = round(beat * sr)
                audio[at:at + len(t)] = pulse[:, None]
            pcm, source, output = folder / "input.f32", folder / "input.wav", folder / "fixed.wav"
            audio.tofile(pcm)
            run_media([ffmpeg, "-v", "error", "-f", "f32le", "-ar", str(sr), "-ac", "2",
                       "-i", str(pcm), "-c:a", "pcm_s24le", str(source)])
            base = ["--input", str(source), "--output", str(output), "--ffmpeg", ffmpeg,
                    "--ffprobe", ffprobe, "--rubberband", os.environ["FRKB_BPM_FIX_TEST_LIBRARY"],
                    "--device", "cpu"]
            with (folder / "worker.stderr").open("w+") as errors:
                worker = subprocess.Popen([sys.executable, str(Path(__file__).with_name("bpm_fix.py")), "--worker"],
                                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors,
                                          text=True, encoding="utf-8")
                def request(request_id, args, analysis=None):
                    worker.stdin.write(json.dumps({"requestId": request_id, "args": args, "analysis": analysis}) + "\n")
                    worker.stdin.flush()
                    for line in worker.stdout:
                        message = json.loads(line)
                        self.assertEqual(message["requestId"], request_id)
                        if message["type"] == "error":
                            self.fail(message["error"])
                        if message["type"] == "result":
                            return message["result"]
                    errors.seek(0)
                    self.fail(errors.read())
                try:
                    analyzed = request(1, base + ["--mode", "analyze"])
                    result = request(2, base + ["--mode", "repair", "--target-bpm", "120", "--allow-low-confidence"], analyzed["analysis"])
                    self.assertTrue(result["verification"]["passed"])
                    self.assertTrue(output.is_file())
                    self.assertIsNone(worker.poll())
                    worker.stdin.close()
                    self.assertEqual(worker.wait(timeout=20), 0)
                finally:
                    if worker.poll() is None:
                        worker.kill()
                        worker.wait(timeout=20)
                    worker.stdout.close()
                    if not worker.stdin.closed:
                        worker.stdin.close()


if __name__ == "__main__":
    unittest.main()
