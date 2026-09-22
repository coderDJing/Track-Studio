# Third-Party Notices

This project includes third-party software, derived logic, and bundled binary
runtime assets. These notices are provided to describe the current repository
and packaged application license boundaries.

FRKB source code written by CoderDJing is licensed under the MIT License in
`LICENSE`. Third-party code remains under its original license. The current
packaged application includes GPL components, so redistribution of the combined
packaged application must comply with GPL-3.0-or-later as well as the
component licenses below.

## QM DSP Library

- Project: QM DSP Library (Queen Mary University of London)
- Repository path: `rust_package/native/qm`
- Source: QM DSP sources as vendored through the Mixxx source tree
- License: GPL-2.0-or-later
- Current use: key detection through `GetKeyMode` and supporting DSP classes.
  The files are compiled into `rust_package` by `rust_package/build.rs` and
  called from the `analyzeKeyFromPcm` native binding.

## KissFFT

- Project: KissFFT
- Repository paths:
  - `rust_package/native/qm/ext/kissfft`
  - `rust_package/native/chromaprint/kissfft`
- Source: https://github.com/mborgerding/kissfft
- License: BSD-3-Clause
- Current use: FFT backend for QM DSP and Chromaprint code paths.

## FFmpeg

- Project: FFmpeg
- Repository paths:
  - `vendor/ffmpeg`
  - `rust_package/native/ffmpeg`
- Source: https://ffmpeg.org/
- Windows build source: https://github.com/BtbN/FFmpeg-Builds
- Current bundled Windows build: GPL-3.0-or-later. The bundled
  `vendor/ffmpeg/win32-x64/ffmpeg.exe` reports `--enable-gpl --enable-version3`
  and `ffmpeg -L` reports GNU GPL version 3 or later.
- Current use: packaged FFmpeg/FFprobe binaries and FFmpeg libraries used by
  native decode/fingerprint paths.

## Rubber Band Library

- Project: Rubber Band Library and `@ainsej/rubberband-wasm`
- Repository paths:
  - `rust_package/native/r3_stretch`
  - `src/renderer/src/workers/mixtapeTransportR3.worklet.js`
  - packaged dependency in `node_modules`
- Sources:
  - https://breakfastquay.com/rubberband/
  - https://github.com/ains/rubberband-wasm
- License: GPL-2.0
- Current use: R3 tempo/pitch processing in native and renderer audio paths.

## Chromaprint

- Project: Chromaprint
- Repository path: `rust_package/native/chromaprint`
- Source: https://acoustid.org/chromaprint
- License: Chromaprint's own source is MIT. The vendored
  `rust_package/native/chromaprint/LICENSE.md` states that the bundled project
  should be considered LGPL-2.1 as a whole because it includes FFmpeg-derived
  code.
- Current use: acoustic fingerprint generation.

## Demucs and Beat-This Runtime Assets

- Repository paths:
  - `vendor/demucs`
  - `scripts/beat_this_*.py`
- Current use: stem separation and beat-grid analysis runtime support.
- Notes: The bundled Python runtimes and site-packages include multiple
  third-party packages with their own licenses. Notable license families in the
  current bundled runtime include MIT, BSD, Apache-2.0, MPL-2.0, LGPL, and Intel
  runtime licenses. The package license files are retained under the bundled
  `vendor/demucs/**/Lib/site-packages/**.dist-info` and runtime license paths.

## Rekordbox Desktop Runtime

- Repository path: `vendor/rekordbox-desktop-runtime`
- Current use: Python runtime and Python packages used by the Rekordbox desktop
  library bridge.
- Notes: The bundled runtime and site-packages include third-party packages
  with their own licenses. License files are retained under the bundled
  `vendor/rekordbox-desktop-runtime/**/Lib/site-packages/**.dist-info` and
  runtime license paths.

## JavaScript and Rust Package Dependencies

- Current production JavaScript dependency licenses include MIT, BSD, ISC,
  Apache-2.0, MPL-2.0-or-Apache-2.0, Python-2.0, and LGPL-2.1 families.
- Current Rust crate dependency licenses include MIT, Apache-2.0, BSD, ISC,
  MPL-2.0, Zlib, Unlicense, and compatible dual-license expressions.
- Dependency package metadata and license files are retained in the lockfiles,
  package metadata, Cargo metadata, and installed dependency folders.

## Essentia MusiCNN and DEAM Model Weights

- Repository path: `resources/models/song-energy`
- Source: https://essentia.upf.edu/models.html
- Copyright: Universitat Pompeu Fabra 2019-2020
- License: Creative Commons Attribution-NonCommercial-ShareAlike 4.0
- Current use: local MusiCNN embedding extraction followed by DEAM and emoMusic
  arousal regressors, plus beat-aware local acoustic features for the v6
  dancefloor score.
- The complete upstream license is retained at
  `resources/models/song-energy/ESSENTIA_MODELS_LICENSE.txt`.

## ONNX Runtime

- Project: ONNX Runtime (`onnxruntime-node`)
- Source: https://github.com/microsoft/onnxruntime
- License: MIT
- Current use: local CPU inference for the bundled song-energy models.

## MSAF Spectral Clustering Derived Logic

- Project: Music Structure Analysis Framework (`urinieto/msaf`)
- Source: https://github.com/urinieto/msaf/tree/main/msaf/algorithms/scluster
- MSAF project license: MIT, Copyright (c) 2016 Oriol Nieto
- The upstream `scluster/main2.py` identifies the original Laplacian
  segmentation code as Brian McFee code under the ISC license.
- Current use: the FRKB TypeScript song-structure implementation follows the
  McFee/Ellis spectral-clustering pipeline used by MSAF, adapted to FRKB
  beat-aligned waveform features and semantic EDM section decoding.

MIT notice for MSAF:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions: The above copyright
> notice and this permission notice shall be included in all copies or
> substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
> WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
> THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
> FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
> TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR
> THE USE OR OTHER DEALINGS IN THE SOFTWARE.

ISC notice for the original Laplacian segmentation implementation:

> Copyright (c) Brian McFee. Permission to use, copy, modify, and/or distribute
> this software for any purpose with or without fee is hereby granted, provided
> that the above copyright notice and this permission notice appear in all
> copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
> WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
> MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
> SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER
> RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
> NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE
> USE OR PERFORMANCE OF THIS SOFTWARE.

## Compatibility Naming

Some FRKB internal types and cache names still use `Mixxx` as a compatibility
or historical waveform label. The current repository audit found no vendored
Mixxx source file outside the QM DSP source provenance described above. Those
internal names do not by themselves relicense FRKB-owned source code.
