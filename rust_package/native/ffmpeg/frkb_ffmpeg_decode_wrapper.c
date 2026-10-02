/**
 * FRKB FFmpeg decode wrapper.
 * Decodes audio files using libavcodec/libavformat/libswresample.
 * Provides direct Chromaprint fingerprint generation.
 */

#include "frkb_ffmpeg_decode_wrapper.h"
#include "chromaprint.h"

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/mathematics.h>
#include <libavutil/avutil.h>
#include <libavutil/intreadwrite.h>
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
#include <libswresample/swresample.h>

#include <stdlib.h>
#include <string.h>
#include <stdint.h>

/* Error codes */
#define FRKB_ERR_OPEN_INPUT     1
#define FRKB_ERR_STREAM_INFO    2
#define FRKB_ERR_NO_AUDIO       3
#define FRKB_ERR_OPEN_CODEC     4
#define FRKB_ERR_SWR_INIT       5
#define FRKB_ERR_ALLOC          6
#define FRKB_ERR_CHROMAPRINT    7
#define FRKB_ERR_SEEK           8
#define FRKB_ERR_DECODE         9
#define FRKB_ERR_INVALID_ARG    10
#define FRKB_ERR_CANCELLED      11

/* Target output format: interleaved s16, stereo */
#define TARGET_SAMPLE_FMT AV_SAMPLE_FMT_S16
#define TARGET_CHANNELS   2

/**
 * Decode context holding all FFmpeg and output state.
 */
typedef struct {
    AVFormatContext *fmt_ctx;
    AVCodecContext  *dec_ctx;
    SwrContext      *swr_ctx;
    int              audio_stream_idx;
    int              out_sample_rate;
    int              out_channels;
} DecodeContext;

static void decode_ctx_free(DecodeContext *ctx) {
    if (ctx->swr_ctx)   swr_free(&ctx->swr_ctx);
    if (ctx->dec_ctx)   avcodec_free_context(&ctx->dec_ctx);
    if (ctx->fmt_ctx)   avformat_close_input(&ctx->fmt_ctx);
}

/* Audio operations must not probe or decode embedded artwork/video streams. */
static void discard_non_audio_streams(AVFormatContext *fmt_ctx) {
    for (unsigned int i = 0; i < fmt_ctx->nb_streams; i++) {
        AVStream *stream = fmt_ctx->streams[i];
        if (stream->codecpar && stream->codecpar->codec_type != AVMEDIA_TYPE_AUDIO) {
            stream->discard = AVDISCARD_ALL;
        }
    }
}

/**
 * Initialize the decode context: open file, find audio stream, open codec, set up resampler.
 * Returns 0 on success.
 */
static int decode_ctx_init(
    DecodeContext *ctx,
    const char *file_path,
    int target_sample_rate,
    int target_channels)
{
    memset(ctx, 0, sizeof(*ctx));
    av_log_set_level(AV_LOG_ERROR);

    int ret = avformat_open_input(&ctx->fmt_ctx, file_path, NULL, NULL);
    if (ret < 0) return FRKB_ERR_OPEN_INPUT;

    ret = avformat_find_stream_info(ctx->fmt_ctx, NULL);
    if (ret < 0) return FRKB_ERR_STREAM_INFO;

    /* Find best audio stream */
    ret = av_find_best_stream(ctx->fmt_ctx, AVMEDIA_TYPE_AUDIO, -1, -1, NULL, 0);
    if (ret < 0) return FRKB_ERR_NO_AUDIO;
    ctx->audio_stream_idx = ret;

    AVStream *stream = ctx->fmt_ctx->streams[ctx->audio_stream_idx];
    const AVCodec *codec = avcodec_find_decoder(stream->codecpar->codec_id);
    if (!codec) return FRKB_ERR_NO_AUDIO;

    ctx->dec_ctx = avcodec_alloc_context3(codec);
    if (!ctx->dec_ctx) return FRKB_ERR_ALLOC;

    ret = avcodec_parameters_to_context(ctx->dec_ctx, stream->codecpar);
    if (ret < 0) return FRKB_ERR_OPEN_CODEC;

    ret = avcodec_open2(ctx->dec_ctx, codec, NULL);
    if (ret < 0) return FRKB_ERR_OPEN_CODEC;

    /* transport 调用方会传入固定输出格式，用来对齐现有 FFmpeg CLI 路径。 */
    int src_channels = ctx->dec_ctx->ch_layout.nb_channels;
    ctx->out_channels = target_channels > 0
        ? target_channels
        : ((src_channels == 1 || src_channels == 2) ? src_channels : TARGET_CHANNELS);
    ctx->out_sample_rate = target_sample_rate > 0 ? target_sample_rate : ctx->dec_ctx->sample_rate;

    /* Set up SwrContext for conversion to interleaved s16 */
    AVChannelLayout out_layout = (ctx->out_channels == 1)
        ? (AVChannelLayout)AV_CHANNEL_LAYOUT_MONO
        : (AVChannelLayout)AV_CHANNEL_LAYOUT_STEREO;

    ret = swr_alloc_set_opts2(&ctx->swr_ctx,
        &out_layout, TARGET_SAMPLE_FMT, ctx->out_sample_rate,
        &ctx->dec_ctx->ch_layout, ctx->dec_ctx->sample_fmt, ctx->dec_ctx->sample_rate,
        0, NULL);
    if (ret < 0 || !ctx->swr_ctx) return FRKB_ERR_SWR_INIT;

    ret = swr_init(ctx->swr_ctx);
    if (ret < 0) return FRKB_ERR_SWR_INIT;

    return 0;
}

static int append_i16_samples(
    int16_t **samples,
    size_t *sample_count,
    size_t *sample_capacity,
    const int16_t *source,
    size_t source_count)
{
    if (source_count == 0) return 0;
    if (*sample_count > SIZE_MAX - source_count) return FRKB_ERR_ALLOC;

    size_t needed = *sample_count + source_count;
    if (needed > *sample_capacity) {
        size_t next_capacity = *sample_capacity == 0 ? 8192 : *sample_capacity;
        while (next_capacity < needed) {
            if (next_capacity > SIZE_MAX / 2) {
                next_capacity = needed;
                break;
            }
            next_capacity *= 2;
        }
        int16_t *next = (int16_t *)realloc(*samples, next_capacity * sizeof(int16_t));
        if (!next) return FRKB_ERR_ALLOC;
        *samples = next;
        *sample_capacity = next_capacity;
    }

    memcpy(*samples + *sample_count, source, source_count * sizeof(int16_t));
    *sample_count = needed;
    return 0;
}

static int frame_start_seconds(
    AVFrame *frame,
    AVStream *stream,
    double *frame_start_sec)
{
    int64_t pts = frame->best_effort_timestamp;
    if (pts == AV_NOPTS_VALUE) return 0;
    *frame_start_sec = (double)pts * av_q2d(stream->time_base);
    return 1;
}

static int decode_should_cancel(void *cancel_opaque, int (*should_cancel)(void *))
{
    if (!should_cancel) return 0;
    return should_cancel(cancel_opaque) != 0;
}

static int is_recoverable_decode_error(int ret)
{
    return ret == AVERROR_INVALIDDATA;
}

/* ===================== Public API ===================== */

int frkb_ffmpeg_chromaprint_generate(
    const char *file_path,
    int max_duration_sec,
    char **fingerprint_out,
    double *duration_out)
{
    if (!file_path || !fingerprint_out || !duration_out) return FRKB_ERR_ALLOC;
    if (max_duration_sec <= 0) max_duration_sec = 120;

    DecodeContext ctx;
    int ret = decode_ctx_init(&ctx, file_path, 0, 0);
    if (ret != 0) return ret;

    /* Create Chromaprint context */
    ChromaprintContext *cp_ctx = chromaprint_new(CHROMAPRINT_ALGORITHM_DEFAULT);
    if (!cp_ctx) { decode_ctx_free(&ctx); return FRKB_ERR_CHROMAPRINT; }

    if (!chromaprint_start(cp_ctx, ctx.out_sample_rate, ctx.out_channels)) {
        chromaprint_free(cp_ctx);
        decode_ctx_free(&ctx);
        return FRKB_ERR_CHROMAPRINT;
    }

    int64_t max_total_samples = (int64_t)ctx.out_sample_rate * ctx.out_channels * max_duration_sec;
    int64_t total_samples_decoded = 0;

    AVPacket *pkt = av_packet_alloc();
    AVFrame  *frame = av_frame_alloc();
    if (!pkt || !frame) {
        chromaprint_free(cp_ctx);
        decode_ctx_free(&ctx);
        return FRKB_ERR_ALLOC;
    }

    /* Temporary buffer for swr_convert output */
    int buf_capacity = 4096 * ctx.out_channels;
    int16_t *buf = (int16_t *)malloc(buf_capacity * sizeof(int16_t));
    if (!buf) {
        av_frame_free(&frame);
        av_packet_free(&pkt);
        chromaprint_free(cp_ctx);
        decode_ctx_free(&ctx);
        return FRKB_ERR_ALLOC;
    }

    while (av_read_frame(ctx.fmt_ctx, pkt) >= 0) {
        if (pkt->stream_index != ctx.audio_stream_idx) {
            av_packet_unref(pkt);
            continue;
        }

        ret = avcodec_send_packet(ctx.dec_ctx, pkt);
        av_packet_unref(pkt);
        if (ret < 0) break;

        while ((ret = avcodec_receive_frame(ctx.dec_ctx, frame)) == 0) {
            int out_count = swr_get_out_samples(ctx.swr_ctx, frame->nb_samples);
            if (out_count < 0) out_count = frame->nb_samples * 2;

            int needed = out_count * ctx.out_channels;
            if (needed > buf_capacity) {
                buf_capacity = needed * 2;
                int16_t *new_buf = (int16_t *)realloc(buf, buf_capacity * sizeof(int16_t));
                if (!new_buf) { ret = FRKB_ERR_ALLOC; goto finish; }
                buf = new_buf;
            }

            uint8_t *cp_out[1] = { (uint8_t *)buf };
            int converted = swr_convert(ctx.swr_ctx,
                cp_out, out_count,
                (const uint8_t **)frame->extended_data, frame->nb_samples);

            if (converted > 0) {
                int samples_to_feed = converted * ctx.out_channels;
                total_samples_decoded += samples_to_feed;

                if (!chromaprint_feed(cp_ctx, buf, samples_to_feed)) {
                    ret = FRKB_ERR_CHROMAPRINT;
                    goto finish;
                }

                if (max_total_samples > 0 && total_samples_decoded >= max_total_samples) {
                    goto finish;
                }
            }
        }

        if (ret != AVERROR(EAGAIN)) break;
    }

    /* Flush decoder */
    avcodec_send_packet(ctx.dec_ctx, NULL);
    while (avcodec_receive_frame(ctx.dec_ctx, frame) == 0) {
        int out_count = frame->nb_samples * 2;
        int needed = out_count * ctx.out_channels;
        if (needed > buf_capacity) {
            buf_capacity = needed * 2;
            int16_t *new_buf = (int16_t *)realloc(buf, buf_capacity * sizeof(int16_t));
            if (!new_buf) { ret = FRKB_ERR_ALLOC; goto finish; }
            buf = new_buf;
        }
        uint8_t *cp_out_flush[1] = { (uint8_t *)buf };
        int converted = swr_convert(ctx.swr_ctx,
            cp_out_flush, out_count,
            (const uint8_t **)frame->extended_data, frame->nb_samples);
        if (converted > 0) {
            int samples_to_feed = converted * ctx.out_channels;
            total_samples_decoded += samples_to_feed;
            if (!chromaprint_feed(cp_ctx, buf, samples_to_feed)) {
                ret = FRKB_ERR_CHROMAPRINT;
                goto finish;
            }
        }
    }
    ret = 0;

finish:
    free(buf);
    av_frame_free(&frame);
    av_packet_free(&pkt);

    if (ret == 0) {
        if (!chromaprint_finish(cp_ctx)) ret = FRKB_ERR_CHROMAPRINT;
    }

    if (ret == 0) {
        char *fp = NULL;
        if (!chromaprint_get_fingerprint(cp_ctx, &fp)) {
            ret = FRKB_ERR_CHROMAPRINT;
        } else {
            *fingerprint_out = fp;
            *duration_out = (double)total_samples_decoded / (ctx.out_sample_rate * ctx.out_channels);
        }
    }

    chromaprint_free(cp_ctx);
    decode_ctx_free(&ctx);
    return ret;
}

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
    void *cancel_opaque,
    int (*should_cancel)(void *cancel_opaque))
{
    if (!file_path || !samples_out || !sample_count_out || !sample_rate_out || !channels_out) {
        return FRKB_ERR_INVALID_ARG;
    }
    *samples_out = NULL;
    *sample_count_out = 0;
    *sample_rate_out = 0;
    *channels_out = 0;

    if (start_sec < 0.0) start_sec = 0.0;

    DecodeContext ctx;
    int ret = decode_ctx_init(&ctx, file_path, target_sample_rate, target_channels);
    if (ret != 0) return ret;

    if (decode_should_cancel(cancel_opaque, should_cancel)) {
        decode_ctx_free(&ctx);
        return FRKB_ERR_CANCELLED;
    }

    AVStream *stream = ctx.fmt_ctx->streams[ctx.audio_stream_idx];
    if (start_sec > 0.0) {
        int64_t seek_ts = av_rescale_q(
            (int64_t)(start_sec * AV_TIME_BASE),
            AV_TIME_BASE_Q,
            stream->time_base);
        ret = av_seek_frame(ctx.fmt_ctx, ctx.audio_stream_idx, seek_ts, AVSEEK_FLAG_BACKWARD);
        if (ret < 0) {
            decode_ctx_free(&ctx);
            return FRKB_ERR_SEEK;
        }
        avcodec_flush_buffers(ctx.dec_ctx);
    }

    if (decode_should_cancel(cancel_opaque, should_cancel)) {
        decode_ctx_free(&ctx);
        return FRKB_ERR_CANCELLED;
    }

    int64_t max_frames = max_duration_sec > 0.0
        ? (int64_t)(max_duration_sec * ctx.out_sample_rate + 0.5)
        : INT64_MAX;
    int64_t written_frames = 0;
    int reached_limit = 0;

    AVPacket *pkt = av_packet_alloc();
    AVFrame *frame = av_frame_alloc();
    if (!pkt || !frame) {
        av_frame_free(&frame);
        av_packet_free(&pkt);
        decode_ctx_free(&ctx);
        return FRKB_ERR_ALLOC;
    }

    int buf_capacity_frames = 4096;
    int16_t *buf = (int16_t *)malloc((size_t)buf_capacity_frames * ctx.out_channels * sizeof(int16_t));
    if (!buf) {
        av_frame_free(&frame);
        av_packet_free(&pkt);
        decode_ctx_free(&ctx);
        return FRKB_ERR_ALLOC;
    }

    int16_t *samples = NULL;
    size_t sample_count = 0;
    size_t sample_capacity = 0;

    while (!reached_limit && av_read_frame(ctx.fmt_ctx, pkt) >= 0) {
        if (decode_should_cancel(cancel_opaque, should_cancel)) {
            ret = FRKB_ERR_CANCELLED;
            goto finish_transport;
        }
        if (pkt->stream_index != ctx.audio_stream_idx) {
            av_packet_unref(pkt);
            continue;
        }

        ret = avcodec_send_packet(ctx.dec_ctx, pkt);
        av_packet_unref(pkt);
        if (ret < 0) {
            if (is_recoverable_decode_error(ret)) {
                continue;
            }
            ret = FRKB_ERR_DECODE;
            goto finish_transport;
        }

        while ((ret = avcodec_receive_frame(ctx.dec_ctx, frame)) == 0) {
            if (decode_should_cancel(cancel_opaque, should_cancel)) {
                ret = FRKB_ERR_CANCELLED;
                goto finish_transport;
            }
            int out_count = (int)av_rescale_rnd(
                swr_get_delay(ctx.swr_ctx, ctx.dec_ctx->sample_rate) + frame->nb_samples,
                ctx.out_sample_rate,
                ctx.dec_ctx->sample_rate,
                AV_ROUND_UP);
            if (out_count < frame->nb_samples) out_count = frame->nb_samples;

            int needed = out_count * ctx.out_channels;
            if (out_count > buf_capacity_frames) {
                buf_capacity_frames = out_count * 2;
                int16_t *next_buf = (int16_t *)realloc(
                    buf,
                    (size_t)buf_capacity_frames * ctx.out_channels * sizeof(int16_t));
                if (!next_buf) {
                    ret = FRKB_ERR_ALLOC;
                    goto finish_transport;
                }
                buf = next_buf;
            }

            uint8_t *out_planes[1] = { (uint8_t *)buf };
            int converted = swr_convert(
                ctx.swr_ctx,
                out_planes,
                out_count,
                (const uint8_t **)frame->extended_data,
                frame->nb_samples);
            if (converted < 0) {
                ret = FRKB_ERR_DECODE;
                goto finish_transport;
            }
            if (converted == 0) {
                av_frame_unref(frame);
                continue;
            }

            int skip_frames = 0;
            if (start_sec > 0.0) {
                double current_frame_start_sec = 0.0;
                if (frame_start_seconds(frame, stream, &current_frame_start_sec)) {
                    double delta_sec = start_sec - current_frame_start_sec;
                    if (delta_sec > 0.0) {
                        skip_frames = (int)(delta_sec * ctx.out_sample_rate + 0.5);
                        if (skip_frames >= converted) {
                            av_frame_unref(frame);
                            continue;
                        }
                    }
                }
            }

            int take_frames = converted - skip_frames;
            int64_t remaining_frames = max_frames - written_frames;
            if (remaining_frames <= 0) {
                reached_limit = 1;
                av_frame_unref(frame);
                break;
            }
            if ((int64_t)take_frames > remaining_frames) {
                take_frames = (int)remaining_frames;
                reached_limit = 1;
            }

            const int16_t *source = buf + ((size_t)skip_frames * ctx.out_channels);
            size_t source_count = (size_t)take_frames * ctx.out_channels;
            ret = append_i16_samples(&samples, &sample_count, &sample_capacity, source, source_count);
            if (ret != 0) goto finish_transport;
            written_frames += take_frames;
            av_frame_unref(frame);
        }

        if (ret == AVERROR_EOF) break;
        if (ret != AVERROR(EAGAIN)) {
            ret = FRKB_ERR_DECODE;
            goto finish_transport;
        }
    }

    if (!reached_limit) {
        avcodec_send_packet(ctx.dec_ctx, NULL);
        while ((ret = avcodec_receive_frame(ctx.dec_ctx, frame)) == 0) {
            if (decode_should_cancel(cancel_opaque, should_cancel)) {
                ret = FRKB_ERR_CANCELLED;
                goto finish_transport;
            }
            int out_count = (int)av_rescale_rnd(
                swr_get_delay(ctx.swr_ctx, ctx.dec_ctx->sample_rate) + frame->nb_samples,
                ctx.out_sample_rate,
                ctx.dec_ctx->sample_rate,
                AV_ROUND_UP);
            if (out_count < frame->nb_samples) out_count = frame->nb_samples;
            if (out_count > buf_capacity_frames) {
                buf_capacity_frames = out_count * 2;
                int16_t *next_buf = (int16_t *)realloc(
                    buf,
                    (size_t)buf_capacity_frames * ctx.out_channels * sizeof(int16_t));
                if (!next_buf) {
                    ret = FRKB_ERR_ALLOC;
                    goto finish_transport;
                }
                buf = next_buf;
            }

            uint8_t *out_planes[1] = { (uint8_t *)buf };
            int converted = swr_convert(
                ctx.swr_ctx,
                out_planes,
                out_count,
                (const uint8_t **)frame->extended_data,
                frame->nb_samples);
            if (converted < 0) {
                ret = FRKB_ERR_DECODE;
                goto finish_transport;
            }
            if (converted > 0) {
                int take_frames = converted;
                int64_t remaining_frames = max_frames - written_frames;
                if (remaining_frames <= 0) {
                    reached_limit = 1;
                    av_frame_unref(frame);
                    break;
                }
                if ((int64_t)take_frames > remaining_frames) {
                    take_frames = (int)remaining_frames;
                    reached_limit = 1;
                }
                ret = append_i16_samples(
                    &samples,
                    &sample_count,
                    &sample_capacity,
                    buf,
                    (size_t)take_frames * ctx.out_channels);
                if (ret != 0) goto finish_transport;
                written_frames += take_frames;
            }
            av_frame_unref(frame);
            if (reached_limit) break;
        }
    }

    ret = 0;

finish_transport:
    free(buf);
    av_frame_free(&frame);
    av_packet_free(&pkt);
    decode_ctx_free(&ctx);

    if (ret != 0) {
        free(samples);
        return ret;
    }

    *samples_out = samples;
    *sample_count_out = sample_count;
    *sample_rate_out = ctx.out_sample_rate;
    *channels_out = ctx.out_channels;
    return 0;
}

void frkb_ffmpeg_transport_free_samples(int16_t *ptr)
{
    free(ptr);
}

int frkb_ffmpeg_probe_time_basis(
    const char *file_path,
    int read_skip_samples,
    double *start_time_sec_out,
    int *sample_rate_out,
    int *skip_samples_out,
    char *encoder_out,
    int encoder_out_cap)
{
    if (!file_path || !start_time_sec_out || !sample_rate_out || !skip_samples_out) {
        return FRKB_ERR_INVALID_ARG;
    }
    if (encoder_out && encoder_out_cap > 0) {
        encoder_out[0] = '\0';
    }

    AVFormatContext *fmt_ctx = NULL;
    int ret = avformat_open_input(&fmt_ctx, file_path, NULL, NULL);
    if (ret < 0) return FRKB_ERR_OPEN_INPUT;

    discard_non_audio_streams(fmt_ctx);
    /* MP3's demuxer already reads Xing/LAME lead-in. Reading its first audio
     * packet fills the sample rate through the MP3 parser; probing all streams
     * would unnecessarily decode APIC artwork, including mislabeled images. */
    int is_mp3 = fmt_ctx->iformat && strcmp(fmt_ctx->iformat->name, "mp3") == 0;
    if (!is_mp3) {
        ret = avformat_find_stream_info(fmt_ctx, NULL);
        if (ret < 0) {
            avformat_close_input(&fmt_ctx);
            return FRKB_ERR_STREAM_INFO;
        }
    }

    if (is_mp3) {
        /* MP3 has a single audio stream whose parameters are populated by the
         * first packet. av_find_best_stream requires those parameters upfront. */
        ret = -1;
        for (unsigned int i = 0; i < fmt_ctx->nb_streams; i++) {
            if (fmt_ctx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
                ret = (int)i;
                break;
            }
        }
    } else {
        ret = av_find_best_stream(fmt_ctx, AVMEDIA_TYPE_AUDIO, -1, -1, NULL, 0);
    }
    if (ret < 0) {
        avformat_close_input(&fmt_ctx);
        return FRKB_ERR_NO_AUDIO;
    }

    AVStream *stream = fmt_ctx->streams[ret];
    *sample_rate_out = stream->codecpar ? stream->codecpar->sample_rate : 0;
    *skip_samples_out = 0;
    *start_time_sec_out = 0.0;
    if (stream->start_time != AV_NOPTS_VALUE) {
        *start_time_sec_out = (double)stream->start_time * av_q2d(stream->time_base);
    }

    if (encoder_out && encoder_out_cap > 1) {
        AVDictionaryEntry *encoder = av_dict_get(stream->metadata, "encoder", NULL, 0);
        if (!encoder) {
            encoder = av_dict_get(fmt_ctx->metadata, "encoder", NULL, 0);
        }
        if (encoder && encoder->value) {
            strncpy(encoder_out, encoder->value, (size_t)encoder_out_cap - 1);
            encoder_out[encoder_out_cap - 1] = '\0';
        }
    }

    if (!is_mp3 && (*start_time_sec_out <= 0.0 || !read_skip_samples)) {
        avformat_close_input(&fmt_ctx);
        return 0;
    }

    AVPacket *pkt = av_packet_alloc();
    if (!pkt) {
        avformat_close_input(&fmt_ctx);
        return FRKB_ERR_ALLOC;
    }
    while (av_read_frame(fmt_ctx, pkt) >= 0) {
        if (pkt->stream_index == ret) {
            *sample_rate_out = stream->codecpar ? stream->codecpar->sample_rate : 0;
            for (int i = 0; i < pkt->side_data_elems; i += 1) {
                if (pkt->side_data[i].type == AV_PKT_DATA_SKIP_SAMPLES && pkt->side_data[i].size >= 4) {
                    *skip_samples_out = (int)AV_RL32(pkt->side_data[i].data);
                    break;
                }
            }
            av_packet_unref(pkt);
            break;
        }
        av_packet_unref(pkt);
    }
    av_packet_free(&pkt);
    avformat_close_input(&fmt_ctx);
    return 0;
}
