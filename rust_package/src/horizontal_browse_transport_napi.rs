use super::*;

#[napi]
pub fn horizontal_browse_transport_reset() {
  engine().lock().reset_preserving_output_config();
}

#[napi]
pub fn horizontal_browse_transport_set_deck_state(
  deck: String,
  now_ms: Option<f64>,
  payload: HorizontalBrowseTransportDeckInput,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let deck_playing = payload.playing;
  let mut engine_guard = engine().lock();
  engine_guard.observe_external_now_ms(now_ms.unwrap_or(payload.last_observed_at_ms));
  let apply_now_ms = engine_guard.last_now_ms;
  let file_changed = engine_guard.deck_file_will_change(deck_id, &payload.file_path);
  engine_guard.apply_external_deck_state(deck_id, apply_now_ms, payload);
  if file_changed {
    engine_guard.reset_deck_auto_gain_for_file_change(deck_id);
  }
  engine_guard.mark_state_changed();
  let decode_request = engine_guard.prepare_decode_request(deck_id);
  let full_decode_request = engine_guard.prepare_full_decode_request(deck_id);
  let _ = engine_guard.ensure_output_stream();
  engine_guard.refresh();
  engine_guard.refresh_auto_gain();
  drop(engine_guard);
  if let Some(request) = decode_request {
    if deck_playing {
      execute_decode_request_sync(request);
    } else {
      schedule_decode_request(request);
    }
  }
  if let Some(request) = full_decode_request {
    schedule_decode_request(request);
  }
  let engine_guard = engine().lock();
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_state(
  payload: HorizontalBrowseTransportStateInput,
) -> HorizontalBrowseTransportSnapshot {
  let top_playing = payload.top.playing;
  let bottom_playing = payload.bottom.playing;
  let allow_phase_alignment = payload.allow_phase_alignment.unwrap_or(true);
  let now_ms = payload.now_ms.unwrap_or(
    payload
      .top
      .last_observed_at_ms
      .max(payload.bottom.last_observed_at_ms),
  );
  let mut engine_guard = engine().lock();
  engine_guard.observe_external_now_ms(now_ms);
  let apply_now_ms = engine_guard.last_now_ms;
  let top_file_changed = engine_guard.deck_file_will_change(DeckId::Top, &payload.top.file_path);
  let bottom_file_changed =
    engine_guard.deck_file_will_change(DeckId::Bottom, &payload.bottom.file_path);
  engine_guard.apply_external_deck_state(DeckId::Top, apply_now_ms, payload.top);
  engine_guard.apply_external_deck_state(DeckId::Bottom, apply_now_ms, payload.bottom);
  if top_file_changed {
    engine_guard.reset_deck_auto_gain_for_file_change(DeckId::Top);
  }
  if bottom_file_changed {
    engine_guard.reset_deck_auto_gain_for_file_change(DeckId::Bottom);
  }
  engine_guard.mark_state_changed();
  let top_decode_request = engine_guard.prepare_decode_request(DeckId::Top);
  let bottom_decode_request = engine_guard.prepare_decode_request(DeckId::Bottom);
  let top_full_decode_request = engine_guard.prepare_full_decode_request(DeckId::Top);
  let bottom_full_decode_request = engine_guard.prepare_full_decode_request(DeckId::Bottom);
  let _ = engine_guard.ensure_output_stream();
  engine_guard.refresh_sync_state(allow_phase_alignment);
  engine_guard.refresh_auto_gain();
  drop(engine_guard);
  if let Some(request) = top_decode_request {
    if top_playing {
      execute_decode_request_sync(request);
    } else {
      schedule_decode_request(request);
    }
  }
  if let Some(request) = bottom_decode_request {
    if bottom_playing {
      execute_decode_request_sync(request);
    } else {
      schedule_decode_request(request);
    }
  }
  if let Some(request) = top_full_decode_request {
    schedule_decode_request(request);
  }
  if let Some(request) = bottom_full_decode_request {
    schedule_decode_request(request);
  }
  let engine_guard = engine().lock();
  engine_guard.snapshot(engine_guard.last_now_ms)
}

#[napi]
pub fn horizontal_browse_transport_set_playback_rate(
  deck: String,
  now_ms: f64,
  playback_rate: f64,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  engine_guard.observe_external_now_ms(now_ms);
  engine_guard.set_playback_rate(deck_id, now_ms, playback_rate);
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_tempo_nudge_playback_rate(
  deck: String,
  now_ms: f64,
  playback_rate: f64,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  engine_guard.observe_external_now_ms(now_ms);
  engine_guard.set_tempo_nudge_playback_rate(deck_id, now_ms, playback_rate);
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_master_tempo_enabled(
  deck: String,
  now_ms: f64,
  enabled: bool,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  engine_guard.observe_external_now_ms(now_ms);
  engine_guard.set_master_tempo_enabled(deck_id, now_ms, enabled);
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_beat_grid(
  deck: String,
  now_ms: Option<f64>,
  payload: HorizontalBrowseTransportBeatGridInput,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  if let Some(next_now_ms) = now_ms.filter(|value| value.is_finite() && *value >= 0.0) {
    engine_guard.observe_external_now_ms(next_now_ms);
  }

  if let Some(expected_file_path) = payload.file_path.as_deref().map(str::trim) {
    if !expected_file_path.is_empty() {
      let current_file_path = engine_guard
        .deck(deck_id)
        .file_path
        .as_deref()
        .map(str::trim)
        .unwrap_or("");
      if current_file_path != expected_file_path {
        return Ok(engine_guard.snapshot(engine_guard.last_now_ms));
      }
    }
  }

  let next_bpm = payload
    .bpm
    .filter(|value| value.is_finite() && *value > 0.0);
  let next_first_beat_ms = payload
    .first_beat_ms
    .filter(|value| value.is_finite() && *value >= 0.0);
  let next_downbeat_beat_offset = payload
    .downbeat_beat_offset
    .filter(|value| value.is_finite());
  let next_beat_grid_clips = payload.beat_grid_clips;
  let has_beat_grid_clips = next_beat_grid_clips.is_some();
  let next_rekordbox_beat_grid_entries = payload.rekordbox_beat_grid_entries;
  let has_rekordbox_beat_grid_entries = next_rekordbox_beat_grid_entries.is_some();
  let next_time_basis_offset_ms = payload
    .time_basis_offset_ms
    .filter(|value| value.is_finite() && *value >= 0.0);
  if next_bpm.is_none()
    && next_first_beat_ms.is_none()
    && next_downbeat_beat_offset.is_none()
    && !has_beat_grid_clips
    && !has_rekordbox_beat_grid_entries
    && next_time_basis_offset_ms.is_none()
  {
    return Ok(engine_guard.snapshot(engine_guard.last_now_ms));
  }
  engine_guard.set_beat_grid(
    deck_id,
    next_bpm,
    next_first_beat_ms,
    next_downbeat_beat_offset,
    next_beat_grid_clips,
    next_rekordbox_beat_grid_entries,
    next_time_basis_offset_ms,
  );
  let deck_playing = engine_guard.deck(deck_id).playing;
  let decode_request = engine_guard.prepare_decode_request(deck_id);
  drop(engine_guard);
  if let Some(request) = decode_request {
    if deck_playing {
      execute_decode_request_sync(request);
    } else {
      schedule_decode_request(request);
    }
  }
  let engine_guard = engine().lock();
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_sync_enabled(
  deck: String,
  now_ms: Option<f64>,
  enabled: bool,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine = engine().lock();
  if let Some(next_now_ms) = now_ms {
    engine.observe_external_now_ms(next_now_ms);
  }
  engine.set_sync_enabled(deck_id, enabled);
  engine.refresh_auto_gain();
  Ok(engine.snapshot(engine.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_beatsync(
  deck: String,
  now_ms: Option<f64>,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine = engine().lock();
  if let Some(next_now_ms) = now_ms {
    engine.observe_external_now_ms(next_now_ms);
  }
  engine.beatsync(deck_id);
  engine.refresh_auto_gain();
  Ok(engine.snapshot(engine.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_align_to_leader(
  deck: String,
  now_ms: Option<f64>,
  target_sec: Option<f64>,
  skip_grid_snap: Option<bool>,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  if let Some(next_now_ms) = now_ms {
    engine_guard.observe_external_now_ms(next_now_ms);
  }
  engine_guard.align_to_leader(deck_id, target_sec, skip_grid_snap.unwrap_or(false));
  engine_guard.refresh_auto_gain();
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_leader(
  deck: Option<String>,
  now_ms: Option<f64>,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let next_leader = match deck {
    Some(value) => Some(parse_deck_id(&value)?),
    None => None,
  };
  let mut engine = engine().lock();
  if let Some(next_now_ms) = now_ms {
    engine.observe_external_now_ms(next_now_ms);
  }
  engine.set_leader(next_leader);
  engine.refresh_auto_gain();
  Ok(engine.snapshot(engine.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_band_state(
  deck: String,
  bands: HorizontalBrowseTransportBandState,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine = engine().lock();
  engine.set_band_state(deck_id, bands);
  Ok(engine.snapshot(engine.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_cue_monitor_enabled(
  deck: String,
  enabled: bool,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine = engine().lock();
  engine.set_cue_monitor_enabled(deck_id, enabled);
  Ok(engine.snapshot(engine.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_playing(
  deck: String,
  now_ms: f64,
  playing: bool,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  engine_guard.observe_external_now_ms(now_ms);
  let _ = engine_guard.ensure_output_stream();
  engine_guard.set_playing(deck_id, now_ms, playing);
  engine_guard.refresh_auto_gain();
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_audition_suspended(
  now_ms: f64,
  suspended: bool,
) -> HorizontalBrowseTransportSnapshot {
  let mut engine_guard = engine().lock();
  engine_guard.observe_external_now_ms(now_ms);
  let apply_now_ms = engine_guard.last_now_ms;
  engine_guard.set_audition_suspended(apply_now_ms, suspended);
  engine_guard.snapshot(engine_guard.last_now_ms)
}

#[napi]
pub fn horizontal_browse_transport_prepare_playhead(
  deck: String,
  now_ms: f64,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  engine_guard.observe_external_now_ms(now_ms);
  let _ = engine_guard.ensure_output_stream();
  let decode_request = engine_guard.prepare_playhead_decode_request(deck_id);
  engine_guard.refresh();
  engine_guard.refresh_auto_gain();
  drop(engine_guard);
  if let Some(request) = decode_request {
    execute_decode_request_sync(request);
  }
  let engine_guard = engine().lock();
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_seek(
  deck: String,
  now_ms: f64,
  current_sec: f64,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  engine_guard.observe_external_now_ms(now_ms);
  engine_guard.seek(deck_id, now_ms, current_sec);
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_scrub_preview(
  deck: String,
  now_ms: f64,
  active: bool,
  current_sec: f64,
  rate: f64,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  engine_guard.observe_external_now_ms(now_ms);
  let _ = engine_guard.ensure_output_stream();
  engine_guard.set_scrub_preview(deck_id, now_ms, active, current_sec, rate);
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_metronome(
  deck: String,
  enabled: bool,
  volume_level: u32,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  engine_guard.set_metronome(deck_id, enabled, volume_level.clamp(1, 3) as u8);
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_toggle_loop(
  deck: String,
  now_ms: f64,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  engine_guard.observe_external_now_ms(now_ms);
  engine_guard.toggle_loop(deck_id, now_ms);
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_step_loop_beats(
  deck: String,
  now_ms: f64,
  direction: i32,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  engine_guard.observe_external_now_ms(now_ms);
  engine_guard.step_loop_beats_command(deck_id, direction.signum(), now_ms);
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_loop_from_range(
  deck: String,
  start_sec: f64,
  end_sec: f64,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  engine_guard.set_loop_from_range_command(deck_id, start_sec, end_sec);
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_clear_loop(
  deck: String,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  engine_guard.clear_loop(deck_id);
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_gain(
  deck: String,
  gain: f64,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine = engine().lock();
  engine.mark_state_changed();
  engine.trim_gain[HorizontalBrowseTransportEngine::deck_index(deck_id)] =
    HorizontalBrowseTransportEngine::clamp_unit_gain(gain);
  engine.refresh_output_gains();
  Ok(engine.snapshot(engine.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_auto_gain_enabled(
  deck: String,
  enabled: bool,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine = engine().lock();
  engine.set_auto_gain_enabled(deck_id, enabled);
  Ok(engine.snapshot(engine.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_output_state(
  crossfader_value: f64,
  master_gain: f64,
) -> HorizontalBrowseTransportSnapshot {
  let mut engine = engine().lock();
  engine.set_output_state(crossfader_value, master_gain);
  engine.snapshot(engine.last_now_ms)
}

#[napi]
pub fn horizontal_browse_transport_start_recording(
  file_path: String,
) -> napi::Result<HorizontalBrowseTransportRecordingStatus> {
  let mut engine_guard = engine().lock();
  let _ = engine_guard.ensure_output_stream();
  engine_guard.recording.start(file_path)
}

#[napi]
pub fn horizontal_browse_transport_stop_recording() -> HorizontalBrowseTransportRecordingStatus {
  let mut engine_guard = engine().lock();
  engine_guard.recording.stop()
}

#[napi]
pub fn horizontal_browse_transport_recording_snapshot() -> HorizontalBrowseTransportRecordingStatus
{
  let engine_guard = engine().lock();
  engine_guard.recording.snapshot()
}

#[napi]
pub fn horizontal_browse_transport_snapshot(
  now_ms: Option<f64>,
) -> HorizontalBrowseTransportSnapshot {
  let engine = engine().lock();
  let snapshot_now_ms = now_ms
    .filter(|value| value.is_finite() && *value >= 0.0)
    .unwrap_or_else(|| engine.current_external_now_ms());
  engine.snapshot(snapshot_now_ms)
}

#[napi]
pub fn horizontal_browse_transport_visualizer_snapshot(
) -> HorizontalBrowseTransportVisualizerSnapshot {
  let engine = engine().lock();
  engine.visualizer_snapshot()
}

#[napi]
pub fn horizontal_browse_transport_drain_decode_diagnostics(
) -> Vec<HorizontalBrowseTransportDecodeDiagnostic> {
  drain_decode_diagnostics()
}

#[napi]
pub fn process_r3_master_tempo_offline(
  pcm_data: Buffer,
  sample_rate: u32,
  channels: u32,
  tempo: f64,
  mode: Option<String>,
) -> napi::Result<R3MasterTempoOfflineResult> {
  let mode = mode.unwrap_or_else(|| "r3-mw".to_owned());
  horizontal_browse_transport_master_tempo_offline::process_r3_master_tempo_offline(
    pcm_data.as_ref(),
    sample_rate,
    channels,
    tempo,
    &mode,
  )
}
