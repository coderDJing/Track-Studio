"""Offline multichannel R3 rendering through the project's managed library."""

import ctypes as ct
import os
from pathlib import Path

import numpy as np


def render_r3(samples, sr, plan, library_path, progress=None):
    library_path = Path(library_path).resolve(strict=True)
    dll_scope = os.add_dll_directory(str(library_path.parent)) if os.name == "nt" else None
    try:
        library = ct.CDLL(str(library_path))
        state_type, uint, float_ptr = ct.c_void_p, ct.c_uint, ct.POINTER(ct.c_float)
        channels_ptr = ct.POINTER(float_ptr)

        def bind(name, args, result=None):
            fn = getattr(library, "rubberband_" + name)
            fn.argtypes, fn.restype = args, result
            return fn

        create = bind("new", [uint, uint, ct.c_int, ct.c_double, ct.c_double], state_type)
        destroy = bind("delete", [state_type])
        version = bind("get_engine_version", [state_type], ct.c_int)
        set_duration = bind("set_expected_input_duration", [state_type, uint])
        set_block = bind("set_max_process_size", [state_type, uint])
        set_map = bind("set_key_frame_map", [state_type, uint, ct.POINTER(uint), ct.POINTER(uint)])
        study = bind("study", [state_type, channels_ptr, uint, ct.c_int])
        process = bind("process", [state_type, channels_ptr, uint, ct.c_int])
        available = bind("available", [state_type], ct.c_int)
        retrieve = bind("retrieve", [state_type, channels_ptr, uint], uint)
        planar = np.ascontiguousarray(samples.T, dtype=np.float32)
        channels, frames = planar.shape
        if max(frames, plan["outputFrames"]) >= 2 ** 32:
            raise ValueError("BPM_FIX_AUDIO_TOO_LONG")
        # Offline, R3 multi-resolution, stereo channels together. Pitch is 1.0.
        options = 0x20000000 | 0x10000000 | 0x00010000
        state = create(sr, channels, options, plan["outputFrames"] / frames, 1.0)
        if not state:
            raise RuntimeError("BPM_FIX_RENDERER_INIT_FAILED")
        try:
            if version(state) != 3:
                raise RuntimeError("BPM_FIX_R3_REQUIRED")
            # R3 updates key-frame ratios once per process() call. 8192 frames
            # delays a map change by up to 186 ms at 44.1 kHz. Bound calls to
            # one standard 512-frame DSP block and at most 10 ms at any rate.
            block = max(1, min(512, sr // 100))
            set_block(state, block)
            set_duration(state, frames)
            # Endpoints are expressed by the duration/ratio. Passing the final
            # frame (outside the material) as a keyframe gives some R3 builds
            # a zero-length last segment.
            source = np.ascontiguousarray(plan["from"][1:-1], dtype=np.uint32)
            target = np.ascontiguousarray(plan["to"][1:-1], dtype=np.uint32)
            set_map(state, len(source), source.ctypes.data_as(ct.POINTER(uint)),
                    target.ctypes.data_as(ct.POINTER(uint)))

            def pointers(array):
                return (float_ptr * channels)(*(row.ctypes.data_as(float_ptr) for row in array))

            for start in range(0, frames, block):
                part = np.ascontiguousarray(planar[:, start:start + block])
                study(state, pointers(part), part.shape[1], int(start + block >= frames))
                if progress:
                    progress(0.2 * min(1.0, (start + block) / frames))
            chunks = []
            retrieved = 0

            def drain():
                nonlocal retrieved
                while True:
                    count = available(state)
                    if count <= 0:
                        return count
                    result = np.empty((channels, min(count, block * 4)), dtype=np.float32)
                    n = retrieve(state, pointers(result), result.shape[1])
                    if not n:
                        raise RuntimeError("BPM_FIX_RENDERER_STALLED")
                    chunks.append(result[:, :n].copy())
                    retrieved += n
                    if retrieved > plan["outputFrames"] + sr * 2:
                        raise RuntimeError("BPM_FIX_RENDERER_LENGTH_MISMATCH")

            for start in range(0, frames, block):
                part = np.ascontiguousarray(planar[:, start:start + block])
                process(state, pointers(part), part.shape[1], int(start + block >= frames))
                drain()
                if progress:
                    progress(0.2 + 0.8 * min(1.0, (start + block) / frames))
            if drain() != -1 or retrieved != plan["outputFrames"]:
                raise RuntimeError(f"BPM_FIX_RENDERER_LENGTH_MISMATCH: {retrieved} != {plan['outputFrames']}")
            rendered = np.ascontiguousarray(np.concatenate(chunks, axis=1).T)
            if not np.all(np.isfinite(rendered)):
                raise RuntimeError("BPM_FIX_INVALID_AUDIO")
            return rendered
        finally:
            destroy(state)
    finally:
        if dll_scope:
            dll_scope.close()
