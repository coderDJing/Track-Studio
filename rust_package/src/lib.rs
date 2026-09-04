//! 音频文件处理模块
//! 仅提供基于解码后 PCM 的内容哈希（SHA256）

// 启用所有 clippy lint 检查
#![deny(clippy::all)]

// ===== 导入依赖 =====
// 基础功能
use std::borrow::Cow;
use std::fs::File;
use std::io::Read;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::result::Result as StdResult;
use std::sync::Arc;

// 并行处理
use num_cpus;
use parking_lot::Mutex;
use rayon::prelude::*;

// Node.js 绑定
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};

// 音频处理
use symphonia::core::audio::{AudioBufferRef, SampleBuffer, Signal, SignalSpec};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader, Track};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{Limit, MetadataOptions};
use symphonia::core::probe::Hint;
use symphonia::default::get_probe;

// 哈希
use bytemuck::{cast_slice, try_cast_slice};
use hex;
use ring::digest::{Context, SHA256};

// 常量（已不再需要文件级哈希缓冲区）

// 启用 napi 宏
#[macro_use]
extern crate napi_derive;

mod analysis_utils;
mod chromaprint_native;
mod ffmpeg_decode;
pub use crate::ffmpeg_decode::{
  probe_audio_time_basis_offset_ms, probe_audio_time_basis_offset_ms_batch,
};
mod horizontal_browse_transport;
mod mixxx_waveform;
mod pioneer_anlz_raw;
mod pioneer_cues;
mod pioneer_export;
mod playlist_scan;
mod qm_key;

pub use crate::horizontal_browse_transport::*;
pub use crate::playlist_scan::*;
use crate::mixxx_waveform::MixxxWaveformData;
pub use crate::pioneer_cues::*;
pub use crate::pioneer_export::*;

// ===== 类型定义 =====

/// 进度信息结构体
#[napi(object)]
pub struct ProcessProgress {
  pub processed: i32,
  pub total: i32,
}

/// 音频文件处理结果
#[napi(object)]
#[derive(Debug)]
pub struct AudioFileResult {
  /// 整个文件的 SHA256（当前为标准化 PCM 内容哈希），用于去重
  pub sha256_hash: String,
  /// 原始文件路径
  pub file_path: String,
  /// 错误描述（当分析失败时）
  pub error: Option<String>,
}

/// 音频解码结果
#[napi(object)]
pub struct DecodeAudioResult {
  /// PCM 数据（Buffer，内部为 f32 小端序，需在 JS 侧转为 Float32Array）
  pub pcm_data: Buffer,
  /// 采样率
  pub sample_rate: u32,
  /// 声道数
  pub channels: u8,
  /// 总帧数
  pub total_frames: f64,
  /// 解码后端（symphonia / ffmpeg / ffmpeg-fallback）
  pub decoder_backend: Option<String>,
  /// 错误描述（当解码失败时）
  pub error: Option<String>,
}

/// 调性分析结果
#[napi(object)]
pub struct KeyAnalysisResult {
  /// ID3v2 ASCII key 文本
  pub key_text: String,
  /// 错误描述（当分析失败时）
  pub error: Option<String>,
}

impl AudioFileResult {
  fn error(path: &Path, err: &str) -> Self {
    AudioFileResult {
      sha256_hash: "error".to_string(),
      file_path: path.to_string_lossy().to_string(),
      error: Some(err.to_string()),
    }
  }

  fn with_path(path: &Path) -> Self {
    AudioFileResult {
      sha256_hash: String::new(),
      file_path: path.to_string_lossy().to_string(),
      error: None,
    }
  }
}

/// 异步任务结构体
pub struct AudioProcessTask {
  file_paths: Vec<String>,
  callback: Option<ThreadsafeFunction<ProcessProgress>>,
}

// ===== 公共 API =====

/// 计算音频文件的 SHA256 哈希值，并生成声纹与质量标签
///
/// # 参数
/// * `file_paths` - 音频文件路径数组
///
/// # 返回值
/// * 包含每个文件哈希值和路径的结果数组
#[napi]
pub fn calculate_audio_hashes(file_paths: Vec<String>) -> Vec<AudioFileResult> {
  // 并行处理所有文件
  file_paths
    .par_iter()
    .map(|path| calculate_audio_hash_for_file(path))
    .collect::<Vec<AudioFileResult>>()
}

/// 带进度回调的异步音频处理
#[napi]
pub async fn calculate_audio_hashes_with_progress(
  file_paths: Vec<String>,
  callback: Option<ThreadsafeFunction<ProcessProgress>>,
) -> napi::Result<Vec<AudioFileResult>> {
  let mut task = AudioProcessTask {
    file_paths,
    callback,
  };
  task.compute()
}

/// 计算整文件 SHA256（不解码，速度快；与 PCM 内容哈希互不兼容）
#[napi]
pub fn calculate_file_hashes(file_paths: Vec<String>) -> Vec<AudioFileResult> {
  file_paths
    .par_iter()
    .map(|path| calculate_file_hash_for_file(path))
    .collect::<Vec<AudioFileResult>>()
}

/// 计算整文件 SHA256（带进度）
#[napi]
pub async fn calculate_file_hashes_with_progress(
  file_paths: Vec<String>,
  callback: Option<ThreadsafeFunction<ProcessProgress>>,
) -> napi::Result<Vec<AudioFileResult>> {
  let total = file_paths.len() as i32;
  let results = Arc::new(Mutex::new(Vec::with_capacity(file_paths.len())));
  let processed = Arc::new(std::sync::atomic::AtomicI32::new(0));

  // 计算分块大小（与音频版本保持一致的策略）
  let chunk_size = {
    let cpu_count = num_cpus::get();
    let ideal_chunks = (file_paths.len() / 10).max(1);
    (file_paths.len() / ideal_chunks.min(cpu_count * 2)).max(1)
  };

  if let Some(callback) = callback {
    let callback = callback.clone();
    rayon::scope(|s| {
      for chunk in file_paths.chunks(chunk_size) {
        let results = Arc::clone(&results);
        let callback = callback.clone();
        let processed = Arc::clone(&processed);
        s.spawn(move |_| {
          let mut local_results = Vec::with_capacity(chunk.len());
          for path in chunk {
            let result = calculate_file_hash_for_file(path);
            let current = processed.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let progress = ProcessProgress {
              processed: current,
              total,
            };
            callback.call(Ok(progress), ThreadsafeFunctionCallMode::Blocking);
            local_results.push(result);
          }
          results.lock().extend(local_results);
        });
      }
    });
  } else {
    // 无回调时直接并行处理
    file_paths.par_iter().for_each(|path| {
      let result = calculate_file_hash_for_file(path);
      results.lock().push(result);
    });
  }

  Ok(Arc::try_unwrap(results).unwrap().into_inner())
}

/// 解码音频文件为 PCM Float32Array
///
/// # 参数
/// * `file_path` - 音频文件路径
///
/// # 返回值
/// * 包含 PCM 数据和元数据的解码结果
#[napi]
pub fn decode_audio_file(file_path: String) -> DecodeAudioResult {
  let path = Path::new(&file_path);
  let ext = path
    .extension()
    .and_then(|s| s.to_str())
    .map(|s| s.to_ascii_lowercase())
    .unwrap_or_default();

  // 已知仅 FFmpeg 覆盖较好的格式：避免多此一举的探测/失败再回退
  // 仍保留兜底回退用于异常情况（伪装扩展名/损坏文件等）
  let ffmpeg_only_exts = [
    "wma", "ac3", "dts", "mka", "webm", "ape", "tak", "tta",
    "wv",
    // 其他非常见格式如 voc/au/amr/gsm/ra/spx/mp2/mp1/mpc/shn/thd/dtshd 如后续加入设置也会被 FFmpeg 覆盖
  ];

  if ffmpeg_only_exts.contains(&ext.as_str()) {
    return match decode_with_ffmpeg(path) {
      Ok(mut result) => {
        if result.decoder_backend.is_none() {
          result.decoder_backend = Some("ffmpeg".to_string());
        }
        result
      }
      Err(ffmpeg_err) => DecodeAudioResult {
        pcm_data: Buffer::from(vec![]),
        sample_rate: 0,
        channels: 0,
        total_frames: 0.0,
        decoder_backend: Some("ffmpeg".to_string()),
        error: Some(format!("FFmpeg 解码失败: {}", ffmpeg_err)),
      },
    };
  }

  // 其他情况优先走 Symphonia，失败再兜底 FFmpeg
  match decode_with_symphonia(path) {
    Ok(mut result) => {
      result.decoder_backend = Some("symphonia".to_string());
      result
    }
    Err(symphonia_err) => match decode_with_ffmpeg(path) {
      Ok(mut result) => {
        if result.decoder_backend.is_none() {
          result.decoder_backend = Some("ffmpeg-fallback".to_string());
        }
        result
      }
      Err(ffmpeg_err) => DecodeAudioResult {
        pcm_data: Buffer::from(vec![]),
        sample_rate: 0,
        channels: 0,
        total_frames: 0.0,
        decoder_backend: None,
        error: Some(format!(
          "Symphonia 解码失败: {}; FFmpeg 解码失败: {}",
          symphonia_err, ffmpeg_err
        )),
      },
    },
  }
}

#[napi]
pub fn decode_audio_file_native_pcm(
  file_path: String,
  start_sec: Option<f64>,
  max_duration_sec: Option<f64>,
  sample_rate: u32,
  channels: u32,
) -> DecodeAudioResult {
  let path = Path::new(&file_path);
  if sample_rate == 0 {
    return DecodeAudioResult {
      pcm_data: Buffer::from(vec![]),
      sample_rate: 0,
      channels: 0,
      total_frames: 0.0,
      decoder_backend: Some("ffmpeg-native".to_string()),
      error: Some("native PCM 解码采样率无效".to_string()),
    };
  }
  if channels == 0 || channels > u8::MAX as u32 {
    return DecodeAudioResult {
      pcm_data: Buffer::from(vec![]),
      sample_rate: 0,
      channels: 0,
      total_frames: 0.0,
      decoder_backend: Some("ffmpeg-native".to_string()),
      error: Some("native PCM 解码声道数无效".to_string()),
    };
  }

  match ffmpeg_decode_native_f32(
    path,
    start_sec,
    max_duration_sec,
    sample_rate,
    channels as u16,
  ) {
    Ok((pcm_f32, decoded_sample_rate, decoded_channels, _native_ms, _convert_ms)) => {
      let total_frames = if decoded_channels > 0 {
        pcm_f32.len() as f64 / decoded_channels as f64
      } else {
        0.0
      };
      DecodeAudioResult {
        pcm_data: Buffer::from(cast_slice(&pcm_f32).to_vec()),
        sample_rate: decoded_sample_rate,
        channels: decoded_channels.min(u8::MAX as u16) as u8,
        total_frames,
        decoder_backend: Some("ffmpeg-native".to_string()),
        error: None,
      }
    }
    Err(error) => DecodeAudioResult {
      pcm_data: Buffer::from(vec![]),
      sample_rate: 0,
      channels: 0,
      total_frames: 0.0,
      decoder_backend: Some("ffmpeg-native".to_string()),
      error: Some(error),
    },
  }
}

/// Chromaprint 指纹结果
#[napi(object)]
pub struct ChromaprintFingerprintResult {
  /// base64 编码的 Chromaprint 指纹
  pub fingerprint: String,
  /// 音频时长（秒）
  pub duration: f64,
  /// 错误描述（失败时）
  pub error: Option<String>,
}

/// 生成 Chromaprint 音频指纹（原生调用，无子进程开销）
///
/// # 参数
/// * `file_path` - 音频文件路径
/// * `max_length_seconds` - 最大分析时长（秒），默认 120
#[napi]
pub fn generate_chromaprint_fingerprint(
  file_path: String,
  max_length_seconds: Option<u32>,
) -> ChromaprintFingerprintResult {
  let path = Path::new(&file_path);
  if !path.exists() {
    return ChromaprintFingerprintResult {
      fingerprint: String::new(),
      duration: 0.0,
      error: Some("文件不存在".to_string()),
    };
  }

  let max_sec = max_length_seconds.unwrap_or(120);

  // 优先尝试 FFmpeg libavcodec 直接解码 + Chromaprint 一体化（最快路径）
  match chromaprint_native::generate_fingerprint_from_file(&file_path, max_sec) {
    Ok(result) => ChromaprintFingerprintResult {
      fingerprint: result.fingerprint,
      duration: result.duration,
      error: None,
    },
    Err(ffmpeg_err) => {
      // 回退到 Symphonia 解码 + Chromaprint
      match decode_with_symphonia(path) {
        Ok(decode_result) => {
          let pcm_f32: &[f32] = cast_slice(&decode_result.pcm_data);
          let max_samples = if max_sec > 0 {
            (((max_sec as f64) * decode_result.sample_rate as f64 * decode_result.channels as f64)
              as usize)
              .min(pcm_f32.len())
          } else {
            pcm_f32.len()
          };
          match chromaprint_native::generate_fingerprint_from_f32(
            &pcm_f32[..max_samples],
            decode_result.sample_rate,
            decode_result.channels as u16,
            0,
          ) {
            Ok(result) => ChromaprintFingerprintResult {
              fingerprint: result.fingerprint,
              duration: result.duration,
              error: None,
            },
            Err(e) => ChromaprintFingerprintResult {
              fingerprint: String::new(),
              duration: 0.0,
              error: Some(e),
            },
          }
        }
        Err(symphonia_err) => ChromaprintFingerprintResult {
          fingerprint: String::new(),
          duration: 0.0,
          error: Some(format!(
            "FFmpeg: {} | Symphonia: {}",
            ffmpeg_err, symphonia_err
          )),
        },
      }
    }
  }
}

/// 基于 PCM 计算 Mixxx RGB 波形
#[napi]
pub fn compute_mixxx_waveform(
  pcm_data: Buffer,
  sample_rate: u32,
  channels: u8,
) -> napi::Result<MixxxWaveformData> {
  mixxx_waveform::compute_mixxx_waveform(pcm_data, sample_rate, channels)
}

/// 基于 PCM 计算 Mixxx RGB 波形（指定可视采样率）
#[napi]
pub fn compute_mixxx_waveform_with_rate(
  pcm_data: Buffer,
  sample_rate: u32,
  channels: u8,
  target_visual_rate: f64,
) -> napi::Result<MixxxWaveformData> {
  mixxx_waveform::compute_mixxx_waveform_with_rate(
    pcm_data,
    sample_rate,
    channels,
    target_visual_rate,
  )
}

/// 基于 PCM 计算调性（Mixxx Queen Mary）
#[napi]
pub fn analyze_key_from_pcm(
  pcm_data: Buffer,
  sample_rate: u32,
  channels: u8,
  fast_analysis: bool,
) -> KeyAnalysisResult {
  let pcm_bytes = pcm_data.as_ref();
  let pcm_f32 = match try_cast_slice::<u8, f32>(pcm_bytes) {
    Ok(slice) => Cow::Borrowed(slice),
    Err(_) => {
      if pcm_bytes.len() % 4 != 0 {
        return KeyAnalysisResult {
          key_text: "o".to_string(),
          error: Some("PCM buffer length is not aligned".to_string()),
        };
      }
      let mut out = Vec::with_capacity(pcm_bytes.len() / 4);
      for chunk in pcm_bytes.chunks_exact(4) {
        out.push(f32::from_le_bytes(chunk.try_into().unwrap()));
      }
      Cow::Owned(out)
    }
  };

  match qm_key::analyze_key_id_from_pcm(pcm_f32.as_ref(), sample_rate, channels, fast_analysis) {
    Ok(key_id) => KeyAnalysisResult {
      key_text: key_id_to_id3_text(key_id),
      error: None,
    },
    Err(error) => KeyAnalysisResult {
      key_text: "o".to_string(),
      error: Some(error),
    },
  }
}

fn key_id_to_id3_text(key_id: i32) -> String {
  const ID3_KEYS: [&str; 25] = [
    "o", // INVALID
    "C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B", "Cm", "C#m", "Dm", "Ebm",
    "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm",
  ];
  let index = if key_id >= 0 && key_id < ID3_KEYS.len() as i32 {
    key_id as usize
  } else {
    0
  };
  ID3_KEYS[index].to_string()
}

/// 解码音频为 PCM Float32Array
fn decode_audio_to_pcm(mut format: Box<dyn FormatReader>) -> napi::Result<DecodeAudioResult> {
  let (track_id, codec_params) = {
    let track = find_decode_track(&mut format)?;
    (track.id, track.codec_params.clone())
  };

  let channels = codec_params
    .channels
    .ok_or_else(|| napi::Error::from_reason("缺少声道信息"))?
    .count() as u8;
  let sample_rate = codec_params
    .sample_rate
    .ok_or_else(|| napi::Error::from_reason("缺少采样率信息"))?;

  let mut decoder = build_decoder(&codec_params)?;

  // 收集所有 PCM 样本（交错格式）
  let mut all_samples: Vec<f32> = Vec::new();
  let mut total_frames: u64 = 0;

  while let Some(packet) = next_packet(&mut format, track_id) {
    match decoder.decode(&packet) {
      Ok(audio_buf) => {
        let frame_count = audio_buf.frames();
        total_frames += frame_count as u64;

        // 将音频缓冲区转换为 f32 并交错
        match audio_buf {
          AudioBufferRef::F32(buf) => {
            // 已经是 f32，手动交错
            for frame_idx in 0..frame_count {
              for ch in 0..channels as usize {
                all_samples.push(buf.chan(ch)[frame_idx]);
              }
            }
          }
          AudioBufferRef::S16(buf) => {
            // i16 转 f32 并交错
            for frame_idx in 0..frame_count {
              for ch in 0..channels as usize {
                all_samples.push(buf.chan(ch)[frame_idx] as f32 / 32768.0);
              }
            }
          }
          AudioBufferRef::S24(buf) => {
            // i24 转 f32 并交错
            for frame_idx in 0..frame_count {
              for ch in 0..channels as usize {
                let sample = buf.chan(ch)[frame_idx].inner();
                all_samples.push(sample as f32 / 8388608.0);
              }
            }
          }
          AudioBufferRef::S32(buf) => {
            // i32 转 f32 并交错
            for frame_idx in 0..frame_count {
              for ch in 0..channels as usize {
                all_samples.push(buf.chan(ch)[frame_idx] as f32 / 2147483648.0);
              }
            }
          }
          AudioBufferRef::U8(buf) => {
            // u8 转 f32 并交错
            for frame_idx in 0..frame_count {
              for ch in 0..channels as usize {
                all_samples.push((buf.chan(ch)[frame_idx] as f32 - 128.0) / 128.0);
              }
            }
          }
          _ => {
            return Err(napi::Error::from_reason("不支持的音频格式"));
          }
        }
      }
      Err(SymphoniaError::IoError(_)) | Err(SymphoniaError::DecodeError(_)) => continue,
      Err(e) => {
        return Err(napi::Error::from_reason(format!("解码错误: {}", e)));
      }
    }
  }

  Ok(DecodeAudioResult {
    pcm_data: Buffer::from(cast_slice(&all_samples).to_vec()),
    sample_rate,
    channels,
    total_frames: total_frames as f64,
    decoder_backend: None,
    error: None,
  })
}

fn decode_with_symphonia(path: &Path) -> StdResult<DecodeAudioResult, String> {
  let file = File::open(path).map_err(|_| "打开文件失败".to_string())?;
  let media_stream = MediaSourceStream::new(Box::new(file), Default::default());
  let mut hint = Hint::new();
  if let Some(ext) = path.extension().and_then(|os| os.to_str()) {
    hint.with_extension(ext);
  }

  let format_opts = FormatOptions::default();
  let metadata_opts = MetadataOptions {
    limit_metadata_bytes: Limit::None,
    limit_visual_bytes: Limit::None,
    ..Default::default()
  };

  let probed = get_probe()
    .format(&hint, media_stream, &format_opts, &metadata_opts)
    .map_err(|e| format!("探测音频格式失败: {}", e))?;

  match catch_unwind(AssertUnwindSafe(|| decode_audio_to_pcm(probed.format))) {
    Ok(Ok(result)) => Ok(result),
    Ok(Err(err)) => Err(err.to_string()),
    Err(_) => Err("内部音频解码错误（panic）".to_string()),
  }
}

fn decode_with_ffmpeg(path: &Path) -> StdResult<DecodeAudioResult, String> {
  let (ffmpeg_pcm, _native_ms) = ffmpeg_decode_native_i16(path, None, None, 0, 0)?;
  if ffmpeg_pcm.channels == 0 {
    return Err("FFmpeg 返回的声道数无效".to_string());
  }

  let channels_u8 = if ffmpeg_pcm.channels > u8::MAX as u16 {
    return Err("声道数超过支持范围".to_string());
  } else {
    ffmpeg_pcm.channels as u8
  };

  let pcm_f32: Vec<f32> = ffmpeg_pcm
    .samples_i16
    .iter()
    .map(|sample| (*sample as f32) / 32768.0)
    .collect();

  Ok(DecodeAudioResult {
    pcm_data: Buffer::from(cast_slice(&pcm_f32).to_vec()),
    sample_rate: ffmpeg_pcm.sample_rate,
    channels: channels_u8,
    total_frames: ffmpeg_pcm.total_frames as f64,
    decoder_backend: Some("ffmpeg-native".to_string()),
    error: None,
  })
}

pub(crate) use ffmpeg_decode::{
  ffmpeg_decode_native_f32, ffmpeg_decode_native_i16, ffmpeg_decode_transport_native,
  ffmpeg_decode_transport_native_cancellable, FfmpegTransportDecodeMetrics,
};

// ===== 任务实现 =====

impl Task for AudioProcessTask {
  type Output = Vec<AudioFileResult>;
  type JsValue = Vec<AudioFileResult>;

  fn compute(&mut self) -> napi::Result<Self::Output> {
    let total = self.file_paths.len() as i32;
    let results = Arc::new(Mutex::new(Vec::with_capacity(self.file_paths.len())));
    let processed = Arc::new(std::sync::atomic::AtomicI32::new(0));

    // 计算最优分块大小
    let chunk_size = {
      let cpu_count = num_cpus::get();
      let ideal_chunks = (self.file_paths.len() / 10).max(1);
      (self.file_paths.len() / ideal_chunks.min(cpu_count * 2)).max(1)
    };

    if let Some(ref callback) = self.callback {
      let callback = callback.clone();
      // 使用自适应的工作窃取调度
      rayon::scope(|s| {
        for chunk in self.file_paths.chunks(chunk_size) {
          let results = Arc::clone(&results);
          let callback = callback.clone();
          let processed = Arc::clone(&processed);
          s.spawn(move |_| {
            let mut local_results = Vec::with_capacity(chunk.len());
            for path in chunk {
              let result = calculate_audio_hash_for_file(path);
              let current = processed.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;

              // 回调进度信息
              let progress = ProcessProgress {
                processed: current,
                total,
              };
              callback.call(Ok(progress), ThreadsafeFunctionCallMode::Blocking);

              local_results.push(result);
            }
            results.lock().extend(local_results);
          });
        }
      });
    } else {
      // 无回调时直接并行处理
      self.file_paths.par_iter().for_each(|path| {
        let result = calculate_audio_hash_for_file(path);
        results.lock().push(result);
      });
    }

    Ok(Arc::try_unwrap(results).unwrap().into_inner())
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
    Ok(output)
  }
}

// ===== 内部辅助函数 =====

/// 处理单个音频文件并计算 SHA256 哈希
fn calculate_audio_hash_for_file(path: &str) -> AudioFileResult {
  let path = Path::new(path);
  match calculate_hash_with_symphonia(path) {
    Ok(hash) => {
      let mut result = AudioFileResult::with_path(path);
      result.sha256_hash = hash;
      result
    }
    Err(symphonia_err) => match calculate_hash_with_ffmpeg(path) {
      Ok(hash) => {
        let mut result = AudioFileResult::with_path(path);
        result.sha256_hash = hash;
        result
      }
      Err(ffmpeg_err) => AudioFileResult::error(
        path,
        &format!(
          "Symphonia 解码失败: {}; FFmpeg 解码失败: {}",
          symphonia_err, ffmpeg_err
        ),
      ),
    },
  }
}

fn calculate_hash_with_symphonia(path: &Path) -> StdResult<String, String> {
  let file = File::open(path).map_err(|_| "打开文件失败".to_string())?;
  let media_stream = MediaSourceStream::new(Box::new(file), Default::default());
  let mut hint = Hint::new();
  if let Some(ext) = path.extension().and_then(|os| os.to_str()) {
    hint.with_extension(ext);
  }

  let format_opts = FormatOptions::default();
  let metadata_opts = MetadataOptions {
    limit_metadata_bytes: Limit::None,
    limit_visual_bytes: Limit::None,
    ..Default::default()
  };

  let probed = get_probe()
    .format(&hint, media_stream, &format_opts, &metadata_opts)
    .map_err(|e| format!("探测音频格式失败: {}", e))?;

  let mut temp_result = AudioFileResult::with_path(path);
  match catch_unwind(AssertUnwindSafe(|| {
    extract_audio_features(probed.format, &mut temp_result)
  })) {
    Ok(Ok(())) => {
      if temp_result.sha256_hash.is_empty() {
        Err("Symphonia 解码未生成哈希".to_string())
      } else {
        Ok(temp_result.sha256_hash)
      }
    }
    Ok(Err(err)) => Err(err.to_string()),
    Err(_) => Err("内部音频解码错误（panic）".to_string()),
  }
}

fn calculate_hash_with_ffmpeg(path: &Path) -> StdResult<String, String> {
  let (ffmpeg_pcm, _native_ms) = ffmpeg_decode_native_i16(path, None, None, 0, 0)?;
  let mut ctx = Context::new(&SHA256);
  ctx.update(cast_slice(&ffmpeg_pcm.samples_i16));
  Ok(hex::encode(ctx.finish()))
}

/// 单文件整文件 SHA256 计算
fn calculate_file_hash_for_file(path: &str) -> AudioFileResult {
  let p = Path::new(path);
  let mut result = AudioFileResult::with_path(p);
  let mut file = match std::fs::File::open(p) {
    Ok(f) => f,
    Err(_) => return AudioFileResult::error(p, "打开文件失败"),
  };
  let mut ctx = Context::new(&SHA256);
  let mut buf = vec![0u8; 1024 * 1024 * 2]; // 2MB buffer
  loop {
    match file.read(&mut buf) {
      Ok(0) => break,
      Ok(n) => ctx.update(&buf[..n]),
      Err(_) => return AudioFileResult::error(p, "读取文件失败"),
    }
  }
  result.sha256_hash = hex::encode(ctx.finish());
  result
}

fn extract_audio_features(
  mut format: Box<dyn FormatReader>,
  result: &mut AudioFileResult,
) -> napi::Result<()> {
  let (track_id, codec_params) = {
    let track = find_decode_track(&mut format)?;
    (track.id, track.codec_params.clone())
  };

  // 已精简：移除非必要的编码参数输出

  codec_params
    .channels
    .ok_or_else(|| napi::Error::from_reason("缺少声道信息"))?;
  codec_params
    .sample_rate
    .ok_or_else(|| napi::Error::from_reason("缺少采样率信息"))?;

  // 已精简：不再导出 duration/quality_label

  let mut decoder = build_decoder(&codec_params)?;
  // 延迟创建 SampleBuffer，确保与首个解码帧的 spec 严格一致
  let mut sample_buffer: Option<SampleBuffer<i16>> = None;
  let mut current_spec: Option<SignalSpec> = None;

  // 基于解码后的 PCM 样本计算内容哈希
  let mut pcm_hasher = Context::new(&SHA256);

  while let Some(packet) = next_packet(&mut format, track_id) {
    match decoder.decode(&packet) {
      Ok(audio_buf) => {
        let frame_count = audio_buf.frames();

        // 若尚未创建或 spec 变化/容量不足，则重建缓冲
        let want_spec = *audio_buf.spec();
        let cap_insufficient = sample_buffer
          .as_ref()
          .map(|b| b.capacity() < frame_count)
          .unwrap_or(true);
        let spec_changed = current_spec
          .map(|s| s.channels != want_spec.channels || s.rate != want_spec.rate)
          .unwrap_or(true);
        let need_recreate = cap_insufficient || spec_changed;

        if need_recreate {
          // 使用下一幂次容量，避免频繁扩容
          let required = frame_count.next_power_of_two().max(frame_count);
          sample_buffer = Some(SampleBuffer::new(required as u64, want_spec));
          current_spec = Some(want_spec);
        }

        let sbuf = sample_buffer.as_mut().unwrap();
        sbuf.copy_interleaved_ref(audio_buf);

        // 将解码后的 i16 PCM 样本（交错）追加到哈希器
        let samples_i16: &[i16] = sbuf.samples();
        pcm_hasher.update(cast_slice(samples_i16));
      }
      Err(SymphoniaError::IoError(_)) | Err(SymphoniaError::DecodeError(_)) => continue,
      Err(_) => break,
    }
  }

  // 已精简：不再导出时长/位深

  // 基于 PCM 内容的哈希，实现“跳过元数据”的唯一值
  result.sha256_hash = hex::encode(pcm_hasher.finish());

  Ok(())
}

fn find_decode_track(format: &mut Box<dyn FormatReader>) -> napi::Result<&Track> {
  format
    .tracks()
    .iter()
    .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
    .ok_or_else(|| napi::Error::from_reason("未找到可解码音轨"))
}

fn build_decoder(
  codec_params: &symphonia::core::codecs::CodecParameters,
) -> napi::Result<Box<dyn symphonia::core::codecs::Decoder>> {
  let mut opts = DecoderOptions::default();
  // 性能优化：关闭额外校验（若编解码器支持）
  opts.verify = false;
  symphonia::default::get_codecs()
    .make(codec_params, &opts)
    .map_err(|_| napi::Error::from_reason("创建解码器失败"))
}

fn next_packet(
  format: &mut Box<dyn FormatReader>,
  track_id: u32,
) -> Option<symphonia::core::formats::Packet> {
  loop {
    let packet = match format.next_packet() {
      Ok(packet) => packet,
      Err(SymphoniaError::ResetRequired) => return None,
      Err(_) => return None,
    };

    if packet.track_id() != track_id {
      continue;
    }

    return Some(packet);
  }
}
