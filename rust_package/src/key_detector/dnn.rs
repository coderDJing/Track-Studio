//! 神经网络调性检测移植。
//!
//! 改编自 openwave-studio/opendj（GPL-2.0-or-later）的 `crates/engine/src/keynet.rs`：
//! 按 librosa 方式做一个 105 bin、每半音两个 bin、从 65 Hz 起的常数 Q 频谱图，
//! 每秒 5 帧、取 log(1+幅度)，再跑 Korzeniowski & Widmer 的 KeyNet 卷积网络。
//! 权重来自 openkeyscan-analyzer（MIT），见 `native/key_detector/dnn_weights.bin`。

use std::sync::{Arc, OnceLock};

use rustfft::num_complex::Complex32;
use rustfft::{Fft, FftPlanner};

use super::Key;

/// 常数 Q 频谱图每帧的 bin 数。
const BINS: usize = 105;
const BINS_PER_OCTAVE: f64 = 24.0;
const FMIN: f64 = 65.0;
/// 帧间隔：44.1 kHz 下 librosa 的 hop 8820 个采样。
const FRAME_SECONDS: f64 = 0.2;
/// 网络会三次折半频谱图长度。
const MIN_FRAMES: usize = 8;

/// 权重文件，格式见 openDJ `scripts/export-keynet.py`。
static WEIGHTS: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/native/key_detector/dnn_weights.bin"
));

/// 一个常数 Q 滤波器在频域上的表示：从 `first` 起的 FFT bin，已按 librosa 缩放。
struct Filter {
  first: usize,
  taps: Vec<Complex32>,
}

/// 随音频流式构建常数 Q 频谱图。
pub struct Spectrogram {
  hop: usize,
  n_fft: usize,
  fft: Arc<dyn Fft<f32>>,
  filters: Vec<Filter>,
  /// 从绝对下标 `start` 起的样本；开头是 librosa 补齐的半帧静音。
  buf: Vec<f32>,
  start: isize,
  pushed: usize,
  frames: Vec<[f32; BINS]>,
  scratch: Vec<Complex32>,
}

impl Spectrogram {
  pub fn new(sample_rate: f64) -> Self {
    let sr = sample_rate.max(1.0);
    // librosa 在 24 bins/octave 下的相对带宽，以及每个 bin 对应的滤波器长度。
    let r = 2f64.powf(2.0 / BINS_PER_OCTAVE);
    let q = (r + 1.0) / (r - 1.0);
    let freq = |k: usize| FMIN * 2f64.powf(k as f64 / BINS_PER_OCTAVE);
    let length = |k: usize| q * sr / freq(k);
    let n_fft = (length(0).ceil() as usize).next_power_of_two();
    let fft = FftPlanner::new().plan_fft_forward(n_fft);
    let filters = (0..BINS)
      .map(|k| {
        let (f, len) = (freq(k), length(k));
        // 从 floor(-len/2) 到 floor(len/2) 的整采样 tap，Hann 窗、求和归一，居中于 n_fft。
        let lo = (-len / 2.0).floor();
        let n = ((len / 2.0).floor() - lo) as usize;
        let window = |j: usize| 0.5 - 0.5 * (std::f64::consts::TAU * j as f64 / n as f64).cos();
        let sum: f64 = (0..n).map(window).sum();
        // librosa 在 FFT 前乘 len/n_fft、结果再除以 sqrt(len)；网络在 44.1 kHz 下训练。
        let gain = len / n_fft as f64 / sum / len.sqrt() * (44_100.0 / sr).sqrt();
        let offset = (n_fft - n) / 2;
        let mut taps = vec![Complex32::new(0.0, 0.0); n_fft];
        for (j, tap) in taps[offset..offset + n].iter_mut().enumerate() {
          let phase = std::f64::consts::TAU * f * (lo + j as f64) / sr;
          let w = window(j) * gain;
          *tap = Complex32::new((w * phase.cos()) as f32, (w * phase.sin()) as f32);
        }
        fft.process(&mut taps);
        taps.truncate(n_fft / 2 + 1);
        // 只有滤波器频率附近的 bin 有意义。
        let top = taps.iter().map(|t| t.norm()).fold(0.0, f32::max);
        let keep = |t: &Complex32| t.norm() > top * 1e-4;
        let first = taps.iter().position(keep).unwrap_or(0);
        let last = taps.iter().rposition(keep).unwrap_or(0);
        Filter {
          first,
          taps: taps[first..=last].to_vec(),
        }
      })
      .collect();
    Spectrogram {
      hop: (sr * FRAME_SECONDS).round() as usize,
      n_fft,
      fft,
      filters,
      buf: vec![0.0; n_fft / 2],
      start: -((n_fft / 2) as isize),
      pushed: 0,
      frames: Vec::new(),
      scratch: Vec::new(),
    }
  }

  /// 喂入下一个单声道样本。
  #[inline]
  pub fn push(&mut self, x: f32) {
    self.buf.push(x);
    self.pushed += 1;
    if self.pushed >= self.frames.len() * self.hop + self.n_fft / 2 {
      self.frame();
    }
  }

  /// 第 `frames.len()` 帧，居中于它的 hop；缓冲区里已有整帧。
  fn frame(&mut self) {
    let from = (self.frames.len() * self.hop) as isize - (self.n_fft / 2) as isize;
    let at = (from - self.start) as usize;
    self.scratch.clear();
    self.scratch.extend(
      self.buf[at..at + self.n_fft]
        .iter()
        .map(|&x| Complex32::new(x, 0.0)),
    );
    self.fft.process(&mut self.scratch);
    let mut out = [0.0f32; BINS];
    for (o, f) in out.iter_mut().zip(&self.filters) {
      let spectrum = &self.scratch[f.first..f.first + f.taps.len()];
      let sum: Complex32 = f.taps.iter().zip(spectrum).map(|(a, b)| a * b).sum();
      *o = sum.norm().ln_1p();
    }
    self.frames.push(out);
    // 只保留下一帧仍需的部分。
    let next = (self.frames.len() * self.hop) as isize - (self.n_fft / 2) as isize;
    let drop = ((next - self.start).max(0) as usize).min(self.buf.len());
    self.buf.drain(..drop);
    self.start += drop as isize;
  }

  /// 已喂入音频的所有帧，末尾补半帧静音，去掉 openkeyscan 也去掉的最后两帧。
  fn finish(mut self) -> Vec<[f32; BINS]> {
    let total = self.pushed / self.hop + 1;
    while self.frames.len() < total {
      self.buf.push(0.0);
      if self.start + self.buf.len() as isize
        >= (self.frames.len() * self.hop + self.n_fft / 2) as isize
      {
        self.frame();
      }
    }
    self.frames.truncate(total.saturating_sub(2));
    self.frames
  }

  /// 判出已喂入音频的调性；过短音频返回 None。
  pub fn key(self) -> Option<Key> {
    self.scores().map(|s| class_key(best(&s)))
  }

  /// 网络对 24 个分类的得分；过短音频返回 None。
  pub fn scores(self) -> Option<[f32; 24]> {
    let frames = self.finish();
    (frames.len() >= MIN_FRAMES).then(|| network().scores(&frames))
  }
}

/// 一次已折叠 batch norm、后接 ELU 的卷积。
struct Conv {
  out: usize,
  inp: usize,
  k: usize,
  bias: Vec<f32>,
  /// `out` 行，每行 `inp * k * k`。
  weights: Vec<f32>,
}

struct Network {
  layers: Vec<Conv>,
}

fn network() -> &'static Network {
  static NET: OnceLock<Network> = OnceLock::new();
  NET.get_or_init(|| Network::read(WEIGHTS).expect("the bundled key network is valid"))
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
  fn take(&mut self, n: usize) -> Option<&'a [u8]> {
    let (head, rest) = self.0.split_at_checked(n)?;
    self.0 = rest;
    Some(head)
  }

  fn u32(&mut self) -> Option<usize> {
    Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?) as usize)
  }
}

/// `c` 个平面，每个 `h` 行（频率）乘 `w` 列（时间）。
struct Planes {
  c: usize,
  h: usize,
  w: usize,
  data: Vec<f32>,
}

impl Network {
  fn read(data: &[u8]) -> Option<Network> {
    let mut r = Reader(data.strip_prefix(b"OKSKEY01")?);
    let count = r.u32()?;
    let mut layers = Vec::with_capacity(count);
    for _ in 0..count {
      let (out, inp, kh, kw) = (r.u32()?, r.u32()?, r.u32()?, r.u32()?);
      if kh != kw || kh % 2 == 0 {
        return None;
      }
      let bias = r
        .take(out * 4)?
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect();
      let weights = r
        .take(out * inp * kh * kw * 2)?
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| f16_to_f32(u16::from_le_bytes(*b)))
        .collect();
      layers.push(Conv {
        out,
        inp,
        k: kh,
        bias,
        weights,
      });
    }
    r.0.is_empty().then_some(Network { layers })
  }

  /// 网络对一段频谱图的 24 个得分。
  fn scores(&self, frames: &[[f32; BINS]]) -> [f32; 24] {
    let (h, w) = (BINS, frames.len());
    let mut data = vec![0.0; h * w];
    for (t, f) in frames.iter().enumerate() {
      for (b, v) in f.iter().enumerate() {
        data[b * w + t] = *v;
      }
    }
    let mut x = Planes { c: 1, h, w, data };
    for (i, layer) in self.layers.iter().enumerate() {
      x = layer.apply(&x);
      // 第 2、4、6 个卷积后各做一次池化。
      if matches!(i, 1 | 3 | 5) {
        x = max_pool(&x);
      }
    }
    let n = (x.h * x.w).max(1) as f32;
    std::array::from_fn(|c| {
      x.data[c * x.h * x.w..(c + 1) * x.h * x.w]
        .iter()
        .sum::<f32>()
        / n
    })
  }
}

fn best(scores: &[f32; 24]) -> usize {
  (0..24).fold(0, |b, i| if scores[i] > scores[b] { i } else { b })
}

/// openkeyscan 的分类沿用 Camelot 轮盘：0-11 是 1A-12A，12-23 是 1B-12B。
pub fn class_key(class: usize) -> Key {
  let number = class % 12 + 1;
  Key::from_camelot(number, class < 12)
}

impl Conv {
  /// 零填充（"same"）卷积、加 bias 后过 ELU，逐行做矩阵乘。
  fn apply(&self, x: &Planes) -> Planes {
    assert_eq!(x.c, self.inp);
    let (h, w, k, pad) = (x.h, x.w, self.k, self.k / 2);
    let depth = self.inp * k * k;
    let mut out = vec![0.0f32; self.out * h * w];
    let mut patches = vec![0.0f32; depth * w];
    for row in 0..h {
      for ci in 0..self.inp {
        let plane = &x.data[ci * h * w..(ci + 1) * h * w];
        for dy in 0..k {
          let src = row as isize + dy as isize - pad as isize;
          for dx in 0..k {
            let r = (ci * k + dy) * k + dx;
            let dst = &mut patches[r * w..(r + 1) * w];
            if !(0..h as isize).contains(&src) {
              dst.fill(0.0);
              continue;
            }
            let line = &plane[src as usize * w..(src as usize + 1) * w];
            let shift = dx as isize - pad as isize;
            for (t, d) in dst.iter_mut().enumerate() {
              let s = t as isize + shift;
              *d = if (0..w as isize).contains(&s) {
                line[s as usize]
              } else {
                0.0
              };
            }
          }
        }
      }
      // SAFETY: 每次只写 `out` 的 `row` 这一行（跨通道步长 h*w），不会越界。
      unsafe {
        matrixmultiply::sgemm(
          self.out,
          depth,
          w,
          1.0,
          self.weights.as_ptr(),
          depth as isize,
          1,
          patches.as_ptr(),
          w as isize,
          1,
          0.0,
          out.as_mut_ptr().add(row * w),
          (h * w) as isize,
          1,
        );
      }
    }
    for (o, plane) in out.chunks_exact_mut(h * w).enumerate() {
      let b = self.bias[o];
      for v in plane {
        let y = *v + b;
        *v = if y > 0.0 { y } else { y.exp_m1() };
      }
    }
    Planes {
      c: self.out,
      h,
      w,
      data: out,
    }
  }
}

/// 2x2 最大池化，丢掉多出的最后一行或一列。
fn max_pool(x: &Planes) -> Planes {
  let (h, w) = (x.h / 2, x.w / 2);
  let mut data = Vec::with_capacity(x.c * h * w);
  for c in 0..x.c {
    let plane = &x.data[c * x.h * x.w..];
    for r in 0..h {
      for t in 0..w {
        let at = |rr: usize, tt: usize| plane[rr * x.w + tt];
        let (r2, t2) = (r * 2, t * 2);
        data.push(
          at(r2, t2)
            .max(at(r2, t2 + 1))
            .max(at(r2 + 1, t2))
            .max(at(r2 + 1, t2 + 1)),
        );
      }
    }
  }
  Planes { c: x.c, h, w, data }
}

fn f16_to_f32(h: u16) -> f32 {
  let sign = ((h >> 15) as u32) << 31;
  let exp = ((h >> 10) & 0x1f) as u32;
  let frac = (h & 0x3ff) as u32;
  let bits = match exp {
    0 if frac == 0 => sign,
    0 => {
      let shift = frac.leading_zeros() - 21;
      sign | ((113 - shift) << 23) | ((frac << (shift + 1)) & 0x3ff) << 13
    }
    0x1f => sign | 0x7f80_0000 | (frac << 13),
    _ => sign | ((exp + 112) << 23) | (frac << 13),
  };
  f32::from_bits(bits)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn half_floats() {
    assert_eq!(f16_to_f32(0x3c00), 1.0);
    assert_eq!(f16_to_f32(0xc000), -2.0);
    assert_eq!(f16_to_f32(0x0000), 0.0);
  }

  #[test]
  fn classes_follow_the_camelot_wheel() {
    assert_eq!(class_key(0).camelot(), "1A");
    assert_eq!(class_key(7).camelot(), "8A");
    assert_eq!(class_key(19).camelot(), "8B");
    assert_eq!(class_key(23).camelot(), "12B");
  }

  #[test]
  fn the_bundled_network_reads() {
    let net = network();
    assert_eq!(net.layers.len(), 9);
    assert_eq!(net.layers[8].out, 24);
  }
}
