use napi::bindgen_prelude::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum DeckId {
  Top,
  Bottom,
}

impl DeckId {
  pub(super) fn as_str(self) -> &'static str {
    match self {
      DeckId::Top => "top",
      DeckId::Bottom => "bottom",
    }
  }

  pub(super) fn other(self) -> Self {
    match self {
      DeckId::Top => DeckId::Bottom,
      DeckId::Bottom => DeckId::Top,
    }
  }
}

pub(super) fn parse_deck_id(raw: &str) -> napi::Result<DeckId> {
  match raw.trim().to_lowercase().as_str() {
    "top" => Ok(DeckId::Top),
    "bottom" => Ok(DeckId::Bottom),
    _ => Err(Error::from_reason(format!("unknown deck id: {}", raw))),
  }
}

#[napi(object)]
#[derive(Clone)]
pub struct HorizontalBrowseTransportBeatGridClipInput {
  pub start_sec: f64,
  pub anchor_sec: f64,
  pub bpm: f64,
  pub downbeat_beat_offset: f64,
}

#[napi(object)]
#[derive(Clone)]
pub struct HorizontalBrowseTransportRekordboxBeatGridEntryInput {
  pub time_ms: f64,
  pub bpm: f64,
  pub beat_number: i32,
}

#[napi(object)]
pub struct HorizontalBrowseTransportDeckInput {
  pub file_path: Option<String>,
  pub title: Option<String>,
  pub bpm: Option<f64>,
  pub first_beat_ms: Option<f64>,
  pub downbeat_beat_offset: Option<f64>,
  pub beat_grid_clips: Option<Vec<HorizontalBrowseTransportBeatGridClipInput>>,
  pub rekordbox_beat_grid_entries: Option<Vec<HorizontalBrowseTransportRekordboxBeatGridEntryInput>>,
  pub time_basis_offset_ms: Option<f64>,
  pub duration_sec: f64,
  pub current_sec: f64,
  pub last_observed_at_ms: f64,
  pub playing: bool,
  pub playback_rate: f64,
  pub master_tempo_enabled: bool,
}

#[napi(object)]
pub struct HorizontalBrowseTransportBeatGridInput {
  pub file_path: Option<String>,
  pub bpm: Option<f64>,
  pub first_beat_ms: Option<f64>,
  pub downbeat_beat_offset: Option<f64>,
  pub beat_grid_clips: Option<Vec<HorizontalBrowseTransportBeatGridClipInput>>,
  pub rekordbox_beat_grid_entries: Option<Vec<HorizontalBrowseTransportRekordboxBeatGridEntryInput>>,
  pub time_basis_offset_ms: Option<f64>,
}

#[napi(object)]
pub struct HorizontalBrowseTransportStateInput {
  pub now_ms: Option<f64>,
  pub allow_phase_alignment: Option<bool>,
  pub top: HorizontalBrowseTransportDeckInput,
  pub bottom: HorizontalBrowseTransportDeckInput,
}

#[napi(object)]
#[derive(Clone, Copy)]
pub struct HorizontalBrowseTransportBandState {
  pub high: bool,
  pub mid: bool,
  pub low: bool,
}

#[napi(object)]
pub struct HorizontalBrowseTransportDeckSnapshot {
  pub deck: String,
  pub label: String,
  pub loaded: bool,
  pub fully_decoded: bool,
  pub decoding: bool,
  pub full_decoding: bool,
  pub play_requested: bool,
  pub playing_audible: bool,
  pub playhead_loaded: bool,
  pub playing: bool,
  pub current_sec: f64,
  pub audio_current_sec: f64,
  pub loaded_segment_start_sec: f64,
  pub loaded_segment_end_sec: f64,
  pub duration_sec: f64,
  pub effective_duration_sec: f64,
  pub playback_rate: f64,
  pub master_tempo_enabled: bool,
  pub bpm: f64,
  pub effective_bpm: f64,
  pub render_current_sec: f64,
  pub sync_enabled: bool,
  pub sync_lock: String,
  pub leader: bool,
  pub loop_active: bool,
  pub loop_beat_value: f64,
  pub loop_start_beat_index: Option<i32>,
  pub loop_start_sec: f64,
  pub loop_end_sec: f64,
  pub bands: HorizontalBrowseTransportBandState,
  pub cue_monitor_enabled: bool,
  pub auto_gain_enabled: bool,
  pub auto_gain_status: String,
  pub auto_gain_value: f64,
}

#[napi(object)]
pub struct HorizontalBrowseTransportOutputSnapshot {
  pub crossfader_value: f64,
  pub master_gain: f64,
  pub top_deck_gain: f64,
  pub bottom_deck_gain: f64,
  pub limiter_overload: bool,
  pub limiter_gain_reduction_db: f64,
  pub sample_rate: f64,
  pub channels: f64,
}

#[napi(object)]
pub struct HorizontalBrowseTransportSnapshot {
  pub snapshot_sequence: f64,
  pub state_revision: f64,
  pub audition_suspended: bool,
  pub leader_deck: Option<String>,
  pub top: HorizontalBrowseTransportDeckSnapshot,
  pub bottom: HorizontalBrowseTransportDeckSnapshot,
  pub output: HorizontalBrowseTransportOutputSnapshot,
}

#[napi(object)]
pub struct HorizontalBrowseTransportVisualizerSnapshot {
  pub time_domain_data: Vec<u8>,
  pub limiter_overload: bool,
  pub limiter_gain_reduction_db: f64,
  pub pre_limiter_peak_left_db: f64,
  pub pre_limiter_peak_right_db: f64,
}

#[napi(object)]
#[derive(Clone)]
pub struct HorizontalBrowseTransportDecodeDiagnostic {
  pub operation: String,
  pub status: String,
  pub deck: String,
  pub file_path: String,
  pub request_id: f64,
  pub full_decode: bool,
  pub start_sec: f64,
  pub max_duration_sec: Option<f64>,
  pub decoder_backend: Option<String>,
  pub queue_wait_ms: Option<f64>,
  pub total_ms: f64,
  pub ffmpeg_total_ms: Option<f64>,
  pub ffmpeg_spawn_ms: Option<f64>,
  pub ffmpeg_first_byte_ms: Option<f64>,
  pub ffmpeg_read_ms: Option<f64>,
  pub ffmpeg_convert_ms: Option<f64>,
  pub ffmpeg_wait_ms: Option<f64>,
  pub ffmpeg_stderr_join_ms: Option<f64>,
  pub ffmpeg_stdout_bytes: Option<f64>,
  pub ffmpeg_read_iterations: Option<f64>,
  pub prepare_ms: Option<f64>,
  pub apply_ms: Option<f64>,
  pub loudness_ms: Option<f64>,
  pub sample_count: f64,
  pub frame_count: f64,
  pub sample_rate: f64,
  pub channels: f64,
}

pub(super) struct DecodeRequest {
  pub(super) deck: DeckId,
  pub(super) file_path: String,
  pub(super) request_id: u64,
  pub(super) start_sec: f64,
  pub(super) max_duration_sec: Option<f64>,
  pub(super) is_full_decode: bool,
  pub(super) queued_at_ms: Option<f64>,
}

#[derive(Clone, Copy, PartialEq)]
pub(super) struct BeatGridSnapshot {
  pub(super) bpm: f64,
  pub(super) beat_sec: f64,
  pub(super) first_beat_sec: f64,
  pub(super) downbeat_beat_offset: f64,
}

#[derive(Clone, Copy, PartialEq)]
pub(super) struct DynamicBeatGridClipSnapshot {
  pub(super) start_sec: f64,
  pub(super) end_sec: f64,
  pub(super) anchor_sec: f64,
  pub(super) bpm: f64,
  pub(super) beat_sec: f64,
  pub(super) downbeat_beat_offset: f64,
  pub(super) first_beat_index: i64,
  pub(super) first_beat_ordinal: i64,
  pub(super) line_count: i64,
}

#[derive(Clone, Copy)]
pub(super) struct DeckDerivedState {
  pub(super) estimated_current_sec: f64,
  pub(super) effective_bpm: f64,
  pub(super) render_current_sec: f64,
  pub(super) playing_audible: bool,
}
