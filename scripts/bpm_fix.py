"""FRKB BPM correction: full-track Beat This -> time map -> offline R3 -> verify.

No dependency on Mixtended, system Python packages, or a Rubber Band CLI.
Outputs newline-delimited JSON progress for the Electron main process.
"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

# Embedded managed Python may omit the script directory from sys.path.
# Resolve sibling helpers explicitly in both development and packaged builds.
sys.path.insert(0, str(Path(__file__).resolve().parent))


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def run_media(args):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", "replace")[-3000:])
    return result.stdout


def decode_audio(source, workdir, ffmpeg, ffprobe, name):
    import numpy as np
    info = json.loads(run_media([ffprobe, "-v", "error", "-select_streams", "a:0",
                                "-show_entries", "stream=sample_rate,channels", "-of", "json", str(source)]))
    streams = info.get("streams", [])
    if not streams:
        raise ValueError("BPM_FIX_NO_AUDIO_STREAM")
    sr, channels = int(streams[0]["sample_rate"]), int(streams[0]["channels"])
    if channels not in (1, 2) or not 8000 <= sr <= 192000:
        raise ValueError("BPM_FIX_UNSUPPORTED_AUDIO")
    decoded = workdir / (name + ".f32")
    run_media([ffmpeg, "-nostdin", "-v", "error", "-y", "-i", str(source),
               "-map", "0:a:0", "-f", "f32le", "-c:a", "pcm_f32le", str(decoded)])
    audio = np.fromfile(decoded, dtype="<f4").reshape(-1, channels)
    decoded.unlink()
    if len(audio) < sr * 8 or not np.all(np.isfinite(audio)):
        raise ValueError("BPM_FIX_INVALID_AUDIO")
    return audio, sr


def fix(args):
    # Import the existing bridge to reuse its managed DLL/site paths and its
    # DirectML/MPS compatibility handling, not its constant-grid approximation.
    import beat_this_bridge as bridge
    import numpy as np
    from bpm_fix_grid import analyze_grid, plan_correction, verify_grid, verification_diagnostics
    from bpm_fix_rubberband import render_r3
    from bpm_fix_detection import detect_verification_beats
    from bpm_fix_transients import refine_time_map

    source, output = (Path(p).resolve() for p in (args.input, args.output))
    if not source.is_file() or source == output:
        raise ValueError("BPM_FIX_INVALID_PATH")
    if output.exists():
        raise FileExistsError("BPM_FIX_OUTPUT_EXISTS")
    checkpoint = bridge._resolve_checkpoint_path()
    if not Path(checkpoint).is_file():
        raise FileNotFoundError("BPM_FIX_CHECKPOINT_UNAVAILABLE")
    started = time.monotonic()
    emit({"type": "progress", "stage": "loading", "percent": 2})
    predictor = bridge.Audio2Beats(checkpoint_path=checkpoint, device=args.device, dbn=False)
    cpu_spect = bridge.LogMelSpect(device="cpu") if bridge._uses_accelerated_device(args.device) else None

    def detect(audio, sr):
        mono = np.mean(audio, axis=1, dtype=np.float32)
        return bridge._predict_beats(predictor, mono, sr, args.device, cpu_spect)

    with tempfile.TemporaryDirectory(prefix="work-", dir=output.parent) as folder:
        workdir = Path(folder)
        emit({"type": "progress", "stage": "decoding", "percent": 5})
        audio, sr = decode_audio(source, workdir, args.ffmpeg, args.ffprobe, "input")
        emit({"type": "progress", "stage": "analyzing", "percent": 10})
        if args.mode == "analyze" or not args.analysis:
            from bpm_fix_crosscheck import cross_check
            raw, downbeats = detect(audio, sr)
            mono = np.mean(audio, axis=1, dtype=np.float32)
            analysis = analyze_grid(raw, downbeats, len(audio) / sr, mono, sr)
            emit({"type": "progress", "stage": "crosschecking", "percent": 65})
            checked = cross_check(raw, mono, sr)
            analysis.update(checked)
            indices = analysis["indices"]
            regression = np.polyfit(indices, analysis["beats"], 1)
            residual = analysis["beats"] - np.polyval(regression, indices)
            ratio = checked["referenceBpm"] / analysis["bpm"]
            public = {
                "sourceBpm": float(analysis["bpm"]), **checked,
                "driftMs": float(np.ptp(residual) * 1000),
                "coverage": analysis["coverage"], "filledBeats": analysis["filled"],
                "ignoredDetections": analysis["ignored"],
                "tempoAmbiguous": any(abs(ratio / value - 1) < 0.04 for value in (0.5, 2, 3, 1/3)),
                "durationSec": len(audio) / sr,
            }
            if args.mode == "analyze":
                internal = {key: value.tolist() if isinstance(value, np.ndarray) else value
                            for key, value in analysis.items()}
                emit({"type": "result", "result": {"public": public, "analysis": internal}})
                return
        else:
            analysis = args.analysis
            for key in ("beats", "detected", "indices", "smoothed", "downbeats"):
                analysis[key] = np.asarray(analysis[key])
        if analysis["confidence"] < 0.5 and not args.allow_low_confidence:
            raise ValueError("BPM_FIX_LOW_CONFIDENCE")
        plan = plan_correction(analysis, len(audio), sr, args.target_bpm, args.tempo_factor)
        emit({"type": "progress", "stage": "planning", "percent": 35,
              "sourceBpm": round(analysis["bpm"], 4), "targetBpm": plan["targetBpm"]})
        plan = refine_time_map(plan, audio, sr)
        last_progress = [-1]

        def render_progress(value):
            percent = int(36 + value * 38)
            if percent != last_progress[0]:
                emit({"type": "progress", "stage": "rendering", "percent": percent})
                last_progress[0] = percent

        rendered = render_r3(audio, sr, plan, args.rubberband, render_progress)
        peak = float(np.max(np.abs(rendered)))
        gain = min(1.0, 0.999 / max(peak, 1e-9))
        rendered *= gain
        pcm = workdir / "rendered.f32"
        rendered.astype("<f4").tofile(pcm)
        candidate = workdir / ("fixed" + output.suffix.lower())
        encoders = {
            ".wav": ["-c:a", "pcm_s24le", "-rf64", "auto"],
            ".mp3": ["-c:a", "libmp3lame", "-b:a", "320k", "-id3v2_version", "3"],
            ".flac": ["-c:a", "flac", "-sample_fmt", "s32"],
            ".aif": ["-c:a", "pcm_s24be"], ".aiff": ["-c:a", "pcm_s24be"],
            ".m4a": ["-c:a", "aac", "-b:a", "256k"],
            ".aac": ["-c:a", "aac", "-b:a", "256k"],
            ".ogg": ["-c:a", "libvorbis", "-q:a", "8"],
            ".opus": ["-c:a", "libopus", "-b:a", "192k"],
        }
        if output.suffix.lower() not in encoders:
            raise ValueError("BPM_FIX_UNSUPPORTED_FORMAT")
        emit({"type": "progress", "stage": "encoding", "percent": 76})
        run_media([args.ffmpeg, "-nostdin", "-v", "error", "-y", "-f", "f32le",
                   "-ar", str(sr), "-ac", str(audio.shape[1]), "-i", str(pcm),
                   "-i", str(source), "-map", "0:a:0", "-map_metadata", "1",
                   "-metadata", "BPM=" + str(plan["targetBpm"]),
                   *encoders[output.suffix.lower()], str(candidate)])
        emit({"type": "progress", "stage": "verifying", "percent": 80})
        actual, output_sr = decode_audio(candidate, workdir, args.ffmpeg, args.ffprobe, "verify")
        checked_beats, raw_checked_count = detect_verification_beats(
            predictor, np.mean(actual, axis=1, dtype=np.float32), output_sr,
            cpu_spect, plan["targetBpm"], args.tempo_factor)
        suppressed_count = raw_checked_count - len(checked_beats)
        if args.tempo_factor == 0.5:
            checked_beats = checked_beats[::2]
        verification = None
        try:
            verification = verify_grid(checked_beats, plan["targetBpm"], plan["gridOffsetSec"])
        finally:
            if args.rc_diagnostics:
                details = verification_diagnostics(
                    checked_beats, plan["targetBpm"], plan["gridOffsetSec"], verification)
                planned_beats = np.interp(analysis["beats"] * sr, plan["from"], plan["to"]) / sr
                planned_grid = (plan["gridOffsetSec"] +
                                (analysis["indices"] - analysis["indices"][0]) *
                                60.0 / plan["targetBpm"] * args.tempo_factor)
                planned_errors = (planned_beats - planned_grid) * 1000
                details.update({
                    "sourceBpm": float(analysis["bpm"] * args.tempo_factor),
                    "targetBpm": plan["targetBpm"], "requestedTargetBpm": args.target_bpm,
                    "tempoFactor": args.tempo_factor, "confidence": analysis["confidence"],
                    "gridOffsetSec": plan["gridOffsetSec"], "anchorCount": len(plan["from"]),
                    "anchorsBeforeRefinement": plan["anchorsBeforeRefinement"],
                    "transientAlignedAnchors": plan["transientAlignedAnchors"],
                    "timeMapDeviationMs": plan["timeMapDeviationMs"],
                    "sourceBeatCount": len(analysis["beats"]), "rawOutputBeatCount": raw_checked_count,
                    "suppressedCompetingBeats": suppressed_count,
                    "plannedDetectedBeatRmsMs": float(np.sqrt(np.mean(planned_errors ** 2))),
                    "plannedDetectedBeatMaxErrorMs": float(np.max(np.abs(planned_errors))),
                    "inputSampleRate": sr, "outputSampleRate": output_sr,
                    "inputDurationSec": len(audio) / sr, "outputDurationSec": len(actual) / output_sr,
                    "outputFormat": output.suffix.lower(),
                })
                emit({"type": "diagnostic", "event": "verification", "details": details})
        # Retain diagnostic evidence in the result, but never report a failed
        # grid verification as a successful correction.
        result = {
            "sourceBpm": round(analysis["bpm"] * args.tempo_factor, 4), "targetBpm": plan["targetBpm"],
            "confidence": round(analysis["confidence"], 4), "renderer": "rubberband-r3",
            "sampleRate": sr, "channels": int(audio.shape[1]), "bitDepth": 24,
            "durationInSec": len(audio) / sr, "durationOutSec": len(actual) / output_sr,
            "gridOffsetSec": plan["gridOffsetSec"], "anchors": len(plan["from"]),
            "ignoredDetections": analysis["ignored"], "filledBeats": analysis["filled"],
            "noticeableSegments": plan["noticeableSegments"], "peakGain": gain,
            "verification": verification, "durationMs": int((time.monotonic() - started) * 1000),
        }
        downbeats = analysis["downbeats"]
        first_downbeat = int(np.argmin(np.abs(analysis["beats"] - downbeats[0]))) if len(downbeats) else 0
        result["timeMap"] = {
            "from": plan["from"].tolist(), "to": plan["to"].tolist(), "sampleRate": sr,
            "downbeatBeatOffset": int(round(-analysis["indices"][first_downbeat] * args.tempo_factor)) % 4,
        }
        if not verification["passed"]:
            raise ValueError("BPM_FIX_VERIFICATION_FAILED")
        emit({"type": "progress", "stage": "saving", "percent": 96})
        # Electron gives us private staging paths. The main process rechecks
        # source identity and publishes to a new destination without overwrite.
        with output.open("xb") as destination, candidate.open("rb") as src:
            import shutil
            shutil.copyfileobj(src, destination)
        emit({"type": "result", "result": result})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("input", "output", "ffmpeg", "ffprobe", "rubberband"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--mode", choices=("analyze", "repair"), default="repair")
    parser.add_argument("--target-bpm", type=float)
    parser.add_argument("--tempo-factor", type=float, default=1.0)
    parser.add_argument("--allow-low-confidence", action="store_true")
    parser.add_argument("--analysis-stdin", action="store_true")
    parser.add_argument("--rc-diagnostics", action="store_true")
    args = parser.parse_args()
    try:
        args.analysis = json.loads(sys.stdin.readline()) if args.analysis_stdin else None
        fix(args)
        return 0
    except Exception as error:
        emit({"type": "error", "error": str(error)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
