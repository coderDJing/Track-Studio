use std::sync::Arc;

use super::*;

fn loaded_engine(master_tempo: bool, duration_sec: f64) -> HorizontalBrowseTransportEngine {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.output_sample_rate = 44_100;
  let top = engine.deck_mut(DeckId::Top);
  top.file_path = Some("track-end.mp3".to_string());
  top.loaded_file_path = top.file_path.clone();
  top.fully_decoded_file_path = top.file_path.clone();
  top.duration_sec = duration_sec;
  top.last_observed_at_ms = -1.0;
  top.playing = true;
  top.playback_rate = 1.25;
  top.master_tempo_enabled = master_tempo;
  top.sample_rate = 44_100;
  top.channels = 1;
  top.pcm_data = Arc::new(vec![0.5; 44_100]);
  engine.reset_and_prime_master_tempo_state(DeckId::Top);
  engine
}

#[test]
fn track_end_stays_playing_and_silent_until_seek_for_both_audio_modes() {
  for master_tempo in [false, true] {
    // Cover both a metadata end inside PCM and PCM ending before metadata.
    for duration_sec in [0.75, 1.25] {
      let mut engine = loaded_engine(master_tempo, duration_sec);
      let end_sec = duration_sec.min(1.0);
      for _ in 0..88_200 {
        engine.sample_deck(DeckId::Top);
      }
      let snapshot = engine.snapshot(1000.0).top;
      assert!(snapshot.playing);
      assert!(snapshot.play_requested);
      assert!(!snapshot.playing_audible);
      assert!((snapshot.current_sec - end_sec).abs() < 0.0001);
      for _ in 0..100 {
        assert_eq!(engine.sample_deck(DeckId::Top).0, (0.0, 0.0));
      }
      assert_eq!(engine.deck(DeckId::Top).current_sec, end_sec);

      // Waveform drag pauses temporarily, then seeks and restores the captured play intent.
      engine.set_playing(DeckId::Top, 1000.0, false);
      engine.seek(DeckId::Top, 1000.0, 0.25);
      assert_eq!(engine.sample_deck(DeckId::Top).0, (0.0, 0.0));
      engine.set_playing(DeckId::Top, 1000.0, true);
      let mut heard_audio = false;
      for _ in 0..10_000 {
        let (sample, _) = engine.sample_deck(DeckId::Top);
        heard_audio |= sample.0.abs() > 0.01;
      }
      assert!(heard_audio);
      assert!(engine.snapshot(1000.0).top.playing_audible);
    }
  }
}

#[test]
fn explicit_pause_at_track_end_keeps_seek_paused() {
  let mut engine = loaded_engine(false, 1.0);
  engine.seek(DeckId::Top, 1000.0, 1.0);
  engine.sample_deck(DeckId::Top);
  assert!(engine.snapshot(1000.0).top.playing);
  engine.set_playing(DeckId::Top, 1000.0, false);
  engine.seek(DeckId::Top, 1000.0, 0.25);
  assert_eq!(engine.sample_deck(DeckId::Top).0, (0.0, 0.0));
  assert!(!engine.snapshot(1000.0).top.playing);
}

#[test]
fn loop_at_track_end_keeps_wrapping() {
  let mut engine = loaded_engine(false, 1.0);
  let top = engine.deck_mut(DeckId::Top);
  top.loop_active = true;
  top.loop_start_sec = 0.5;
  top.loop_end_sec = 1.0;
  top.current_sec = 0.9999;
  for _ in 0..100 {
    engine.sample_deck(DeckId::Top);
  }
  let snapshot = engine.snapshot(1000.0).top;
  assert!(snapshot.playing_audible);
  assert!(snapshot.current_sec >= 0.5 && snapshot.current_sec < 0.51);
}
