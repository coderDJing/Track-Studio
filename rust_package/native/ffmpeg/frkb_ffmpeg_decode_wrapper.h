#ifndef FRKB_FFMPEG_DECODE_WRAPPER_H
#define FRKB_FFMPEG_DECODE_WRAPPER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Decode an audio file and generate a Chromaprint fingerprint in one pass.
 * Streams decoded audio directly to Chromaprint without buffering the full PCM.
 *
 * @param file_path         Path to the audio file.
 * @param max_duration_sec  Maximum seconds to process (0 = no limit, default 120).
 * @param fingerprint_out   Receives allocated base64 fingerprint string (caller must call frkb_chromaprint_free_string).
 * @param duration_out      Receives the actual duration processed in seconds.
 * @return 0 on success, non-zero error code on failure.
 */
int frkb_ffmpeg_chromaprint_generate(
    const char *file_path,
    int max_duration_sec,
    char **fingerprint_out,
    double *duration_out
);

/**
 * 使用 FFmpeg libav* 直接解码横向浏览播放器所需的音频片段。
 * 输出格式刻意对齐现有 CLI 路径：交错 s16le、target_sample_rate Hz、target_channels 声道。
 *
 * start_sec 契约：相对“第一份可听音频样本”的秒数，而不是容器/编码时间戳。
 * wrapper 会用 stream/format 的正 start_time 与 skip_samples 把请求位置换算到
 * 流时间戳，并返回第一份实际输出样本的可听起点，调用方可校验坐标。
 * 非零 start_sec 会先做有界 preroll（TRANSPORT_PREROLL_SEC）恢复解码器/重采样器
 * 状态，preroll 样本全部丢弃，不进入输出；start_sec == 0 不做 preroll。
 *
 * @param file_path             音频文件路径。
 * @param start_sec             开始位置，单位秒（相对可听音频起点）。
 * @param max_duration_sec      最大解码时长，0 表示不限。
 * @param target_sample_rate    输出采样率，0 表示保留源采样率；transport 通常为 44100。
 * @param target_channels       输出声道数，0 表示按源声道保留 mono/stereo；transport 通常为 2。
 * @param samples_out           接收分配后的交错 i16 样本。
 * @param sample_count_out      接收 i16 样本数，不是帧数。
 * @param sample_rate_out       接收输出采样率。
 * @param channels_out          接收输出声道数。
 * @param actual_start_sec_out  接收第一份输出样本的可听起点秒数；可为 NULL。
 * @return 成功返回 0，失败返回非 0 错误码。
 */
int frkb_ffmpeg_transport_decode(
    const char *file_path,
    double start_sec,
    double max_duration_sec,
    int target_sample_rate,
    int target_channels,
    int16_t **samples_out,
    size_t *sample_count_out,
    int *sample_rate_out,
    int *channels_out,
    double *actual_start_sec_out,
    void *cancel_opaque,
    int (*should_cancel)(void *cancel_opaque)
);

/**
 * 释放 frkb_ffmpeg_transport_decode 返回的样本缓冲区。
 */
void frkb_ffmpeg_transport_free_samples(int16_t *ptr);

/**
 * 只探测时间基，不解码整轨。
 * start_time 与 ffprobe stream.start_time 对齐；skip_samples 来自首包 Skip Samples。
 * read_skip_samples 非 0 时才读第一包（与现有 JS 仅对 mp3 读 packet 对齐）。
 */
int frkb_ffmpeg_probe_time_basis(
    const char *file_path,
    int read_skip_samples,
    double *start_time_sec_out,
    int *sample_rate_out,
    int *skip_samples_out,
    char *encoder_out,
    int encoder_out_cap
);

#ifdef __cplusplus
}
#endif

#endif
