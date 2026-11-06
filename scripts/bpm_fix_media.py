"""Audio encoding and container-aware embedded artwork preservation."""
import base64
import json
import shutil
import struct
import subprocess


def run_media(args):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", "replace")[-3000:])
    return result.stdout


def _id3_pictures(pictures):
    frames = bytearray()
    for data, _, _ in pictures:
        payload = b"\x00image/png\x00\x03\x00" + data
        frames.extend(b"APIC" + struct.pack(">I", len(payload)) + b"\x00\x00" + payload)
    size = len(frames)
    if size >= 1 << 28:
        raise ValueError("BPM_FIX_ARTWORK_TOO_LARGE")
    synchsafe = bytes((size >> shift) & 127 for shift in (21, 14, 7, 0))
    return b"ID3\x03\x00\x00" + synchsafe + frames


def _append_id3(output, pictures):
    tag = _id3_pictures(pictures)
    ext = output.suffix.lower()
    if ext == ".aac":
        # ADTS permits an ID3 prefix. Stream the audio; never read a whole song.
        tagged = output.with_suffix(".tagged.aac")
        with tagged.open("xb") as dst, output.open("rb") as src:
            dst.write(tag)
            shutil.copyfileobj(src, dst)
        tagged.replace(output)
        return
    with output.open("r+b") as file:
        header = file.read(12)
        wave = ext == ".wav"
        if (wave and header[:4] not in (b"RIFF", b"RF64")) or (not wave and header[:4] != b"FORM"):
            raise ValueError("BPM_FIX_INVALID_RESULT")
        file.seek(0, 2)
        file.write((b"id3 " if wave else b"ID3 ") + struct.pack("<I" if wave else ">I", len(tag)))
        file.write(tag)
        if len(tag) % 2:
            file.write(b"\x00")
        size = file.tell() - 8
        if header[:4] == b"RF64":
            file.seek(12)
            if file.read(4) != b"ds64":
                raise ValueError("BPM_FIX_INVALID_RESULT")
            file.seek(20)
            file.write(struct.pack("<Q", size))
        else:
            if size >= 1 << 32:
                raise ValueError("BPM_FIX_AUDIO_TOO_LONG")
            file.seek(4)
            file.write(struct.pack("<I" if wave else ">I", size))


def encode_audio(pcm, source, output, sr, channels, bpm, ffmpeg, ffprobe):
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
    ext = output.suffix.lower()
    if ext not in encoders:
        raise ValueError("BPM_FIX_UNSUPPORTED_FORMAT")
    info = json.loads(run_media([ffprobe, "-v", "error", "-show_streams", "-of", "json", str(source)]))
    covers = [stream for stream in info["streams"] if stream.get("disposition", {}).get("attached_pic")]
    args = [ffmpeg, "-nostdin", "-v", "error", "-y", "-f", "f32le", "-ar", str(sr),
            "-ac", str(channels), "-i", str(pcm), "-i", str(source)]
    pictures = []
    # PNG normalization supports mixed source image codecs in every container.
    for i, cover in enumerate(covers):
        image = output.parent / f"cover-{i}.png"
        run_media([ffmpeg, "-nostdin", "-v", "error", "-y", "-i", str(source),
                   "-map", f"0:{cover['index']}", "-frames:v", "1", "-c:v", "png", str(image)])
        if ext in (".mp3", ".flac", ".m4a"):
            args += ["-i", str(image)]
        else:
            pictures.append((image.read_bytes(), cover["width"], cover["height"]))
    metadata_input = None
    if pictures and ext in (".ogg", ".opus"):
        # Vorbis/Opus store a base64 FLAC picture block in a comment.
        lines = [";FFMETADATA1"]
        for data, width, height in pictures:
            mime = b"image/png"
            block = (struct.pack(">II", 3, len(mime)) + mime + struct.pack(">I", 0) +
                     struct.pack(">IIIII", width, height, 24, 0, len(data)) + data)
            lines.append("METADATA_BLOCK_PICTURE=" + base64.b64encode(block).decode("ascii"))
        metadata = output.parent / "artwork.ffmetadata"
        metadata.write_text("\n".join(lines), encoding="utf-8")
        args += ["-f", "ffmetadata", "-i", str(metadata)]
        metadata_input = 2
    args += ["-map", "0:a:0", "-map_metadata", "1", "-metadata", "BPM=" + str(bpm)]
    if covers and ext in (".mp3", ".flac", ".m4a"):
        for i in range(len(covers)):
            args += ["-map", f"{i + 2}:v:0", f"-disposition:v:{i}", "attached_pic"]
        args += ["-c:v", "copy"]
    if metadata_input is not None:
        args += ["-map_metadata", str(metadata_input)]
    run_media([*args, *encoders[ext], str(output)])
    if pictures and ext in (".wav", ".aif", ".aiff", ".aac"):
        _append_id3(output, pictures)
