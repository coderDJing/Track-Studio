use super::*;

#[test]
fn align_to_leader_with_multiplier_aligns_rendered_grid() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 1000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("leader.mp3".to_string());
    top.loaded_file_path = Some("leader.mp3".to_string());
    top.bpm = Some(120.0);
    top.first_beat_ms = Some(0.0);
    top.duration_sec = 60.0;
    top.current_sec = 10.1;
    top.last_observed_at_ms = 1000.0;
    top.playing = true;
    top.playback_rate = 1.0;
    install_loaded_test_pcm(top, 60);
  }
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.file_path = Some("follower.mp3".to_string());
    bottom.loaded_file_path = Some("follower.mp3".to_string());
    bottom.bpm = Some(60.0);
    bottom.first_beat_ms = Some(0.0);
    bottom.duration_sec = 60.0;
    bottom.current_sec = -1.2;
    bottom.last_observed_at_ms = 1000.0;
    bottom.playing = false;
    bottom.playback_rate = 1.0;
    install_loaded_test_pcm(bottom, 60);
  }

  engine.set_leader(Some(DeckId::Top));
  engine.set_sync_enabled(DeckId::Top, true);
  engine.set_sync_enabled(DeckId::Bottom, true);
  engine.align_to_leader(DeckId::Bottom, Some(-1.2), false);

  let follower_grid = engine.beat_grid(DeckId::Bottom).unwrap();
  let leader_offset = adjusted_grid_offset_sec(&engine, DeckId::Top);
  let follower_offset = adjusted_grid_offset_sec(&engine, DeckId::Bottom);
  let nearest_delta_sec = (engine.deck(DeckId::Bottom).current_sec - (-1.2)).abs();

  assert!(
    (engine.bpm_multiplier[HorizontalBrowseTransportEngine::deck_index(DeckId::Bottom)] - 2.0)
      .abs()
      < 0.0001
  );
  assert!(engine.deck(DeckId::Bottom).current_sec < 0.0);
  assert!((leader_offset - follower_offset).abs() < 0.0001);
  assert!(nearest_delta_sec <= follower_grid.beat_sec * 0.5 + 0.0001);
}

#[test]
fn align_to_leader_skip_grid_snap_preserves_position_and_sets_rate() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 1000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("leader.mp3".to_string());
    top.loaded_file_path = Some("leader.mp3".to_string());
    top.bpm = Some(140.0);
    top.first_beat_ms = Some(20.0);
    top.downbeat_beat_offset = Some(0.0);
    top.duration_sec = 240.0;
    top.current_sec = 15.36;
    top.last_observed_at_ms = 1000.0;
    top.playing = true;
    top.playback_rate = 1.0;
    install_loaded_test_pcm(top, 240);
  }
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.file_path = Some("follower.mp3".to_string());
    bottom.loaded_file_path = Some("follower.mp3".to_string());
    bottom.bpm = Some(70.0);
    bottom.first_beat_ms = Some(110.0);
    bottom.downbeat_beat_offset = Some(0.0);
    bottom.duration_sec = 382.0;
    bottom.current_sec = 142.867;
    bottom.last_observed_at_ms = 1000.0;
    bottom.playing = false;
    bottom.playback_rate = 1.0;
    install_loaded_test_pcm(bottom, 382);
  }

  engine.set_leader(Some(DeckId::Top));
  let position_before = engine.deck(DeckId::Bottom).current_sec;
  engine.align_to_leader(DeckId::Bottom, Some(position_before), true);

  let snap = engine.snapshot(1000.0);
  assert!((engine.deck(DeckId::Bottom).current_sec - position_before).abs() < 0.0001);
  assert!(snap.bottom.sync_enabled, "sync should be enabled");
  assert!(
    (snap.bottom.playback_rate - 1.0).abs() < 0.001,
    "expected playback_rate ~1.0 (BPM already matched via multiplier), got {}",
    snap.bottom.playback_rate
  );
}
