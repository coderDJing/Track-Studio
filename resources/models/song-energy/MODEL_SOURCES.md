# Song energy model assets

This directory contains the three-stage Essentia MusiCNN/DEAM/emoMusic model used by the
local song-energy analyzer. Audio stays on the user's computer and inference is
performed by `onnxruntime-node`.

## Assets

- `msd-musicnn-1.onnx`
  - Official model: https://essentia.upf.edu/models/autotagging/msd/msd-musicnn-1.onnx
  - SHA-256: `49668ffec47e52e94b96f45930bb46a28a1368d4bdfb5c05378fa834aca616e1`
  - Function: 187 x 96 log-mel patches to 200-dimensional music embeddings.
- `deam-msd-musicnn-2.onnx`
  - Official model: https://essentia.upf.edu/models/classification-heads/deam/deam-msd-musicnn-2.onnx
  - SHA-256: `2cb8f33f188d73fcb651f7c065b049959166c7852f454a59c13e66fe2c092bde`
  - Function: 200-dimensional embeddings to `(valence, arousal)` predictions.
- `emomusic-msd-musicnn-2.onnx`
  - Official model: https://essentia.upf.edu/models/classification-heads/emomusic/emomusic-msd-musicnn-2.onnx
  - Source PB: https://github.com/inspektral/amplab-1/raw/main/emoMusic/msd-musicnn-2.pb
  - SHA-256: `d43da57ee70f53187dca754c7a5cf5bd293a6c2474a5812d2b6cfab328029b07`
  - Function: an independent 200-dimensional embedding head to `(valence, arousal)` predictions.

The checked-in bytes were retrieved from the public
`Nolearnnodo/Music_Mood_Detection` GitHub repository because the official model
host was unreachable from the development network. The emoMusic protobuf was
retrieved from the public `inspektral/amplab-1` mirror and converted to ONNX
with TensorFlow/tf2onnx (dynamic batch, opset 13). The final ONNX files load
and execute successfully with ONNX Runtime. Algorithm version 6 additionally
derives beat-aware acoustic dancefloor features from the same local PCM stream
(rhythmic flux, low-frequency drive, sustained activity, drop contrast, and
breakdown contrast); these features add no runtime model and require no user
training.

Algorithm version 7 additionally aligns the acoustic features to the detected beat grid and
compares 16-beat phrases. Drop and breakdown scores are now transition scores between low/high
phrase regions rather than whole-track loudness spread. The tempo contribution is intentionally
broad and does not center the score on 124 BPM.

Algorithm version 8 adds an 8--16 second temporal energy profile on top of the same model output.
Intro and outro windows are down-weighted, the main-section score uses the sustained high-energy
regions, and multiple Drop/Breakdown transitions are counted instead of letting one global loudness
statistic decide the result. This adds no model files and requires no user training.

Algorithm version 9 normalizes the PCM input level before model inference, combines 4/8/16/32-beat
transition evidence, and requires model, activity, low-frequency, and rhythmic changes to agree on a
Drop or Breakdown. It also records a continuous driving score for tracks whose energy rises steadily
without a single large Drop. The level normalization is a local RMS/true-peak proxy and is not
presented as a standards-compliant LUFS meter.

Algorithm version 10 keeps the v9 signal path but makes the beat grid a formal analysis prerequisite:
the UI and queue associate energy with BPM/beat-grid analysis, and energy is not persisted when no
valid BPM and first beat are available. The version bump invalidates earlier v9 results that may have
been produced without a grid.

Algorithm version 11 keeps the v10 beat-grid prerequisite, projects negative beat anchors onto the
first non-negative beat, reuses a valid cached grid when a fresh anchor is malformed, and recalibrates
rhythmic flux so ordinary dance tracks do not saturate at 100. The version bump invalidates earlier
v10 results.

The upstream model license is reproduced verbatim in
`ESSENTIA_MODELS_LICENSE.txt`.
