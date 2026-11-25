//! 调性检测算法移植（模板匹配 + 神经网络）。
//!
//! 改编自 openwave-studio/opendj（GPL-2.0-or-later）的 `crates/engine/src/key.rs`：
//! 用 qm-dsp 的 Noland–Sandler 大小调谱，先把低+中频段单独抽出并换算成单声道，
//! 再整曲累计 chroma，最后对 24 个调各做一次 Pearson 相关取最大，
//! 不再逐帧判调、中值滤波或时长投票。

use std::sync::Arc;

use rustfft::num_complex::Complex32;
use rustfft::{Fft, FftPlanner};

use crate::analysis_utils::{calc_frames_to_process, to_stereo};

pub mod dnn;

const BINS_PER_OCTAVE: usize = 36;
/// 每个频谱的采样数：11 kHz 下约 0.74 秒。
const FRAME: usize = 8192;
/// chroma 覆盖的音高范围：C3 到 C7。
const LOWEST_NOTE: f32 = 48.0;
const HIGHEST_NOTE: f32 = 96.0;

/// qm-dsp 的大调谱；每个半音三个 bin，bin 1 是该半音中心，bin 1 对应 C。
const MAJOR: [f64; BINS_PER_OCTAVE] = [
  0.0384, 0.0629, 0.0258, 0.0121, 0.0146, 0.0106, 0.0364, 0.0610, 0.0267, 0.0126, 0.0121, 0.0086,
  0.0364, 0.0623, 0.0279, 0.0275, 0.0414, 0.0186, 0.0173, 0.0248, 0.0145, 0.0364, 0.0631, 0.0262,
  0.0129, 0.0150, 0.0098, 0.0312, 0.0521, 0.0235, 0.0129, 0.0142, 0.0095, 0.0289, 0.0478, 0.0239,
];

/// qm-dsp 的小调谱。
const MINOR: [f64; BINS_PER_OCTAVE] = [
  0.0375, 0.0682, 0.0299, 0.0119, 0.0138, 0.0093, 0.0296, 0.0543, 0.0257, 0.0292, 0.0519, 0.0246,
  0.0159, 0.0234, 0.0135, 0.0291, 0.0544, 0.0248, 0.0137, 0.0176, 0.0104, 0.0352, 0.0670, 0.0302,
  0.0222, 0.0349, 0.0164, 0.0174, 0.0297, 0.0166, 0.0222, 0.0401, 0.0202, 0.0175, 0.0270, 0.0146,
];

/// 一个调：`tonic` 为 0..12（从 C 起算），`minor` 表示小调。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Key {
  pub tonic: u8,
  pub minor: bool,
}

impl Key {
  /// 转成 FRKB 现有 ID3 调性编号：1..12 为大调 C..B，13..24 为小调 Cm..Bm。
  pub fn to_key_id(self) -> i32 {
    if self.minor {
      13 + self.tonic as i32
    } else {
      1 + self.tonic as i32
    }
  }

  /// Camelot 记法，例如 8B 是 C 大调、8A 是 A 小调。
  #[allow(dead_code)]
  pub fn camelot(self) -> String {
    let major_tonic = if self.minor {
      self.tonic + 3
    } else {
      self.tonic
    } as usize;
    let number = (major_tonic * 7 + 7) % 12 + 1;
    format!("{number}{}", if self.minor { 'A' } else { 'B' })
  }

  /// 由 Camelot 编号（1..12）与大小调还原调性，供神经网络分类使用。
  fn from_camelot(number: usize, minor: bool) -> Key {
    let major_tonic = (7 * (number as i32 - 8)).rem_euclid(12) as u8;
    let tonic = if minor {
      (major_tonic + 9) % 12
    } else {
      major_tonic
    };
    Key { tonic, minor }
  }
}

/// 二阶 biquad（RBJ cookbook），转置直接 II 型，立体声。
#[derive(Clone, Copy, Debug)]
struct Biquad {
  b0: f32,
  b1: f32,
  b2: f32,
  a1: f32,
  a2: f32,
  z1: [f32; 2],
  z2: [f32; 2],
}

impl Default for Biquad {
  fn default() -> Self {
    Self {
      b0: 1.0,
      b1: 0.0,
      b2: 0.0,
      a1: 0.0,
      a2: 0.0,
      z1: [0.0; 2],
      z2: [0.0; 2],
    }
  }
}

impl Biquad {
  fn lowpass(sample_rate: f64, freq: f64, q: f64) -> Self {
    let mut f = Self::default();
    f.set_lowpass(sample_rate, freq, q);
    f
  }

  fn highpass(sample_rate: f64, freq: f64, q: f64) -> Self {
    let mut f = Self::default();
    f.set_highpass(sample_rate, freq, q);
    f
  }

  fn set_lowpass(&mut self, sample_rate: f64, freq: f64, q: f64) {
    let (cos, alpha) = Self::prewarp(sample_rate, freq, q);
    self.set(
      (1.0 - cos) / 2.0,
      1.0 - cos,
      (1.0 - cos) / 2.0,
      1.0 + alpha,
      -2.0 * cos,
      1.0 - alpha,
    );
  }

  fn set_highpass(&mut self, sample_rate: f64, freq: f64, q: f64) {
    let (cos, alpha) = Self::prewarp(sample_rate, freq, q);
    self.set(
      (1.0 + cos) / 2.0,
      -(1.0 + cos),
      (1.0 + cos) / 2.0,
      1.0 + alpha,
      -2.0 * cos,
      1.0 - alpha,
    );
  }

  fn prewarp(sample_rate: f64, freq: f64, q: f64) -> (f64, f64) {
    let w = 2.0 * std::f64::consts::PI * freq.clamp(10.0, sample_rate * 0.45) / sample_rate;
    (w.cos(), w.sin() / (2.0 * q))
  }

  fn set(&mut self, b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) {
    self.b0 = (b0 / a0) as f32;
    self.b1 = (b1 / a0) as f32;
    self.b2 = (b2 / a0) as f32;
    self.a1 = (a1 / a0) as f32;
    self.a2 = (a2 / a0) as f32;
  }

  #[inline]
  fn process(&mut self, x: [f32; 2]) -> [f32; 2] {
    let mut y = [0.0; 2];
    for c in 0..2 {
      y[c] = self.b0 * x[c] + self.z1[c];
      self.z1[c] = self.b1 * x[c] - self.a1 * y[c] + self.z2[c];
      self.z2[c] = self.b2 * x[c] - self.a2 * y[c];
    }
    y
  }
}

/// 四阶 Linkwitz-Riley 滤波器：两级 Butterworth biquad 串联。
#[derive(Clone, Copy, Debug, Default)]
struct Lr4([Biquad; 2]);

impl Lr4 {
  fn lowpass(sample_rate: f64, freq: f64) -> Self {
    let f = Biquad::lowpass(sample_rate, freq, std::f64::consts::FRAC_1_SQRT_2);
    Self([f, f])
  }

  fn highpass(sample_rate: f64, freq: f64) -> Self {
    let f = Biquad::highpass(sample_rate, freq, std::f64::consts::FRAC_1_SQRT_2);
    Self([f, f])
  }

  #[inline]
  fn process(&mut self, x: [f32; 2]) -> [f32; 2] {
    let y = self.0[0].process(x);
    self.0[1].process(y)
  }
}

/// 三段隔离 EQ 的分频点，与 Mixxx 默认 isolator 一致。
const EQ_LOW_HZ: f64 = 246.0;
const EQ_HIGH_HZ: f64 = 2484.0;

/// 三段隔离 EQ：两个 Linkwitz-Riley 分频组成低/中/高。
#[derive(Clone, Copy, Debug)]
struct Isolator {
  low: Lr4,
  rest: Lr4,
  mid: Lr4,
  high: Lr4,
  low_ap: (Lr4, Lr4),
}

impl Isolator {
  fn new(sample_rate: f64) -> Self {
    Self {
      low: Lr4::lowpass(sample_rate, EQ_LOW_HZ),
      rest: Lr4::highpass(sample_rate, EQ_LOW_HZ),
      mid: Lr4::lowpass(sample_rate, EQ_HIGH_HZ),
      high: Lr4::highpass(sample_rate, EQ_HIGH_HZ),
      low_ap: (
        Lr4::lowpass(sample_rate, EQ_HIGH_HZ),
        Lr4::highpass(sample_rate, EQ_HIGH_HZ),
      ),
    }
  }

  /// 把一帧拆成 (低, 中, 高)。
  #[inline]
  fn split(&mut self, x: [f32; 2]) -> [[f32; 2]; 3] {
    let lo = self.low.process(x);
    let (a, b) = (self.low_ap.0.process(lo), self.low_ap.1.process(lo));
    let lo = [a[0] + b[0], a[1] + b[1]];
    let rest = self.rest.process(x);
    [lo, self.mid.process(rest), self.high.process(rest)]
  }
}

/// 每个频谱 bin 覆盖的 chroma bin 及权重。
type BinTargets = [(usize, f32); 2];
type BinMap = Vec<(usize, BinTargets)>;

/// 模板匹配检测器：把单声道样本流式喂入，整曲累计 chroma 后一次性判调。
pub struct KeyDetector {
  decimation: usize,
  acc: f32,
  acc_n: usize,
  buf: Vec<f32>,
  window: Vec<f32>,
  fft: Arc<dyn Fft<f32>>,
  bin_map: BinMap,
  chroma: [f64; BINS_PER_OCTAVE],
  frames: usize,
}

impl KeyDetector {
  pub fn new(sample_rate: f64) -> Self {
    let decimation = ((sample_rate / 11_025.0).round() as usize).max(1);
    let rate = sample_rate as f32 / decimation as f32;
    let window = (0..FRAME)
      .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / FRAME as f32).cos())
      .collect();
    let mut bin_map = Vec::new();
    for k in 1..FRAME / 2 {
      let f = k as f32 * rate / FRAME as f32;
      let note = 69.0 + 12.0 * (f / 440.0).log2();
      if !(LOWEST_NOTE - 0.5..HIGHEST_NOTE - 0.5).contains(&note) {
        continue;
      }
      // 落在「半音三分之一」坐标上，C 的中心在 bin 1，拆给最近两个 bin。
      let pos = (note - LOWEST_NOTE) * 3.0 + 1.0;
      let lo = pos.floor();
      let t = pos - lo;
      let b = |x: f32| (x as i64).rem_euclid(BINS_PER_OCTAVE as i64) as usize;
      bin_map.push((k, [(b(lo), 1.0 - t), (b(lo + 1.0), t)]));
    }
    KeyDetector {
      decimation,
      acc: 0.0,
      acc_n: 0,
      buf: Vec::with_capacity(FRAME),
      window,
      fft: FftPlanner::new().plan_fft_forward(FRAME),
      bin_map,
      chroma: [0.0; BINS_PER_OCTAVE],
      frames: 0,
    }
  }

  /// 喂入一个已限制在约 2.5 kHz 以下的单声道样本。
  #[inline]
  pub fn push(&mut self, x: f32) {
    self.acc += x;
    self.acc_n += 1;
    if self.acc_n < self.decimation {
      return;
    }
    self.buf.push(self.acc / self.decimation as f32);
    self.acc = 0.0;
    self.acc_n = 0;
    if self.buf.len() == FRAME {
      self.frame();
      self.buf.clear();
    }
  }

  fn frame(&mut self) {
    let mut spectrum: Vec<Complex32> = self
      .buf
      .iter()
      .zip(&self.window)
      .map(|(x, w)| Complex32::new(x * w, 0.0))
      .collect();
    self.fft.process(&mut spectrum);
    let mut chroma = [0.0f64; BINS_PER_OCTAVE];
    for (k, targets) in &self.bin_map {
      let m = spectrum[*k].norm() as f64;
      for (b, w) in targets {
        chroma[*b] += m * *w as f64;
      }
    }
    // 每一帧无论音量大小都同等计入，与 qm-dsp 一致。
    let max = chroma.iter().copied().fold(0.0, f64::max);
    if max > 1e-9 {
      for (sum, c) in self.chroma.iter_mut().zip(chroma) {
        *sum += c / max;
      }
      self.frames += 1;
    }
  }

  /// 判出已喂入音频的调性；静音或过短音频返回 None。
  pub fn key(&self) -> Option<Key> {
    if self.frames == 0 {
      return None;
    }
    let centre = |v: &[f64; BINS_PER_OCTAVE]| {
      let mean = v.iter().sum::<f64>() / BINS_PER_OCTAVE as f64;
      v.map(|x| x - mean)
    };
    let data = centre(&self.chroma);
    let (major, minor) = (centre(&MAJOR), centre(&MINOR));
    let mut best = (
      f64::MIN,
      Key {
        tonic: 0,
        minor: false,
      },
    );
    // 调性每移动一个半音对应三个 bin。
    for tonic in 0..12u8 {
      for (profile, is_minor) in [(&major, false), (&minor, true)] {
        let c = correlate(&data, profile, tonic as usize * 3);
        if c > best.0 {
          best = (c, Key {
            tonic,
            minor: is_minor,
          });
        }
      }
    }
    Some(best.1)
  }
}

/// `data` 与上移 `shift` 个 bin 的 `profile` 的 Pearson 相关。
fn correlate(data: &[f64; BINS_PER_OCTAVE], profile: &[f64; BINS_PER_OCTAVE], shift: usize) -> f64 {
  let (mut num, mut a, mut b) = (0.0, 0.0, 0.0);
  for (i, d) in data.iter().enumerate() {
    let p = profile[(i + BINS_PER_OCTAVE - shift) % BINS_PER_OCTAVE];
    num += d * p;
    a += d * d;
    b += p * p;
  }
  let den = (a * b).sqrt();
  if den > 0.0 {
    num / den
  } else {
    0.0
  }
}

/// 预处理：把交错 PCM 转成立体声，按 `fast_analysis` 决定是否只取前 60 秒。
fn prepare_stereo<'a>(
  pcm_data: &'a [f32],
  sample_rate: u32,
  channels: u8,
  fast_analysis: bool,
) -> Option<std::borrow::Cow<'a, [f32]>> {
  if sample_rate == 0 || channels == 0 {
    return None;
  }
  let channels_usize = channels as usize;
  let total_frames = pcm_data.len() / channels_usize;
  if total_frames == 0 {
    return None;
  }
  let frames_to_process = calc_frames_to_process(total_frames, sample_rate, fast_analysis);
  if frames_to_process == 0 {
    return None;
  }
  let needed = frames_to_process * channels_usize;
  Some(to_stereo(&pcm_data[..needed], channels_usize, frames_to_process))
}

/// 模板匹配检测器判调。
pub fn analyze_template(
  pcm_data: &[f32],
  sample_rate: u32,
  channels: u8,
  fast_analysis: bool,
) -> Option<Key> {
  let stereo = prepare_stereo(pcm_data, sample_rate, channels, fast_analysis)?;
  let mut eq = Isolator::new(sample_rate as f64);
  let mut detector = KeyDetector::new(sample_rate as f64);
  for frame in stereo.as_ref().chunks_exact(2) {
    let [lo, mid, _] = eq.split([frame[0], frame[1]]);
    detector.push((lo[0] + lo[1] + mid[0] + mid[1]) * 0.5);
  }
  detector.key()
}

/// 神经网络检测器判调。
pub fn analyze_dnn(
  pcm_data: &[f32],
  sample_rate: u32,
  channels: u8,
  fast_analysis: bool,
) -> Option<Key> {
  let stereo = prepare_stereo(pcm_data, sample_rate, channels, fast_analysis)?;
  let mut spectrogram = dnn::Spectrogram::new(sample_rate as f64);
  for frame in stereo.as_ref().chunks_exact(2) {
    spectrogram.push((frame[0] + frame[1]) * 0.5);
  }
  spectrogram.key()
}

#[cfg(test)]
mod tests {
  use super::*;

  /// 用管风琴式泛音合成和弦进行，每个和弦两秒。
  fn chords(rate: f64, progression: &[[f32; 3]]) -> Vec<f32> {
    let mut out = Vec::new();
    for chord in progression.iter().cycle().take(progression.len() * 4) {
      for i in 0..(2.0 * rate) as usize {
        let t = i as f32 / rate as f32;
        let mut v = 0.0;
        for &note in chord {
          for (n, gain) in [
            (note, 1.0),
            (note - 12.0, 0.6 * (note == chord[0]) as u8 as f32),
          ] {
            let f = 440.0 * 2f32.powf((n - 69.0) / 12.0);
            for h in 1..4 {
              v += gain / h as f32 * (std::f32::consts::TAU * f * h as f32 * t).sin();
            }
          }
        }
        out.push(v * 0.05);
      }
    }
    out
  }

  fn detect(rate: f64, progression: &[[f32; 3]]) -> String {
    let mut k = KeyDetector::new(rate);
    for x in chords(rate, progression) {
      k.push(x);
    }
    k.key().unwrap().camelot()
  }

  #[test]
  fn finds_major_and_minor_keys() {
    let c_major = [
      [60.0, 64.0, 67.0],
      [65.0, 69.0, 72.0],
      [67.0, 71.0, 74.0],
      [60.0, 64.0, 67.0],
    ];
    let a_minor = [
      [57.0, 60.0, 64.0],
      [62.0, 65.0, 69.0],
      [64.0, 68.0, 71.0],
      [57.0, 60.0, 64.0],
    ];
    assert_eq!(detect(44_100.0, &c_major), "8B");
    assert_eq!(detect(48_000.0, &a_minor), "8A");
  }

  #[test]
  fn camelot_round_trips() {
    for number in 1..=12usize {
      for minor in [false, true] {
        let key = Key::from_camelot(number, minor);
        assert_eq!(key.camelot(), format!("{number}{}", if minor { 'A' } else { 'B' }));
      }
    }
    assert_eq!(Key { tonic: 0, minor: false }.to_key_id(), 1);
    assert_eq!(Key { tonic: 9, minor: true }.to_key_id(), 22);
  }
}
