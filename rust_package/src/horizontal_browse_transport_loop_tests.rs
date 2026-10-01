use super::*;

fn loop_engine() -> HorizontalBrowseTransportEngine {
  let mut engine = HorizontalBrowseTransportEngine::default();
  let top = engine.deck_mut(DeckId::Top);
  top.bpm = Some(120.0);
  top.first_beat_ms = Some(0.0);
  top.duration_sec = 20.0;
  engine
}

#[test]
fn exact_loop_keeps_supplied_start_and_end_through_grid_refresh() {
  let mut engine = loop_engine();
  assert!(engine.set_loop_from_range(DeckId::Top, 1.23, 5.23, true));
  engine.top.first_beat_ms = Some(100.0);
  engine.top.bpm = Some(128.0);
  assert!(engine.sync_loop_range_for_deck(DeckId::Top));
  assert_eq!(engine.top.loop_start_sec, 1.23);
  assert_eq!(engine.top.loop_end_sec, 5.23);
}

#[test]
fn quantized_loop_keeps_existing_grid_alignment() {
  let mut engine = loop_engine();
  assert!(engine.set_loop_from_range(DeckId::Top, 1.23, 5.23, false));
  assert_eq!(engine.top.loop_start_sec, 1.0);
  assert_eq!(engine.top.loop_end_sec, 5.0);
  assert!(engine.top.loop_exact_beat_sec.is_none());
}

#[test]
fn exact_loop_steps_preserve_start_and_beat_duration() {
  let mut engine = loop_engine();
  assert!(engine.set_loop_from_range(DeckId::Top, 1.23, 5.23, true));
  engine.step_loop_beats(DeckId::Top, -1);
  assert_eq!(engine.top.loop_start_sec, 1.23);
  assert_eq!(engine.top.loop_end_sec, 3.23);
  engine.step_loop_beats(DeckId::Top, 1);
  assert_eq!(engine.top.loop_start_sec, 1.23);
  assert_eq!(engine.top.loop_end_sec, 5.23);
}

#[test]
fn exact_loop_wraps_audio_to_the_unquantized_start() {
  for master_tempo in [false, true] {
    let mut engine = loop_engine();
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("loop.wav".to_string());
    top.loaded_file_path = top.file_path.clone();
    top.fully_decoded_file_path = top.file_path.clone();
    top.sample_rate = 44_100;
    top.channels = 1;
    top.pcm_data = std::sync::Arc::new(vec![0.5; 20 * 44_100]);
    top.master_tempo_enabled = master_tempo;
    top.playing = true;
    top.last_observed_at_ms = -1.0;
    assert!(engine.set_loop_from_range(DeckId::Top, 1.23, 5.23, true));
    engine.top.current_sec = 5.23;
    engine.reset_and_prime_master_tempo_state(DeckId::Top);
    for _ in 0..100 {
      engine.sample_deck(DeckId::Top);
    }
    assert!(engine.top.current_sec >= 1.23 && engine.top.current_sec < 1.24);
  }
}

#[test]
fn exact_loop_clamps_at_track_end_and_rejects_invalid_ranges() {
  let mut engine = loop_engine();
  assert!(engine.set_loop_from_range(DeckId::Top, 19.23, 23.23, true));
  assert_eq!(engine.top.loop_start_sec, 19.23);
  assert_eq!(engine.top.loop_end_sec, 20.0);
  for (start, end) in [(f64::NAN, 5.0), (1.0, f64::INFINITY), (5.0, 1.0), (20.0, 24.0)] {
    assert!(!engine.set_loop_from_range(DeckId::Top, start, end, true));
    assert!(!engine.top.loop_active);
    assert!(engine.top.loop_exact_beat_sec.is_none());
  }
}

#[test]
fn exact_loop_does_not_snap_playback_phase_in_beatsync() {
  let mut engine = loop_engine();
  for deck in [DeckId::Top, DeckId::Bottom] {
    let target = engine.deck_mut(deck);
    target.file_path = Some(format!("{deck:?}.wav"));
    target.loaded_file_path = target.file_path.clone();
    target.bpm = Some(120.0);
    target.first_beat_ms = Some(0.0);
    target.duration_sec = 20.0;
    target.sample_rate = 44_100;
    target.channels = 1;
    target.pcm_data = std::sync::Arc::new(vec![0.5; 20 * 44_100]);
    target.playing = true;
    target.current_sec = 1.0;
    target.last_observed_at_ms = 0.0;
  }
  engine.leader = Some(DeckId::Top);
  engine.sync_enabled = [true, true];
  engine.sync_lock = ["full", "full"];
  engine.bottom.current_sec = 1.23;
  engine.set_loop_from_range_command(DeckId::Bottom, 1.23, 5.23, true);
  assert_eq!(engine.bottom.current_sec, 1.23);
  assert_eq!(engine.bottom.loop_start_sec, 1.23);
  engine.refresh();
  assert_eq!(engine.bottom.current_sec, 1.23);
}

#[test]
fn clearing_exact_loop_restores_quantized_activation() {
  let mut engine = loop_engine();
  assert!(engine.set_loop_from_range(DeckId::Top, 1.23, 5.23, true));
  engine.deactivate_loop(DeckId::Top);
  assert!(engine.top.loop_exact_beat_sec.is_none());
  assert!(engine.activate_loop_from_anchor(DeckId::Top, 1.23));
  assert_eq!(engine.top.loop_start_sec, 1.0);
  assert_eq!(engine.top.loop_end_sec, 5.0);
}
