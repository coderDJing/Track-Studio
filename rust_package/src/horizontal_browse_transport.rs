use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use napi::bindgen_prelude::*;

#[path = "horizontal_browse_transport_audio.rs"]
mod horizontal_browse_transport_audio;
#[path = "horizontal_browse_transport_auto_gain.rs"]
mod horizontal_browse_transport_auto_gain;
#[path = "horizontal_browse_transport_decode.rs"]
mod horizontal_browse_transport_decode;
#[path = "horizontal_browse_transport_dynamic_grid.rs"]
mod horizontal_browse_transport_dynamic_grid;
#[path = "horizontal_browse_transport_engine_state.rs"]
mod horizontal_browse_transport_engine_state;
#[path = "horizontal_browse_transport_grid_sync.rs"]
mod horizontal_browse_transport_grid_sync;
#[path = "horizontal_browse_transport_limiter.rs"]
mod horizontal_browse_transport_limiter;
#[path = "horizontal_browse_transport_loop.rs"]
mod horizontal_browse_transport_loop;
#[path = "horizontal_browse_transport_master_tempo_offline.rs"]
mod horizontal_browse_transport_master_tempo_offline;
#[path = "horizontal_browse_transport_mix.rs"]
mod horizontal_browse_transport_mix;
#[path = "horizontal_browse_transport_napi.rs"]
mod horizontal_browse_transport_napi;
#[path = "horizontal_browse_transport_r3_stretch.rs"]
mod horizontal_browse_transport_r3_stretch;
#[path = "horizontal_browse_transport_recording.rs"]
mod horizontal_browse_transport_recording;
#[path = "horizontal_browse_transport_runtime.rs"]
mod horizontal_browse_transport_runtime;
#[path = "horizontal_browse_transport_snapshot.rs"]
mod horizontal_browse_transport_snapshot;
#[path = "horizontal_browse_transport_types.rs"]
mod horizontal_browse_transport_types;
#[path = "horizontal_browse_transport_visualizer.rs"]
mod horizontal_browse_transport_visualizer;
use crate::FfmpegTransportDecodeMetrics;
use horizontal_browse_transport_auto_gain::{DeckAutoGainState, LoudnessAnalysis};
use horizontal_browse_transport_decode::prepare_decoded_audio;
pub use horizontal_browse_transport_napi::*;

#[napi(object)]
pub struct R3MasterTempoOfflineResult {
  pub pcm_data: Buffer,
  pub mode: String,
  pub engine_version: i32,
  pub input_frames: u32,
  pub output_frames: u32,
  pub preferred_start_pad: u32,
  pub start_delay: u32,
  pub feed_calls: u32,
  pub retrieve_calls: u32,
  pub zero_retrieve_calls: u32,
}
pub use horizontal_browse_transport_recording::HorizontalBrowseTransportRecordingStatus;
use horizontal_browse_transport_runtime::{
  drain_decode_diagnostics, engine, execute_decode_request_sync, native_now_ms,
  next_snapshot_sequence, schedule_decode_request,
};
use horizontal_browse_transport_types::{
  parse_deck_id, BeatGridSnapshot, DeckDerivedState, DeckId, DecodeRequest,
  DynamicBeatGridClipSnapshot,
};
pub use horizontal_browse_transport_types::{
  HorizontalBrowseTransportBandState, HorizontalBrowseTransportBeatGridClipInput,
  HorizontalBrowseTransportBeatGridInput, HorizontalBrowseTransportDeckInput,
  HorizontalBrowseTransportDeckSnapshot, HorizontalBrowseTransportDecodeDiagnostic,
  HorizontalBrowseTransportOutputSnapshot, HorizontalBrowseTransportRekordboxBeatGridEntryInput,
  HorizontalBrowseTransportSnapshot, HorizontalBrowseTransportStateInput,
  HorizontalBrowseTransportVisualizerSnapshot,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct RekordboxBeatGridEntrySnapshot {
  pub(super) sec: f64,
  pub(super) bpm: f64,
  pub(super) beat_number: i32,
}

struct DeckState {
  file_path: Option<String>,
  loaded_file_path: Option<String>,
  fully_decoded_file_path: Option<String>,
  pending_decode_file_path: Option<String>,
  pending_decode_start_sec: Option<f64>,
  pending_decode_max_duration_sec: Option<f64>,
  pending_full_decode_file_path: Option<String>,
  title: Option<String>,
  bpm: Option<f64>,
  first_beat_ms: Option<f64>,
  downbeat_beat_offset: Option<f64>,
  dynamic_beat_grid: Vec<DynamicBeatGridClipSnapshot>,
  rekordbox_beat_grid_entries: Vec<RekordboxBeatGridEntrySnapshot>,
  time_basis_offset_ms: Option<f64>,
  duration_sec: f64,
  current_sec: f64,
  last_observed_at_ms: f64,
  playing: bool,
  playback_rate: f64,
  master_tempo_enabled: bool,
  decode_request_id: u64,
  full_decode_request_id: u64,
  pcm_data: Arc<Vec<f32>>,
  pcm_start_sec: f64,
  sample_rate: u32,
  channels: u16,
  loudness_analysis: Option<LoudnessAnalysis>,
  loudness_failed: bool,
  gain: f32,
  cue_monitor_enabled: bool,
  cue_monitor_gain: f32,
  auto_gain: DeckAutoGainState,
  band_state: HorizontalBrowseTransportBandState,
  band_filter_state: DeckBandFilterState,
  metronome_enabled: bool,
  metronome_volume_level: u8,
  metronome_state: MetronomeState,
  loop_active: bool,
  loop_beat_value: f64,
  loop_start_beat_index: Option<i32>,
  loop_start_sec: f64,
  loop_end_sec: f64,
  master_tempo_state: horizontal_browse_transport_audio::DeckMasterTempoState,
  scrub_preview: ScrubPreviewState,
}

struct MetronomeState {
  next_beat_index: Option<i64>,
  click_elapsed_samples: u32,
  click_total_samples: u32,
  oscillator_phase: f64,
}

#[derive(Clone, Copy)]
struct ScrubPreviewState {
  active: bool,
  current_sec: f64,
  rate: f64,
  level: f32,
}

#[derive(Clone, Copy)]
struct OnePoleLowPassState {
  left: f32,
  right: f32,
}

#[derive(Clone, Copy)]
struct DeckBandFilterState {
  low_split: OnePoleLowPassState,
  high_split: OnePoleLowPassState,
  initialized: bool,
}

struct DecodeApplyBaseline {
  pcm_start_sec: f64,
  sample_rate: u32,
  channels: u16,
}

struct PreparedDecodedAudio {
  pcm_data: Arc<Vec<f32>>,
  pcm_start_sec: f64,
  sample_rate: u32,
  channels: u16,
  preserve_master_tempo_state: bool,
}

const HORIZONTAL_BROWSE_STARTUP_DECODE_SEC: f64 = 10.0;
const HORIZONTAL_BROWSE_STARTUP_DECODE_PRE_ROLL_SEC: f64 = 0.25;
const HORIZONTAL_BROWSE_VISUALIZER_SAMPLE_COUNT: usize = 256;
const HORIZONTAL_BROWSE_LOOP_END_EPSILON_SEC: f64 = 0.0005;
const HORIZONTAL_BROWSE_LOOP_POSITION_EPSILON_SEC: f64 = 0.0001;
const HORIZONTAL_BROWSE_LOOP_BEAT_INDEX_EPSILON: f64 = 1e-6;
const HORIZONTAL_BROWSE_MASTER_TEMPO_PHASE_RESET_THRESHOLD_SEC: f64 = 0.001;
const HORIZONTAL_BROWSE_DYNAMIC_GRID_EPSILON_SEC: f64 = 0.000001;
const HORIZONTAL_BROWSE_METRONOME_BEAT_EPSILON_SEC: f64 = 1e-7;
const HORIZONTAL_BROWSE_METRONOME_TICK_FREQUENCY_HZ: f64 = 1560.0;
const HORIZONTAL_BROWSE_METRONOME_TICK_END_FREQUENCY_HZ: f64 = 1320.0;
const HORIZONTAL_BROWSE_METRONOME_TICK_ATTACK_SEC: f64 = 0.002;
const HORIZONTAL_BROWSE_METRONOME_TICK_DURATION_SEC: f64 = 0.045;
const HORIZONTAL_BROWSE_METRONOME_GAIN_FLOOR: f32 = 0.0001;
const HORIZONTAL_BROWSE_METRONOME_VOLUME_LEVELS: [f32; 3] = [0.42, 0.68, 0.96];
const HORIZONTAL_BROWSE_LOOP_DEFAULT_BEAT_VALUE: f64 = 8.0;
const HORIZONTAL_BROWSE_LOOP_BEAT_VALUES: [f64; 16] = [
  1.0 / 64.0,
  1.0 / 32.0,
  1.0 / 16.0,
  1.0 / 8.0,
  1.0 / 4.0,
  1.0 / 2.0,
  1.0,
  2.0,
  4.0,
  8.0,
  16.0,
  32.0,
  64.0,
  128.0,
  256.0,
  512.0,
];

impl Default for MetronomeState {
  fn default() -> Self {
    Self {
      next_beat_index: None,
      click_elapsed_samples: 0,
      click_total_samples: 0,
      oscillator_phase: 0.0,
    }
  }
}

impl Default for ScrubPreviewState {
  fn default() -> Self {
    Self {
      active: false,
      current_sec: 0.0,
      rate: 0.0,
      level: 0.0,
    }
  }
}

impl Default for OnePoleLowPassState {
  fn default() -> Self {
    Self {
      left: 0.0,
      right: 0.0,
    }
  }
}

impl Default for DeckBandFilterState {
  fn default() -> Self {
    Self {
      low_split: OnePoleLowPassState::default(),
      high_split: OnePoleLowPassState::default(),
      initialized: false,
    }
  }
}

impl Default for HorizontalBrowseTransportBandState {
  fn default() -> Self {
    Self {
      high: true,
      mid: true,
      low: true,
    }
  }
}

impl Default for DeckState {
  fn default() -> Self {
    Self {
      file_path: None,
      loaded_file_path: None,
      fully_decoded_file_path: None,
      pending_decode_file_path: None,
      pending_decode_start_sec: None,
      pending_decode_max_duration_sec: None,
      pending_full_decode_file_path: None,
      title: None,
      bpm: None,
      first_beat_ms: None,
      downbeat_beat_offset: None,
      dynamic_beat_grid: Vec::new(),
      rekordbox_beat_grid_entries: Vec::new(),
      time_basis_offset_ms: None,
      duration_sec: 0.0,
      current_sec: 0.0,
      last_observed_at_ms: 0.0,
      playing: false,
      playback_rate: 1.0,
      master_tempo_enabled: true,
      decode_request_id: 0,
      full_decode_request_id: 0,
      pcm_data: Arc::new(Vec::new()),
      pcm_start_sec: 0.0,
      sample_rate: 0,
      channels: 0,
      loudness_analysis: None,
      loudness_failed: false,
      gain: 1.0,
      cue_monitor_enabled: false,
      cue_monitor_gain: 0.0,
      auto_gain: DeckAutoGainState::default(),
      band_state: HorizontalBrowseTransportBandState::default(),
      band_filter_state: DeckBandFilterState::default(),
      metronome_enabled: false,
      metronome_volume_level: 2,
      metronome_state: MetronomeState::default(),
      loop_active: false,
      loop_beat_value: 8.0,
      loop_start_beat_index: None,
      loop_start_sec: 0.0,
      loop_end_sec: 0.0,
      master_tempo_state: horizontal_browse_transport_audio::DeckMasterTempoState::default(),
      scrub_preview: ScrubPreviewState::default(),
    }
  }
}

struct HorizontalBrowseTransportEngine {
  top: DeckState,
  bottom: DeckState,
  audition_suspended: bool,
  last_now_ms: f64,
  last_native_now_ms: f64,
  state_revision: u64,
  output_sample_rate: u32,
  output_channels: u16,
  leader: Option<DeckId>,
  sync_enabled: [bool; 2],
  sync_lock: [&'static str; 2],
  beat_distance: [f64; 2],
  target_beat_distance: [f64; 2],
  quantize_enabled: [bool; 2],
  bpm_multiplier: [f64; 2],
  trim_gain: [f32; 2],
  master_gain: f32,
  crossfader_value: f32,
  master_limiter: horizontal_browse_transport_limiter::MasterLimiterState,
  visualizer_ring: Vec<f32>,
  visualizer_write_index: usize,
  visualizer_filled: bool,
  recording: horizontal_browse_transport_recording::RecordingController,
}

static OUTPUT_THREAD_STARTED: OnceLock<()> = OnceLock::new();

impl Default for HorizontalBrowseTransportEngine {
  fn default() -> Self {
    Self {
      top: DeckState::default(),
      bottom: DeckState::default(),
      audition_suspended: false,
      last_now_ms: 0.0,
      last_native_now_ms: 0.0,
      state_revision: 0,
      output_sample_rate: 44100,
      output_channels: 2,
      leader: None,
      sync_enabled: [false, false],
      sync_lock: ["off", "off"],
      beat_distance: [0.0, 0.0],
      target_beat_distance: [0.0, 0.0],
      quantize_enabled: [true, true],
      bpm_multiplier: [1.0, 1.0],
      trim_gain: [1.0, 1.0],
      master_gain: 1.0,
      crossfader_value: 0.0,
      master_limiter: horizontal_browse_transport_limiter::MasterLimiterState::default(),
      visualizer_ring: vec![0.0; HORIZONTAL_BROWSE_VISUALIZER_SAMPLE_COUNT],
      visualizer_write_index: 0,
      visualizer_filled: false,
      recording: horizontal_browse_transport_recording::RecordingController::default(),
    }
  }
}

impl HorizontalBrowseTransportEngine {
  fn reset_preserving_output_config(&mut self) {
    let output_sample_rate = self.output_sample_rate.max(1);
    let output_channels = self.output_channels.max(1);
    *self = Self::default();
    self.output_sample_rate = output_sample_rate;
    self.output_channels = output_channels;
  }

  fn mark_state_changed(&mut self) {
    self.state_revision = self.state_revision.wrapping_add(1);
    if self.state_revision == 0 {
      self.state_revision = 1;
    }
  }

  fn observe_external_now_ms(&mut self, now_ms: f64) {
    if !now_ms.is_finite() || now_ms < 0.0 {
      return;
    }
    self.last_now_ms = now_ms;
    self.last_native_now_ms = native_now_ms();
  }

  fn current_external_now_ms(&self) -> f64 {
    if self.last_native_now_ms <= 0.0 {
      return self.last_now_ms;
    }
    self.last_now_ms + (native_now_ms() - self.last_native_now_ms).max(0.0)
  }

  fn resolve_loaded_segment_end_sec(&self, deck: DeckId) -> f64 {
    let deck_state = self.deck(deck);
    if deck_state.sample_rate == 0 || deck_state.channels == 0 {
      return deck_state.pcm_start_sec;
    }
    let frame_count = deck_state.pcm_data.len() / deck_state.channels as usize;
    deck_state.pcm_start_sec + frame_count as f64 / deck_state.sample_rate as f64
  }

  fn has_loaded_segment_covering(&self, deck: DeckId, target_sec: f64) -> bool {
    let deck_state = self.deck(deck);
    if !target_sec.is_finite() || target_sec < 0.0 {
      return false;
    }
    if deck_state.loaded_file_path.as_deref() != deck_state.file_path.as_deref() {
      return false;
    }
    if deck_state.pcm_data.is_empty() || deck_state.sample_rate == 0 || deck_state.channels == 0 {
      return false;
    }
    let safe_target_sec = Self::timeline_sec_to_audio_sec(deck_state, target_sec);
    safe_target_sec + 0.0001 >= deck_state.pcm_start_sec
      && safe_target_sec < self.resolve_loaded_segment_end_sec(deck) - 0.0001
  }

  fn resolve_startup_decode_target_sec(&self, deck: DeckId) -> f64 {
    let deck_state = self.deck(deck);
    let current_sec = Self::estimate_current_sec(deck_state, self.last_now_ms);
    if current_sec.is_finite() {
      current_sec.max(0.0)
    } else {
      0.0
    }
  }

  fn resolve_startup_decode_start_sec(&self, deck: DeckId, target_timeline_sec: f64) -> f64 {
    let deck_state = self.deck(deck);
    let target_audio_sec = (Self::timeline_sec_to_audio_sec(deck_state, target_timeline_sec)
      - HORIZONTAL_BROWSE_STARTUP_DECODE_PRE_ROLL_SEC)
      .max(0.0);
    if deck_state.duration_sec.is_finite() && deck_state.duration_sec > 0.0 {
      return target_audio_sec.min((deck_state.duration_sec - 0.001).max(0.0));
    }
    target_audio_sec
  }

  fn is_fully_decoded(&self, deck: DeckId) -> bool {
    let deck_state = self.deck(deck);
    let file_path = deck_state
      .file_path
      .as_ref()
      .map(|value| value.trim())
      .unwrap_or("");
    let fully_decoded_file_path = deck_state
      .fully_decoded_file_path
      .as_ref()
      .map(|value| value.trim())
      .unwrap_or("");
    !file_path.is_empty()
      && file_path == fully_decoded_file_path
      && deck_state.loaded_file_path.as_deref().map(str::trim) == Some(file_path)
      && deck_state.pcm_start_sec <= 0.0001
      && !deck_state.pcm_data.is_empty()
      && deck_state.sample_rate > 0
      && deck_state.channels > 0
  }

  fn is_playing_audible_at(&self, deck: DeckId, now_ms: f64) -> bool {
    if self.audition_suspended {
      return false;
    }
    let deck_state = self.deck(deck);
    if !deck_state.playing {
      return false;
    }
    let current_sec = Self::estimate_current_sec(deck_state, now_ms);
    self.has_loaded_segment_covering(deck, current_sec)
  }

  fn is_negative_silent_lead_in_ready(&self, deck: DeckId, now_ms: f64) -> bool {
    let deck_state = self.deck(deck);
    if !deck_state.playing {
      return false;
    }
    let current_sec = Self::estimate_current_sec(deck_state, now_ms);
    current_sec.is_finite() && current_sec < 0.0 && self.has_loaded_segment_covering(deck, 0.0)
  }

  fn is_sync_ready(&self, deck: DeckId, now_ms: f64) -> bool {
    if !self.is_loaded(deck) {
      return false;
    }
    if self.audition_suspended {
      return true;
    }
    if !self.deck(deck).playing {
      return true;
    }
    self.is_playing_audible_at(deck, now_ms) || self.is_negative_silent_lead_in_ready(deck, now_ms)
  }

  fn auto_select_leader_from_playback(&mut self) {
    let now_ms = self.last_now_ms;
    let top_audible = self.is_playing_audible_at(DeckId::Top, now_ms);
    let bottom_audible = self.is_playing_audible_at(DeckId::Bottom, now_ms);
    match (top_audible, bottom_audible) {
      (true, false) => {
        if self.leader.is_none() || !self.is_playing_audible_at(self.leader.unwrap(), now_ms) {
          self.leader = Some(DeckId::Top);
        }
      }
      (false, true) => {
        if self.leader.is_none() || !self.is_playing_audible_at(self.leader.unwrap(), now_ms) {
          self.leader = Some(DeckId::Bottom);
        }
      }
      _ => {
        if let Some(leader) = self.leader {
          if !self.is_sync_ready(leader, now_ms) {
            self.leader = None;
          }
        }
      }
    }
  }

  fn ensure_output_stream(&mut self) -> napi::Result<()> {
    if OUTPUT_THREAD_STARTED.get().is_some() {
      return Ok(());
    }
    OUTPUT_THREAD_STARTED
      .set(())
      .map_err(|_| Error::from_reason("output thread already started"))?;
    thread::spawn(|| {
      let host = cpal::default_host();
      let Some(device) = host.default_output_device() else {
        eprintln!("[horizontal-browse-transport] no default output device");
        return;
      };
      let supported = match Self::default_output_config_with_retry(&device) {
        Ok(config) => config,
        Err(err) => {
          eprintln!(
            "[horizontal-browse-transport] default output config failed: {}",
            err
          );
          return;
        }
      };
      {
        let mut engine = engine().lock();
        engine.output_sample_rate = supported.sample_rate();
        engine.output_channels = supported.channels();
      }
      let stream_config: cpal::StreamConfig = supported.into();
      let stream_result = match supported.sample_format() {
        cpal::SampleFormat::F32 => {
          HorizontalBrowseTransportEngine::build_output_stream::<f32>(&device, stream_config)
        }
        cpal::SampleFormat::F64 => {
          HorizontalBrowseTransportEngine::build_output_stream::<f64>(&device, stream_config)
        }
        cpal::SampleFormat::I32 => {
          HorizontalBrowseTransportEngine::build_output_stream::<i32>(&device, stream_config)
        }
        cpal::SampleFormat::I24 => {
          HorizontalBrowseTransportEngine::build_output_stream::<cpal::I24>(&device, stream_config)
        }
        cpal::SampleFormat::I16 => {
          HorizontalBrowseTransportEngine::build_output_stream::<i16>(&device, stream_config)
        }
        cpal::SampleFormat::U16 => {
          HorizontalBrowseTransportEngine::build_output_stream::<u16>(&device, stream_config)
        }
        other => {
          eprintln!(
            "[horizontal-browse-transport] unsupported sample format: {:?}",
            other
          );
          return;
        }
      };
      let Ok(stream) = stream_result else {
        eprintln!("[horizontal-browse-transport] build output stream failed");
        return;
      };
      if let Err(err) = stream.play() {
        eprintln!(
          "[horizontal-browse-transport] play output stream failed: {}",
          err
        );
        return;
      }
      loop {
        thread::sleep(Duration::from_secs(60));
        let _keep_alive = &stream;
      }
    });
    Ok(())
  }

  fn default_output_config_with_retry(
    device: &cpal::Device,
  ) -> std::result::Result<cpal::SupportedStreamConfig, cpal::Error> {
    const MAX_BUSY_RETRIES: usize = 10;
    let mut busy_retries = 0;
    loop {
      match device.default_output_config() {
        Ok(config) => return Ok(config),
        Err(err)
          if err.kind() == cpal::ErrorKind::DeviceBusy && busy_retries < MAX_BUSY_RETRIES =>
        {
          busy_retries += 1;
          thread::sleep(Duration::from_millis(100));
        }
        Err(err) => return Err(err),
      }
    }
  }

  fn build_output_stream<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
  ) -> napi::Result<cpal::Stream>
  where
    T: cpal::SizedSample + cpal::FromSample<f32>,
  {
    let channels = config.channels as usize;
    let err_fn = |err| {
      eprintln!("[horizontal-browse-transport] output stream error: {}", err);
    };
    device
      .build_output_stream(
        config,
        move |data: &mut [T], _| {
          let mut engine = engine().lock();
          for frame in data.chunks_mut(channels) {
            let (left, right) = engine.mix_output_frame();
            if let Some(sample) = frame.get_mut(0) {
              *sample = T::from_sample(left);
            }
            if channels >= 2 {
              if let Some(sample) = frame.get_mut(1) {
                *sample = T::from_sample(right);
              }
              for channel in 2..channels {
                if let Some(sample) = frame.get_mut(channel) {
                  *sample = T::from_sample((left + right) * 0.5);
                }
              }
            }
          }
        },
        err_fn,
        None,
      )
      .map_err(|err| Error::from_reason(format!("build output stream failed: {}", err)))
  }

  fn mix_output_frame(&mut self) -> (f32, f32) {
    // Playlist waveform audition is a transport-wide time freeze. Bail out before
    // either deck consumes a source frame so their relative phase cannot move.
    // Recording also intentionally receives no frames while transport time is frozen.
    if self.audition_suspended {
      self.push_visualizer_sample(0.0);
      return (0.0, 0.0);
    }
    let mut playback_left = 0.0_f32;
    let mut playback_right = 0.0_f32;
    let mut record_left = 0.0_f32;
    let mut record_right = 0.0_f32;
    for deck in [DeckId::Top, DeckId::Bottom] {
      let deck_output = self.sample_deck_mix(deck);
      playback_left += deck_output.program.0 + deck_output.monitor.0 + deck_output.metronome;
      playback_right += deck_output.program.1 + deck_output.monitor.1 + deck_output.metronome;
      record_left += deck_output.program.0;
      record_right += deck_output.program.1;
    }
    let (limited_record_left, limited_record_right) =
      self
        .master_limiter
        .process(record_left, record_right, self.output_sample_rate);
    let playback_left = limited_record_left + (playback_left - record_left);
    let playback_right = limited_record_right + (playback_right - record_right);
    let protected_playback_left =
      horizontal_browse_transport_limiter::soft_limit_sample(playback_left);
    let protected_playback_right =
      horizontal_browse_transport_limiter::soft_limit_sample(playback_right);
    self.push_visualizer_sample((protected_playback_left + protected_playback_right) * 0.5);
    self.recording.capture_frame(
      self.output_sample_rate.max(1),
      limited_record_left,
      limited_record_right,
    );
    (protected_playback_left, protected_playback_right)
  }

  fn resolve_next_metronome_beat_index(current_sec: f64, grid: BeatGridSnapshot) -> i64 {
    let raw = (current_sec - grid.first_beat_sec) / grid.beat_sec;
    let epsilon_beats = HORIZONTAL_BROWSE_METRONOME_BEAT_EPSILON_SEC / grid.beat_sec;
    let mut index = (raw - epsilon_beats).ceil() as i64;
    while grid.first_beat_sec + index as f64 * grid.beat_sec < 0.0 {
      index += 1;
    }
    index
  }

  fn maybe_trigger_metronome(
    target: &mut DeckState,
    grid: BeatGridSnapshot,
    before_sec: f64,
    after_sec: f64,
    was_playing: bool,
    output_sample_rate: f64,
  ) {
    if !target.metronome_enabled
      || !was_playing
      || !target.playing
      || target.pcm_data.is_empty()
      || target.sample_rate == 0
      || target.channels == 0
      || !before_sec.is_finite()
      || !after_sec.is_finite()
      || !grid.beat_sec.is_finite()
      || grid.beat_sec <= 0.0
    {
      target.metronome_state.next_beat_index = None;
      target.metronome_state.click_elapsed_samples = 0;
      target.metronome_state.click_total_samples = 0;
      return;
    }

    let expected_index = Self::resolve_next_metronome_beat_index(before_sec.max(0.0), grid);
    let mut next_index = target
      .metronome_state
      .next_beat_index
      .unwrap_or(expected_index);
    if next_index < expected_index || next_index > expected_index + 1 {
      next_index = expected_index;
    }

    let beat_time_sec = grid.first_beat_sec + next_index as f64 * grid.beat_sec;
    if beat_time_sec >= before_sec - HORIZONTAL_BROWSE_METRONOME_BEAT_EPSILON_SEC
      && beat_time_sec <= after_sec + HORIZONTAL_BROWSE_METRONOME_BEAT_EPSILON_SEC
    {
      target.metronome_state.click_elapsed_samples = 0;
      target.metronome_state.click_total_samples =
        (HORIZONTAL_BROWSE_METRONOME_TICK_DURATION_SEC * output_sample_rate).ceil() as u32;
      target.metronome_state.oscillator_phase = 0.0;
      next_index += 1;
    }

    target.metronome_state.next_beat_index = Some(next_index);
  }

  fn sample_metronome_click(target: &mut DeckState, output_sample_rate: f64) -> f32 {
    let state = &mut target.metronome_state;
    if state.click_elapsed_samples >= state.click_total_samples || state.click_total_samples == 0 {
      return 0.0;
    }

    let elapsed_sec = state.click_elapsed_samples as f64 / output_sample_rate.max(1.0);
    let progress = (elapsed_sec / HORIZONTAL_BROWSE_METRONOME_TICK_DURATION_SEC).clamp(0.0, 1.0);
    let frequency = HORIZONTAL_BROWSE_METRONOME_TICK_FREQUENCY_HZ
      * (HORIZONTAL_BROWSE_METRONOME_TICK_END_FREQUENCY_HZ
        / HORIZONTAL_BROWSE_METRONOME_TICK_FREQUENCY_HZ)
        .powf(progress);
    state.oscillator_phase = (state.oscillator_phase
      + std::f64::consts::TAU * frequency / output_sample_rate.max(1.0))
      % std::f64::consts::TAU;
    let wave = Self::band_limited_square(
      state.oscillator_phase,
      frequency,
      output_sample_rate.max(1.0),
    );
    let volume_index = target.metronome_volume_level.saturating_sub(1) as usize;
    let volume = HORIZONTAL_BROWSE_METRONOME_VOLUME_LEVELS
      .get(volume_index)
      .copied()
      .unwrap_or(HORIZONTAL_BROWSE_METRONOME_VOLUME_LEVELS[1]);
    let envelope = if elapsed_sec < HORIZONTAL_BROWSE_METRONOME_TICK_ATTACK_SEC {
      Self::exponential_ramp(
        HORIZONTAL_BROWSE_METRONOME_GAIN_FLOOR,
        volume,
        elapsed_sec / HORIZONTAL_BROWSE_METRONOME_TICK_ATTACK_SEC,
      )
    } else {
      let decay_sec =
        HORIZONTAL_BROWSE_METRONOME_TICK_DURATION_SEC - HORIZONTAL_BROWSE_METRONOME_TICK_ATTACK_SEC;
      Self::exponential_ramp(
        volume,
        HORIZONTAL_BROWSE_METRONOME_GAIN_FLOOR,
        (elapsed_sec - HORIZONTAL_BROWSE_METRONOME_TICK_ATTACK_SEC) / decay_sec,
      )
    };
    state.click_elapsed_samples = state.click_elapsed_samples.saturating_add(1);
    wave * envelope
  }

  fn band_limited_square(phase: f64, frequency: f64, output_sample_rate: f64) -> f32 {
    if !frequency.is_finite() || frequency <= 0.0 {
      return 0.0;
    }
    let nyquist = output_sample_rate.max(1.0) * 0.5;
    let max_odd_harmonic = ((nyquist / frequency).floor() as i32).max(1).min(31);
    let mut harmonic = 1;
    let mut sum = 0.0_f64;
    while harmonic <= max_odd_harmonic {
      sum += (phase * harmonic as f64).sin() / harmonic as f64;
      harmonic += 2;
    }
    ((4.0 / std::f64::consts::PI) * sum).clamp(-1.0, 1.0) as f32
  }

  fn exponential_ramp(start: f32, end: f32, progress: f64) -> f32 {
    let safe_start = start.max(HORIZONTAL_BROWSE_METRONOME_GAIN_FLOOR);
    let safe_end = end.max(HORIZONTAL_BROWSE_METRONOME_GAIN_FLOOR);
    let ratio = safe_end / safe_start;
    safe_start * ratio.powf(progress.clamp(0.0, 1.0) as f32)
  }

  fn sample_metronome(
    &mut self,
    deck: DeckId,
    before_sec: f64,
    after_sec: f64,
    was_playing: bool,
  ) -> f32 {
    let output_sample_rate = self.output_sample_rate.max(1) as f64;
    let grid = self.beat_grid_at_sec(deck, before_sec);
    let target = self.deck_mut(deck);
    if let Some(grid) = grid {
      Self::maybe_trigger_metronome(
        target,
        grid,
        before_sec,
        after_sec,
        was_playing,
        output_sample_rate,
      );
    } else {
      target.metronome_state.next_beat_index = None;
      target.metronome_state.click_elapsed_samples = 0;
      target.metronome_state.click_total_samples = 0;
    }
    Self::sample_metronome_click(target, output_sample_rate)
  }

  fn push_visualizer_sample(&mut self, sample: f32) {
    horizontal_browse_transport_visualizer::push_visualizer_sample(
      &mut self.visualizer_ring,
      &mut self.visualizer_write_index,
      &mut self.visualizer_filled,
      sample,
    );
  }

  fn visualizer_snapshot(&self) -> HorizontalBrowseTransportVisualizerSnapshot {
    let mut snapshot = horizontal_browse_transport_visualizer::visualizer_snapshot(
      &self.visualizer_ring,
      self.visualizer_write_index,
      self.visualizer_filled,
    );
    snapshot.limiter_overload = self.master_limiter.overload();
    snapshot.limiter_gain_reduction_db = self.master_limiter.gain_reduction_db() as f64;
    snapshot.pre_limiter_peak_left_db = self.master_limiter.pre_limiter_peak_left_db() as f64;
    snapshot.pre_limiter_peak_right_db = self.master_limiter.pre_limiter_peak_right_db() as f64;
    snapshot
  }

  fn deck(&self, deck: DeckId) -> &DeckState {
    match deck {
      DeckId::Top => &self.top,
      DeckId::Bottom => &self.bottom,
    }
  }

  fn deck_mut(&mut self, deck: DeckId) -> &mut DeckState {
    match deck {
      DeckId::Top => &mut self.top,
      DeckId::Bottom => &mut self.bottom,
    }
  }

  fn deck_index(deck: DeckId) -> usize {
    match deck {
      DeckId::Top => 0,
      DeckId::Bottom => 1,
    }
  }

  fn clamp_unit_gain(value: f64) -> f32 {
    if value.is_finite() {
      value.clamp(0.0, 1.0) as f32
    } else {
      1.0
    }
  }

  fn clamp_crossfader_value(value: f64) -> f32 {
    if value.is_finite() {
      value.clamp(-1.0, 1.0) as f32
    } else {
      0.0
    }
  }

  fn normalize_playback_rate(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
      value.clamp(0.25, 4.0)
    } else {
      1.0
    }
  }

  fn sync_master_tempo_state_after_change(
    &mut self,
    deck: DeckId,
    was_active: bool,
    force_reset: bool,
  ) {
    let output_sample_rate = self.output_sample_rate.max(1) as f64;
    let is_active = horizontal_browse_transport_audio::should_use_master_tempo(self.deck(deck));
    let target = self.deck_mut(deck);
    if is_active {
      if force_reset || !was_active {
        horizontal_browse_transport_audio::reset_master_tempo_state(target);
      }
      horizontal_browse_transport_audio::prime_master_tempo_state(target, output_sample_rate);
      return;
    }
    if was_active || force_reset {
      horizontal_browse_transport_audio::clear_master_tempo_state(target);
    }
  }

  fn reset_and_prime_master_tempo_state(&mut self, deck: DeckId) {
    let output_sample_rate = self.output_sample_rate.max(1) as f64;
    let target = self.deck_mut(deck);
    horizontal_browse_transport_audio::reset_master_tempo_state(target);
    horizontal_browse_transport_audio::prime_master_tempo_state(target, output_sample_rate);
  }

  fn resolve_crossfader_volumes(value: f32) -> (f32, f32) {
    let safe_value = value.clamp(-1.0, 1.0);
    if safe_value >= 0.0 {
      (1.0, 1.0 - safe_value)
    } else {
      (1.0 + safe_value, 1.0)
    }
  }

  fn refresh_output_gains(&mut self) {
    let (top_crossfader_gain, bottom_crossfader_gain) =
      Self::resolve_crossfader_volumes(self.crossfader_value);
    let top_trim = self.trim_gain[Self::deck_index(DeckId::Top)];
    let bottom_trim = self.trim_gain[Self::deck_index(DeckId::Bottom)];
    self.top.gain =
      (top_trim * self.top.auto_gain.current_linear * self.master_gain * top_crossfader_gain)
        .max(0.0);
    self.top.cue_monitor_gain = if self.top.cue_monitor_enabled {
      (top_trim * self.top.auto_gain.current_linear * self.master_gain).max(0.0)
    } else {
      0.0
    };
    self.bottom.gain = (bottom_trim
      * self.bottom.auto_gain.current_linear
      * self.master_gain
      * bottom_crossfader_gain)
      .max(0.0);
    self.bottom.cue_monitor_gain = if self.bottom.cue_monitor_enabled {
      (bottom_trim * self.bottom.auto_gain.current_linear * self.master_gain).max(0.0)
    } else {
      0.0
    };
  }

  fn is_loaded(&self, deck: DeckId) -> bool {
    let deck_state = self.deck(deck);
    let file_path = deck_state
      .file_path
      .as_ref()
      .map(|path| path.trim())
      .unwrap_or("");
    let loaded_file_path = deck_state
      .loaded_file_path
      .as_ref()
      .map(|path| path.trim())
      .unwrap_or("");
    !file_path.is_empty()
      && file_path == loaded_file_path
      && !deck_state.pcm_data.is_empty()
      && deck_state.sample_rate > 0
      && deck_state.channels > 0
  }

  fn set_sync_lock(&mut self, deck: DeckId, next: &'static str) {
    let index = Self::deck_index(deck);
    self.sync_lock[index] = if self.sync_enabled[index] {
      next
    } else {
      "off"
    };
  }
}

#[cfg(test)]
#[path = "horizontal_browse_transport_audition_tests.rs"]
mod horizontal_browse_transport_audition_tests;
#[cfg(test)]
#[path = "horizontal_browse_transport_auto_gain_tests.rs"]
mod horizontal_browse_transport_auto_gain_tests;
#[cfg(test)]
#[path = "horizontal_browse_transport_cue_monitor_tests.rs"]
mod horizontal_browse_transport_cue_monitor_tests;
#[cfg(test)]
#[path = "horizontal_browse_transport_decode_tests.rs"]
mod horizontal_browse_transport_decode_tests;
#[cfg(test)]
#[path = "horizontal_browse_transport_grid_sync_tests.rs"]
mod horizontal_browse_transport_grid_sync_tests;
#[cfg(test)]
#[path = "horizontal_browse_transport_tests.rs"]
mod horizontal_browse_transport_tests;
