use std::sync::Arc;

use super::*;

fn install_loaded_test_pcm(deck: &mut DeckState, seconds: usize) {
  deck.loaded_file_path = deck.file_path.clone();
  deck.sample_rate = 4;
  deck.channels = 1;
  deck.pcm_start_sec = 0.0;
  deck.pcm_data = Arc::new(vec![0.0; seconds.saturating_mul(4).max(1)]);
}

#[test]
fn audition_suspend_freezes_both_decks_without_changing_sync_scene() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.output_sample_rate = 4;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("audition-top.mp3".to_string());
    top.duration_sec = 100.0;
    top.current_sec = 1.0;
    top.last_observed_at_ms = -1.0;
    top.playing = true;
    top.playback_rate = 1.0;
    top.master_tempo_enabled = false;
    install_loaded_test_pcm(top, 100);
  }
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.file_path = Some("audition-bottom.mp3".to_string());
    bottom.duration_sec = 100.0;
    bottom.current_sec = 2.0;
    bottom.last_observed_at_ms = -1.0;
    bottom.playing = true;
    bottom.playback_rate = 0.5;
    bottom.master_tempo_enabled = false;
    install_loaded_test_pcm(bottom, 100);
  }
  engine.leader = Some(DeckId::Top);
  engine.sync_enabled = [true, true];
  engine.sync_lock = ["full", "full"];

  for _ in 0..4 {
    engine.mix_output_frame();
  }
  let top_before_suspend = engine.deck(DeckId::Top).current_sec;
  let bottom_before_suspend = engine.deck(DeckId::Bottom).current_sec;

  engine.set_audition_suspended(1000.0, true);
  let suspended_snapshot = engine.snapshot(1000.0);
  for _ in 0..400 {
    assert_eq!(engine.mix_output_frame(), (0.0, 0.0));
  }

  assert!(suspended_snapshot.audition_suspended);
  assert!(suspended_snapshot.top.playing);
  assert!(suspended_snapshot.bottom.playing);
  assert!(!suspended_snapshot.top.playing_audible);
  assert!(!suspended_snapshot.bottom.playing_audible);
  assert_eq!(engine.deck(DeckId::Top).current_sec, top_before_suspend);
  assert_eq!(
    engine.deck(DeckId::Bottom).current_sec,
    bottom_before_suspend
  );
  assert_eq!(engine.leader, Some(DeckId::Top));
  assert_eq!(engine.sync_enabled, [true, true]);
  assert_eq!(engine.sync_lock, ["full", "full"]);

  engine.set_audition_suspended(2000.0, false);
  for _ in 0..4 {
    engine.mix_output_frame();
  }

  let top_advanced = engine.deck(DeckId::Top).current_sec - top_before_suspend;
  let bottom_advanced = engine.deck(DeckId::Bottom).current_sec - bottom_before_suspend;
  assert!((top_advanced - 1.0).abs() < 0.0001);
  assert!((bottom_advanced - 0.5).abs() < 0.0001);
  assert!((top_advanced / 1.0 - bottom_advanced / 0.5).abs() < 0.0001);
  assert_eq!(engine.leader, Some(DeckId::Top));
  assert_eq!(engine.sync_enabled, [true, true]);
  assert_eq!(engine.sync_lock, ["full", "full"]);
}

#[test]
fn repeated_audition_suspend_does_not_accumulate_inter_deck_phase_error() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.output_sample_rate = 4;
  for (deck, file_path, rate) in [
    (DeckId::Top, "repeat-top.mp3", 1.0),
    (DeckId::Bottom, "repeat-bottom.mp3", 0.75),
  ] {
    let target = engine.deck_mut(deck);
    target.file_path = Some(file_path.to_string());
    target.duration_sec = 1000.0;
    target.current_sec = 0.0;
    target.last_observed_at_ms = -1.0;
    target.playing = true;
    target.playback_rate = rate;
    target.master_tempo_enabled = false;
    install_loaded_test_pcm(target, 1000);
  }

  for cycle in 0..1000 {
    let now_ms = cycle as f64 * 20.0;
    engine.set_audition_suspended(now_ms, true);
    for _ in 0..10 {
      engine.mix_output_frame();
    }
    engine.set_audition_suspended(now_ms + 10.0, false);
    engine.mix_output_frame();
  }

  let top_output_frames = engine.deck(DeckId::Top).current_sec / 1.0;
  let bottom_output_frames = engine.deck(DeckId::Bottom).current_sec / 0.75;
  assert!((top_output_frames - bottom_output_frames).abs() < 0.000001);
  assert!((top_output_frames - 250.0).abs() < 0.000001);
}
