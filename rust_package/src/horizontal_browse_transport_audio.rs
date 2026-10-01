use super::horizontal_browse_transport_r3_stretch::R3MasterTempoProcessor;
use super::DeckState;

const MIN_RATE: f64 = 0.25;
const MAX_RATE: f64 = 4.0;
const SCRUB_MIN_RATE: f64 = 0.04;
const SCRUB_MAX_RATE: f64 = 8.0;
const SCRUB_RAMP_SEC: f64 = 0.006;
const MASTER_TEMPO_PULL_FRAMES: usize = 4096;
const BAND_LOW_SPLIT_HZ: f64 = 360.0;
const BAND_HIGH_SPLIT_HZ: f64 = 2600.0;
const BAND_REDUCED_GAIN: f32 = 0.12;

pub(super) struct DeckMasterTempoState {
  processor: Option<R3MasterTempoProcessor>,
  channels: usize,
  processor_sample_rate: u32,
  source_frame_cursor: f64,
  playhead_source_frame: f64,
  output_buffer: Vec<f32>,
  output_offset: usize,
  staging_input: Vec<f32>,
  staging_output: Vec<f32>,
  flushed: bool,
}

impl Default for DeckMasterTempoState {
  fn default() -> Self {
    Self {
      processor: None,
      channels: 2,
      processor_sample_rate: 0,
      source_frame_cursor: 0.0,
      playhead_source_frame: 0.0,
      output_buffer: Vec::new(),
      output_offset: 0,
      staging_input: Vec::new(),
      staging_output: Vec::new(),
      flushed: false,
    }
  }
}

fn clamp_rate(value: f64) -> f64 {
  if value.is_finite() && value > 0.0 {
    value.clamp(MIN_RATE, MAX_RATE)
  } else {
    1.0
  }
}

fn clamp_scrub_rate(value: f64) -> f64 {
  if value.is_finite() {
    value.clamp(-SCRUB_MAX_RATE, SCRUB_MAX_RATE)
  } else {
    0.0
  }
}

fn resolved_channels(target: &DeckState) -> usize {
  target.channels.max(1).min(2) as usize
}

fn resolved_output_sample_rate(output_sample_rate: f64, source_sample_rate: u32) -> u32 {
  if output_sample_rate.is_finite() && output_sample_rate >= 1.0 {
    output_sample_rate.round().clamp(1.0, u32::MAX as f64) as u32
  } else {
    source_sample_rate.max(1)
  }
}

pub(super) fn should_use_master_tempo(target: &DeckState) -> bool {
  if !target.master_tempo_enabled
    || target.pcm_data.is_empty()
    || target.sample_rate == 0
    || target.channels == 0
  {
    return false;
  }
  // 已经在拉伸时划过原速不要关掉处理器，避免 BPM 拖动经过 1.0 时咔一声。
  (target.playback_rate - 1.0).abs() > 0.0001 || target.master_tempo_state.processor.is_some()
}

fn configure_processor(target: &mut DeckState, output_sample_rate: f64) {
  let channels = resolved_channels(target);
  if target.sample_rate == 0 {
    target.master_tempo_state.processor = None;
    target.master_tempo_state.processor_sample_rate = 0;
    return;
  }
  let processor_sample_rate = resolved_output_sample_rate(output_sample_rate, target.sample_rate);
  let processor = R3MasterTempoProcessor::new(
    channels as u32,
    processor_sample_rate,
    clamp_rate(target.playback_rate),
  );
  target.master_tempo_state.channels = channels;
  target.master_tempo_state.processor_sample_rate = processor_sample_rate;
  target.master_tempo_state.processor = processor;
  target.master_tempo_state.output_buffer.clear();
  target.master_tempo_state.output_offset = 0;
  target.master_tempo_state.flushed = false;
  target
    .master_tempo_state
    .staging_output
    .resize(channels * MASTER_TEMPO_PULL_FRAMES, 0.0);
}

pub(super) fn reset_master_tempo_state(target: &mut DeckState) {
  let audio_current_sec =
    super::HorizontalBrowseTransportEngine::timeline_sec_to_audio_sec(target, target.current_sec);
  target.master_tempo_state.source_frame_cursor =
    (audio_current_sec - target.pcm_start_sec).max(0.0) * target.sample_rate as f64;
  target.master_tempo_state.playhead_source_frame =
    ((audio_current_sec - target.pcm_start_sec).max(0.0)) * target.sample_rate as f64;
  target.master_tempo_state.output_buffer.clear();
  target.master_tempo_state.output_offset = 0;
  target.master_tempo_state.flushed = false;
  if let Some(processor) = target.master_tempo_state.processor.as_mut() {
    processor.reset(clamp_rate(target.playback_rate));
  }
}

pub(super) fn clear_master_tempo_state(target: &mut DeckState) {
  target.master_tempo_state.processor = None;
  target.master_tempo_state.processor_sample_rate = 0;
  target.master_tempo_state.output_buffer.clear();
  target.master_tempo_state.output_offset = 0;
  target.master_tempo_state.staging_input.clear();
  target.master_tempo_state.flushed = false;
}

fn normalized_path(value: &Option<String>) -> &str {
  value.as_deref().map(str::trim).unwrap_or("")
}

fn has_full_track_pcm(target: &DeckState) -> bool {
  let file_path = normalized_path(&target.file_path);
  !file_path.is_empty()
    && normalized_path(&target.loaded_file_path) == file_path
    && normalized_path(&target.fully_decoded_file_path) == file_path
    && target.pcm_start_sec <= 0.0001
    && !target.pcm_data.is_empty()
    && target.sample_rate > 0
    && target.channels > 0
}

fn decoded_pcm_frame_count(target: &DeckState) -> Option<usize> {
  if target.sample_rate == 0 || target.channels == 0 {
    return None;
  }
  let frame_count = target.pcm_data.len() / target.channels as usize;
  if frame_count == 0 {
    return None;
  }
  Some(frame_count)
}

fn decoded_pcm_end_timeline_sec(target: &DeckState) -> Option<f64> {
  let frame_count = decoded_pcm_frame_count(target)?;
  let audio_end_sec = target.pcm_start_sec + frame_count as f64 / target.sample_rate as f64;
  let timeline_end_sec =
    super::HorizontalBrowseTransportEngine::audio_sec_to_timeline_sec(target, audio_end_sec);
  timeline_end_sec.is_finite().then_some(timeline_end_sec)
}

fn master_tempo_source_exhausted(target: &DeckState) -> bool {
  let Some(frame_count) = decoded_pcm_frame_count(target) else {
    return false;
  };
  target.master_tempo_state.flushed
    && target.master_tempo_state.source_frame_cursor + 0.0001 >= frame_count as f64
}

fn finish_deck_at_decoded_pcm_end(target: &mut DeckState) -> bool {
  if !has_full_track_pcm(target) {
    return false;
  }
  let Some(decoded_end_sec) = decoded_pcm_end_timeline_sec(target) else {
    return false;
  };
  let stop_sec = if target.duration_sec.is_finite() && target.duration_sec > 0.0 {
    decoded_end_sec.min(target.duration_sec)
  } else {
    decoded_end_sec
  };
  target.current_sec = stop_sec;
  target.last_observed_at_ms = -1.0;
  // Keep the user's play intent so seeking away from the tail resumes playback.
  target.scrub_preview.active = false;
  target.scrub_preview.rate = 0.0;
  clear_master_tempo_state(target);
  true
}

pub(super) fn reset_band_filter_state(target: &mut DeckState) {
  target.band_filter_state = Default::default();
}

fn one_pole_alpha(cutoff_hz: f64, output_sample_rate: f64) -> f32 {
  if !cutoff_hz.is_finite() || cutoff_hz <= 0.0 || output_sample_rate <= 0.0 {
    return 1.0;
  }
  (1.0 - (-std::f64::consts::TAU * cutoff_hz / output_sample_rate).exp()).clamp(0.0, 1.0) as f32
}

fn low_pass_sample(previous: &mut f32, input: f32, alpha: f32) -> f32 {
  *previous += alpha * (input - *previous);
  *previous
}

pub(super) fn apply_band_filter(
  target: &mut DeckState,
  left: f32,
  right: f32,
  output_sample_rate: f64,
) -> (f32, f32) {
  if !output_sample_rate.is_finite() || output_sample_rate <= 0.0 {
    return (left, right);
  }

  if !target.band_filter_state.initialized {
    target.band_filter_state.low_split.left = left;
    target.band_filter_state.low_split.right = right;
    target.band_filter_state.high_split.left = left;
    target.band_filter_state.high_split.right = right;
    target.band_filter_state.initialized = true;
  }

  let low_alpha = one_pole_alpha(BAND_LOW_SPLIT_HZ, output_sample_rate);
  let high_alpha = one_pole_alpha(BAND_HIGH_SPLIT_HZ, output_sample_rate);
  let low_left = low_pass_sample(
    &mut target.band_filter_state.low_split.left,
    left,
    low_alpha,
  );
  let low_right = low_pass_sample(
    &mut target.band_filter_state.low_split.right,
    right,
    low_alpha,
  );
  let low_mid_left = low_pass_sample(
    &mut target.band_filter_state.high_split.left,
    left,
    high_alpha,
  );
  let low_mid_right = low_pass_sample(
    &mut target.band_filter_state.high_split.right,
    right,
    high_alpha,
  );
  let mid_left = low_mid_left - low_left;
  let mid_right = low_mid_right - low_right;
  let high_left = left - low_mid_left;
  let high_right = right - low_mid_right;

  let low_gain = if target.band_state.low { 1.0 } else { 0.0 };
  let mid_gain = if target.band_state.mid {
    1.0
  } else {
    BAND_REDUCED_GAIN
  };
  let high_gain = if target.band_state.high {
    1.0
  } else {
    BAND_REDUCED_GAIN
  };
  (
    low_left * low_gain + mid_left * mid_gain + high_left * high_gain,
    low_right * low_gain + mid_right * mid_gain + high_right * high_gain,
  )
}

fn ensure_processor_configured(target: &mut DeckState, output_sample_rate: f64) {
  let channels = resolved_channels(target);
  let processor_sample_rate = resolved_output_sample_rate(output_sample_rate, target.sample_rate);
  let already_configured = target.master_tempo_state.processor.is_some()
    && target.master_tempo_state.channels == channels
    && target.master_tempo_state.processor_sample_rate == processor_sample_rate;
  if already_configured {
    if let Some(processor) = target.master_tempo_state.processor.as_mut() {
      processor.set_tempo(clamp_rate(target.playback_rate));
    }
    return;
  }
  configure_processor(target, output_sample_rate);
}

fn read_source_sample(
  source_data: &[f32],
  frame_count: usize,
  source_channels: usize,
  source_frame: f64,
  channel: usize,
) -> f32 {
  if frame_count == 0 || source_channels == 0 {
    return 0.0;
  }
  let base_index = source_frame.floor().max(0.0) as usize;
  if base_index >= frame_count {
    return 0.0;
  }
  let next_index = (base_index + 1).min(frame_count - 1);
  let frac = (source_frame - base_index as f64).clamp(0.0, 1.0) as f32;
  let source_channel = channel.min(source_channels - 1);
  let left = source_data
    .get(base_index * source_channels + source_channel)
    .copied()
    .unwrap_or(0.0);
  let right = source_data
    .get(next_index * source_channels + source_channel)
    .copied()
    .unwrap_or(left);
  left + (right - left) * frac
}

fn sample_silent_lead_in(target: &mut DeckState, output_sample_rate: f64) -> bool {
  if !target.current_sec.is_finite() {
    target.current_sec = 0.0;
    return false;
  }
  let pcm_start_timeline_sec =
    super::HorizontalBrowseTransportEngine::audio_sec_to_timeline_sec(target, target.pcm_start_sec);
  if target.current_sec >= pcm_start_timeline_sec {
    return false;
  }
  target.current_sec += clamp_rate(target.playback_rate) / output_sample_rate.max(1.0);
  target.last_observed_at_ms = -1.0;
  if target.current_sec >= pcm_start_timeline_sec {
    reset_master_tempo_state(target);
  }
  true
}

pub(super) fn is_scrub_preview_rendering(target: &DeckState) -> bool {
  (target.scrub_preview.active && target.scrub_preview.rate.abs() >= SCRUB_MIN_RATE)
    || target.scrub_preview.level > 0.0001
}

fn append_source_chunk(target: &mut DeckState, output_sample_rate: f64) -> bool {
  let frames_required = target
    .master_tempo_state
    .processor
    .as_ref()
    .map(R3MasterTempoProcessor::input_frames_required)
    .unwrap_or(0);
  if frames_required == 0 {
    return false;
  }
  let channels = target.master_tempo_state.channels.max(1);
  let frame_count = target.pcm_data.len() / target.channels.max(1) as usize;
  let start_frame = target.master_tempo_state.source_frame_cursor.max(0.0);
  if start_frame >= frame_count as f64 {
    return false;
  }
  let source_step = target.sample_rate as f64 / output_sample_rate.max(1.0);
  let remaining_output_frames = ((frame_count as f64 - start_frame) / source_step.max(0.000001))
    .ceil()
    .max(0.0) as usize;
  let frames_to_feed = frames_required.min(remaining_output_frames);
  if frames_to_feed == 0 {
    return false;
  }
  target
    .master_tempo_state
    .staging_input
    .resize(frames_to_feed * channels, 0.0);

  let source_channels = target.channels.max(1) as usize;
  let pcm_data = target.pcm_data.as_ref().as_slice();
  for frame_offset in 0..frames_to_feed {
    let source_frame = start_frame + frame_offset as f64 * source_step;
    for channel in 0..channels {
      let sample = read_source_sample(
        pcm_data,
        frame_count,
        source_channels,
        source_frame,
        channel,
      );
      target.master_tempo_state.staging_input[frame_offset * channels + channel] = sample;
    }
  }

  if let Some(processor) = target.master_tempo_state.processor.as_mut() {
    processor.set_tempo(clamp_rate(target.playback_rate));
    if !processor.process_interleaved(&target.master_tempo_state.staging_input, frames_to_feed) {
      return false;
    }
  }
  target.master_tempo_state.source_frame_cursor =
    (start_frame + frames_to_feed as f64 * source_step).min(frame_count as f64);
  true
}

fn pull_processed_output(target: &mut DeckState) -> usize {
  let channels = target.master_tempo_state.channels.max(1);
  let Some(processor) = target.master_tempo_state.processor.as_mut() else {
    return 0;
  };
  processor.set_tempo(clamp_rate(target.playback_rate));
  let received = processor.retrieve_interleaved(
    target.master_tempo_state.staging_output.as_mut_slice(),
    MASTER_TEMPO_PULL_FRAMES,
  );
  if received > 0 {
    let sample_count = received * channels;
    target
      .master_tempo_state
      .output_buffer
      .extend_from_slice(&target.master_tempo_state.staging_output[..sample_count]);
  }
  received
}

fn ensure_output_samples(target: &mut DeckState, output_sample_rate: f64) {
  let channels = target.master_tempo_state.channels.max(1);
  loop {
    let available_frames = (target.master_tempo_state.output_buffer.len()
      - target.master_tempo_state.output_offset)
      / channels;
    if available_frames > 0 {
      return;
    }

    if pull_processed_output(target) > 0 {
      continue;
    }

    if append_source_chunk(target, output_sample_rate) {
      continue;
    }

    if !target.master_tempo_state.flushed {
      if let Some(processor) = target.master_tempo_state.processor.as_mut() {
        processor.finish();
      }
      target.master_tempo_state.flushed = true;
      continue;
    }

    return;
  }
}

pub(super) fn prime_master_tempo_state(target: &mut DeckState, output_sample_rate: f64) {
  if !should_use_master_tempo(target) {
    return;
  }
  ensure_processor_configured(target, output_sample_rate);
  if target.master_tempo_state.processor.is_none() {
    return;
  }
  ensure_output_samples(target, output_sample_rate);
}

fn sample_deck_rate(target: &mut DeckState, output_sample_rate: f64) -> (f32, f32) {
  let frame_count = target.pcm_data.len() / target.channels as usize;
  if frame_count == 0 {
    return (0.0, 0.0);
  }
  let audio_current_sec =
    super::HorizontalBrowseTransportEngine::timeline_sec_to_audio_sec(target, target.current_sec);
  let source_frame =
    ((audio_current_sec - target.pcm_start_sec).max(0.0)) * target.sample_rate as f64;
  let base_index = source_frame.floor() as usize;
  if base_index >= frame_count {
    finish_deck_at_decoded_pcm_end(target);
    return (0.0, 0.0);
  }
  let frac = (source_frame - base_index as f64) as f32;
  let next_index = (base_index + 1).min(frame_count - 1);
  let channels = target.channels as usize;
  let read_sample = |frame_index: usize, channel: usize, data: &[f32]| -> f32 {
    data
      .get(frame_index * channels + channel.min(channels - 1))
      .copied()
      .unwrap_or(0.0)
  };
  let pcm_data = target.pcm_data.as_ref().as_slice();
  let l0 = read_sample(base_index, 0, pcm_data);
  let l1 = read_sample(next_index, 0, pcm_data);
  let r0 = read_sample(base_index, if channels > 1 { 1 } else { 0 }, pcm_data);
  let r1 = read_sample(next_index, if channels > 1 { 1 } else { 0 }, pcm_data);
  let left = l0 + (l1 - l0) * frac;
  let right = r0 + (r1 - r0) * frac;

  let rate = clamp_rate(target.playback_rate);
  target.current_sec += rate / output_sample_rate;
  target.last_observed_at_ms = -1.0;
  if target.loop_active
    && target.loop_end_sec - target.loop_start_sec > 0.0001
    && (target.current_sec >= target.loop_end_sec - 0.0005
      || target.current_sec < target.loop_start_sec - 0.0001)
  {
    target.current_sec = target.loop_start_sec;
    reset_master_tempo_state(target);
  }
  if let Some(decoded_end_sec) = decoded_pcm_end_timeline_sec(target) {
    if target.current_sec >= decoded_end_sec && finish_deck_at_decoded_pcm_end(target) {
      return (left, right);
    }
  }
  if target.duration_sec.is_finite() && target.current_sec >= target.duration_sec {
    target.current_sec = target.duration_sec;
    clear_master_tempo_state(target);
  }
  (left, right)
}

fn sample_deck_scrub_preview(target: &mut DeckState, output_sample_rate: f64) -> (f32, f32) {
  let output_sample_rate = output_sample_rate.max(1.0);
  if target.pcm_data.is_empty() || target.sample_rate == 0 || target.channels == 0 {
    target.scrub_preview.level = 0.0;
    target.scrub_preview.rate = 0.0;
    return (0.0, 0.0);
  }

  let target_level =
    if target.scrub_preview.active && target.scrub_preview.rate.abs() >= SCRUB_MIN_RATE {
      1.0
    } else {
      0.0
    };
  let step = (1.0 / (SCRUB_RAMP_SEC * output_sample_rate)) as f32;
  if target.scrub_preview.level < target_level {
    target.scrub_preview.level = (target.scrub_preview.level + step).min(target_level);
  } else if target.scrub_preview.level > target_level {
    target.scrub_preview.level = (target.scrub_preview.level - step).max(target_level);
  }

  if target.scrub_preview.level <= 0.0001 {
    return (0.0, 0.0);
  }

  if target.scrub_preview.current_sec < 0.0 {
    target.scrub_preview.current_sec +=
      clamp_scrub_rate(target.scrub_preview.rate) / output_sample_rate;
    return (0.0, 0.0);
  }

  let frame_count = target.pcm_data.len() / target.channels as usize;
  if frame_count == 0 {
    return (0.0, 0.0);
  }
  let audio_current_sec = super::HorizontalBrowseTransportEngine::timeline_sec_to_audio_sec(
    target,
    target.scrub_preview.current_sec,
  );
  let source_frame =
    ((audio_current_sec - target.pcm_start_sec).max(0.0)) * target.sample_rate as f64;
  let base_index = source_frame.floor() as usize;
  if base_index >= frame_count {
    target.scrub_preview.rate = 0.0;
    return (0.0, 0.0);
  }

  let frac = (source_frame - base_index as f64) as f32;
  let next_index = (base_index + 1).min(frame_count - 1);
  let channels = target.channels as usize;
  let pcm_data = target.pcm_data.as_ref().as_slice();
  let read_sample = |frame_index: usize, channel: usize| -> f32 {
    pcm_data
      .get(frame_index * channels + channel.min(channels - 1))
      .copied()
      .unwrap_or(0.0)
  };
  let l0 = read_sample(base_index, 0);
  let l1 = read_sample(next_index, 0);
  let r0 = read_sample(base_index, if channels > 1 { 1 } else { 0 });
  let r1 = read_sample(next_index, if channels > 1 { 1 } else { 0 });
  let left = l0 + (l1 - l0) * frac;
  let right = r0 + (r1 - r0) * frac;

  let rate = clamp_scrub_rate(target.scrub_preview.rate);
  target.scrub_preview.current_sec += rate / output_sample_rate;
  target.scrub_preview.current_sec = if target.duration_sec.is_finite() && target.duration_sec > 0.0
  {
    target.scrub_preview.current_sec.min(target.duration_sec)
  } else {
    target.scrub_preview.current_sec
  };

  let gain = target.scrub_preview.level;
  (left * gain, right * gain)
}

fn sample_deck_master_tempo(target: &mut DeckState, output_sample_rate: f64) -> (f32, f32) {
  if target.master_tempo_state.processor.is_none() {
    reset_master_tempo_state(target);
  }
  prime_master_tempo_state(target, output_sample_rate);

  let channels = target.master_tempo_state.channels.max(1);
  let available_frames = (target.master_tempo_state.output_buffer.len()
    - target.master_tempo_state.output_offset)
    / channels;
  if available_frames == 0 {
    if master_tempo_source_exhausted(target) {
      finish_deck_at_decoded_pcm_end(target);
    }
    return (0.0, 0.0);
  }

  let base = target.master_tempo_state.output_offset;
  let left = target
    .master_tempo_state
    .output_buffer
    .get(base)
    .copied()
    .unwrap_or(0.0);
  let right = target
    .master_tempo_state
    .output_buffer
    .get(base + if channels > 1 { 1 } else { 0 })
    .copied()
    .unwrap_or(left);
  target.master_tempo_state.output_offset += channels;
  if target.master_tempo_state.output_offset >= target.master_tempo_state.output_buffer.len() {
    target.master_tempo_state.output_buffer.clear();
    target.master_tempo_state.output_offset = 0;
  } else if target.master_tempo_state.output_offset > channels * MASTER_TEMPO_PULL_FRAMES {
    target
      .master_tempo_state
      .output_buffer
      .drain(..target.master_tempo_state.output_offset);
    target.master_tempo_state.output_offset = 0;
  }

  target.master_tempo_state.playhead_source_frame +=
    clamp_rate(target.playback_rate) * target.sample_rate as f64 / output_sample_rate.max(1.0);
  let audio_sec = target.pcm_start_sec
    + target.master_tempo_state.playhead_source_frame / target.sample_rate as f64;
  target.current_sec =
    super::HorizontalBrowseTransportEngine::audio_sec_to_timeline_sec(target, audio_sec);
  target.last_observed_at_ms = -1.0;
  if target.loop_active
    && target.loop_end_sec - target.loop_start_sec > 0.0001
    && (target.current_sec >= target.loop_end_sec - 0.0005
      || target.current_sec < target.loop_start_sec - 0.0001)
  {
    target.current_sec = target.loop_start_sec;
    reset_master_tempo_state(target);
  }

  if target.duration_sec.is_finite() && target.current_sec >= target.duration_sec {
    target.current_sec = target.duration_sec;
    clear_master_tempo_state(target);
  }

  (left, right)
}

pub(super) fn sample_deck(target: &mut DeckState, output_sample_rate: f64) -> (f32, f32) {
  if is_scrub_preview_rendering(target) {
    return sample_deck_scrub_preview(target, output_sample_rate);
  }
  if !target.playing
    || target.pcm_data.is_empty()
    || target.sample_rate == 0
    || target.channels == 0
  {
    return (0.0, 0.0);
  }
  if let Some(end_sec) = super::HorizontalBrowseTransportEngine::effective_track_end_sec(target) {
    if target.current_sec >= end_sec {
      target.current_sec = end_sec;
      target.last_observed_at_ms = -1.0;
      return (0.0, 0.0);
    }
  }
  if sample_silent_lead_in(target, output_sample_rate) {
    return (0.0, 0.0);
  }
  if should_use_master_tempo(target) {
    return sample_deck_master_tempo(target, output_sample_rate);
  }
  sample_deck_rate(target, output_sample_rate)
}
