"""Run with managed Python; set FRKB_BPM_FIX_TEST_FFMPEG/FFPROBE for media checks."""
import json
import os
from pathlib import Path
import tempfile
import unittest

import numpy as np
from bpm_fix_media import encode_audio, run_media


@unittest.skipUnless(os.environ.get("FRKB_BPM_FIX_TEST_FFMPEG"), "Bundled FFmpeg not selected")
class MediaTests(unittest.TestCase):
    def test_audio_tags_and_cover_survive_every_output_format(self):
        ffmpeg, ffprobe = (os.environ["FRKB_BPM_FIX_TEST_" + name] for name in ("FFMPEG", "FFPROBE"))
        with tempfile.TemporaryDirectory(prefix="bpm-fix-media-test-") as directory:
            folder = Path(directory)
            source, pcm = folder / "original.mp3", folder / "audio.f32"
            samples = np.sin(np.arange(44100) * 2 * np.pi * 440 / 44100).astype("<f4") * 0.1
            samples.tofile(pcm)
            run_media([ffmpeg, "-v", "error", "-f", "f32le", "-ar", "44100", "-ac", "1",
                       "-i", str(pcm), "-f", "lavfi", "-i", "color=c=red:s=32x32",
                       "-map", "0:a", "-map", "1:v", "-c:a", "libmp3lame", "-c:v", "mjpeg",
                       "-disposition:v", "attached_pic", "-frames:v", "1", "-metadata",
                       "title=Cover regression", str(source)])
            original = source.read_bytes()
            for ext in (".wav", ".mp3", ".flac", ".m4a", ".aif", ".aiff", ".aac", ".ogg", ".opus"):
                with self.subTest(format=ext):
                    output = folder / ("fixed" + ext)
                    encode_audio(pcm, source, output, 44100, 1, 123, ffmpeg, ffprobe)
                    info = json.loads(run_media([ffprobe, "-v", "error", "-show_streams",
                                                "-show_format", "-of", "json", str(output)]))
                    covers = [s for s in info["streams"] if s.get("disposition", {}).get("attached_pic")]
                    self.assertEqual(len(covers), 1)
                    tags = {k.lower(): v for entity in [info["format"], *info["streams"]]
                            for k, v in entity.get("tags", {}).items()}
                    if ext != ".aac":
                        self.assertEqual(tags.get("title"), "Cover regression")
                    decoded = run_media([ffmpeg, "-v", "error", "-i", str(output), "-map", "0:a:0",
                                         "-f", "f32le", "-c:a", "pcm_f32le", "-"])
                    self.assertGreater(len(decoded), 40000 * 4)
            self.assertEqual(source.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
