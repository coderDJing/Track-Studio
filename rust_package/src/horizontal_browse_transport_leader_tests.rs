use std::sync::Arc;

use super::*;

fn loaded_engine() -> HorizontalBrowseTransportEngine {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 1000.0;
  for deck in [DeckId::Top, DeckId::Bottom] {
    let target = engine.deck_mut(deck);
    target.file_path = Some(format!("{deck:?}.wav"));
    target.loaded_file_path = target.file_path.clone();
    target.duration_sec = 20.0;
    target.current_sec = 1.0;
    target.last_observed_at_ms = 1000.0;
    target.sample_rate = 4;
    target.channels = 1;
    target.pcm_data = Arc::new(vec![0.0; 80]);
  }
  engine
}

#[test]
fn a_single_loaded_stopped_deck_automatically_becomes_master() {
  for master in [DeckId::Top, DeckId::Bottom] {
    let mut engine = loaded_engine();
    let empty = if master == DeckId::Top {
      DeckId::Bottom
    } else {
      DeckId::Top
    };
    engine.deck_mut(empty).file_path = None;

    engine.refresh();

    assert_eq!(engine.leader, Some(master));
    assert!(engine.snapshot(1000.0).leader_deck.is_some());
    assert_eq!(engine.manually_selected_leader, None);
    assert!(!engine.deck(master).playing);
  }
}

#[test]
fn the_first_deck_becomes_master_once_its_audio_is_loaded() {
  let mut engine = loaded_engine();
  engine.bottom.file_path = None;
  let pcm = engine.top.pcm_data.clone();
  engine.top.pcm_data = Arc::new(Vec::new());
  engine.refresh();
  assert_eq!(engine.leader, None);

  engine.top.pcm_data = pcm;
  engine.refresh();
  assert_eq!(engine.leader, Some(DeckId::Top));

  engine.top.file_path = None;
  engine.refresh();
  assert_eq!(engine.leader, None);
}

#[test]
fn loading_a_second_stopped_deck_keeps_the_existing_automatic_master() {
  let mut engine = loaded_engine();
  let top_file_path = engine.top.file_path.take();
  engine.refresh();
  assert_eq!(engine.leader, Some(DeckId::Bottom));

  engine.top.file_path = top_file_path;
  engine.refresh();

  assert_eq!(engine.leader, Some(DeckId::Bottom));
}

#[test]
fn pausing_a_playing_manual_master_hands_over_to_the_playing_deck() {
  for master in [DeckId::Top, DeckId::Bottom] {
    let mut engine = loaded_engine();
    let follower = if master == DeckId::Top {
      DeckId::Bottom
    } else {
      DeckId::Top
    };
    engine.top.playing = true;
    engine.bottom.playing = true;
    engine.set_leader(Some(master));
    engine.deck_mut(master).playing = false;

    engine.refresh();

    assert_eq!(engine.leader, Some(follower));
    assert_eq!(engine.manually_selected_leader, None);
  }
}

#[test]
fn ejecting_a_stopped_master_hands_over_to_the_other_loaded_deck() {
  for master in [DeckId::Top, DeckId::Bottom] {
    let mut engine = loaded_engine();
    let follower = if master == DeckId::Top {
      DeckId::Bottom
    } else {
      DeckId::Top
    };
    engine.set_leader(Some(master));
    engine.deck_mut(master).file_path = None;

    engine.refresh();

    assert_eq!(engine.leader, Some(follower));
    assert_eq!(engine.manually_selected_leader, None);
    assert!(!engine.deck(follower).playing);
  }
}

#[test]
fn ejecting_the_only_loaded_master_leaves_no_master() {
  let mut engine = loaded_engine();
  engine.bottom.file_path = None;
  engine.set_leader(Some(DeckId::Top));
  engine.top.file_path = None;

  engine.refresh();

  assert_eq!(engine.leader, None);
}

#[test]
fn an_initially_stopped_manual_master_can_play_then_hand_over_when_paused() {
  let mut engine = loaded_engine();
  engine.bottom.playing = true;
  engine.set_leader(Some(DeckId::Top));
  engine.refresh();
  assert_eq!(engine.leader, Some(DeckId::Top));

  engine.top.playing = true;
  engine.refresh();
  engine.top.playing = false;
  engine.refresh();

  assert_eq!(engine.leader, Some(DeckId::Bottom));
}

#[test]
fn ejecting_the_playing_master_hands_back_to_the_deck_at_track_end() {
  for ended in [DeckId::Top, DeckId::Bottom] {
    for manual_master in [false, true] {
      // Metadata may end before PCM, or fully decoded PCM before metadata.
      for (duration_sec, end_sec) in [(16.0, 16.0), (24.0, 20.0)] {
        let mut engine = loaded_engine();
        let playing = ended.other();
        engine.top.playing = true;
        engine.bottom.playing = true;
        engine.leader = Some(ended);
        if manual_master {
          engine.set_leader(Some(ended));
        }
        {
          let target = engine.deck_mut(ended);
          target.fully_decoded_file_path = target.file_path.clone();
          target.duration_sec = duration_sec;
          target.current_sec = end_sec;
          target.last_observed_at_ms = -1.0;
        }
        engine.refresh();
        assert_eq!(engine.leader, Some(playing));
        if manual_master {
          engine.set_leader(Some(playing));
        }

        engine.deck_mut(playing).file_path = None;
        engine.deck_mut(playing).playing = false;
        engine.sync_enabled = [true, true];
        for _ in 0..3 {
          engine.refresh();
          assert_eq!(engine.leader, Some(ended));
          assert_eq!(engine.manually_selected_leader, None);
          let snapshot = engine.deck_snapshot(ended, 1000.0);
          assert!(snapshot.leader);
          assert!(snapshot.playing);
          assert!(!snapshot.playing_audible);
          assert_eq!(snapshot.current_sec, end_sec);
          assert_eq!(snapshot.sync_lock, "off");
        }

        engine.seek(ended, 1000.0, 1.0);
        assert!(engine.deck_snapshot(ended, 1000.0).playing_audible);
        assert_eq!(engine.leader, Some(ended));
      }
    }
  }
}

#[test]
fn both_finished_decks_keep_the_existing_master_until_it_is_ejected() {
  for master in [DeckId::Top, DeckId::Bottom] {
    let mut engine = loaded_engine();
    for deck in [DeckId::Top, DeckId::Bottom] {
      let target = engine.deck_mut(deck);
      target.playing = true;
      target.current_sec = target.duration_sec;
      target.last_observed_at_ms = -1.0;
    }
    engine.leader = Some(master);
    engine.refresh();
    assert_eq!(engine.leader, Some(master));

    engine.deck_mut(master).file_path = None;
    engine.refresh();
    assert_eq!(engine.leader, Some(master.other()));

    engine.deck_mut(master.other()).file_path = None;
    engine.refresh();
    assert_eq!(engine.leader, None);
  }
}

#[test]
fn an_unbuffered_playhead_before_track_end_is_not_a_finished_master_candidate() {
  let mut engine = loaded_engine();
  engine.top.playing = true;
  engine.bottom.playing = true;
  engine.top.current_sec = 5.0;
  engine.top.pcm_data = Arc::new(vec![0.0; 8]);
  engine.refresh();
  assert_eq!(engine.leader, Some(DeckId::Bottom));

  engine.bottom.file_path = None;
  engine.refresh();
  assert_eq!(engine.leader, None);
}

#[test]
fn output_buffer_hands_over_finished_master_without_external_refresh() {
  for master in [DeckId::Top, DeckId::Bottom] {
    for manual in [false, true] {
      for (duration_sec, pcm_end_sec) in [(2.0, 4), (4.0, 2)] {
        let mut engine = loaded_engine();
        engine.output_sample_rate = 4;
        for deck in [master, master.other()] {
          let target = engine.deck_mut(deck);
          target.playing = true;
          target.master_tempo_enabled = false;
          target.last_observed_at_ms = -1.0;
        }
        {
          let target = engine.deck_mut(master);
          target.duration_sec = duration_sec;
          target.current_sec = 1.75;
          target.pcm_data = Arc::new(vec![0.1; pcm_end_sec * 4]);
          target.fully_decoded_file_path = target.file_path.clone();
        }
        engine.leader = Some(master);
        if manual {
          engine.set_leader(Some(master));
        }
        let before_revision = engine.state_revision;
        engine.render_output_buffer(&mut [0.0_f32; 4], 2);

        let snapshot = engine.snapshot(1000.0);
        assert_eq!(engine.leader, Some(master.other()));
        assert_eq!(engine.manually_selected_leader, None);
        assert!(snapshot.state_revision > before_revision as f64);
        assert!(engine.deck_snapshot(master.other(), 1000.0).playing_audible);
        assert!(!engine.deck_snapshot(master, 1000.0).playing_audible);
      }
    }
  }
}

#[test]
fn output_buffer_keeps_finished_master_when_other_deck_cannot_play() {
  for other_finished in [false, true] {
    let mut engine = loaded_engine();
    engine.output_sample_rate = 4;
    for deck in [DeckId::Top, DeckId::Bottom] {
      let target = engine.deck_mut(deck);
      target.playing = true;
      target.master_tempo_enabled = false;
      target.last_observed_at_ms = -1.0;
    }
    engine.top.current_sec = 20.0;
    if other_finished {
      engine.bottom.current_sec = 20.0;
    } else {
      engine.bottom.current_sec = 5.0;
      engine.bottom.pcm_data = Arc::new(vec![0.0; 8]);
    }
    engine.leader = Some(DeckId::Top);
    let revision = engine.state_revision;
    engine.render_output_buffer(&mut [0.0_f32; 4], 2);
    assert_eq!(engine.leader, Some(DeckId::Top));
    assert_eq!(engine.state_revision, revision);
  }
}

#[test]
fn output_buffer_does_not_handover_master_wrapping_at_track_end() {
  let mut engine = loaded_engine();
  engine.output_sample_rate = 4;
  for deck in [DeckId::Top, DeckId::Bottom] {
    let target = engine.deck_mut(deck);
    target.playing = true;
    target.master_tempo_enabled = false;
    target.last_observed_at_ms = -1.0;
  }
  engine.top.current_sec = 19.75;
  engine.top.loop_active = true;
  engine.top.loop_start_sec = 19.0;
  engine.top.loop_end_sec = 20.0;
  engine.leader = Some(DeckId::Top);
  engine.render_output_buffer(&mut [0.0_f32; 4], 2);
  assert_eq!(engine.leader, Some(DeckId::Top));
  assert!(engine.top.current_sec < 20.0);
}

#[test]
fn output_buffer_preserves_playing_deck_rate_during_synced_handover() {
  for master in [DeckId::Top, DeckId::Bottom] {
    let mut engine = loaded_engine();
    engine.output_sample_rate = 4;
    for deck in [master, master.other()] {
      let target = engine.deck_mut(deck);
      target.playing = true;
      target.master_tempo_enabled = false;
      target.last_observed_at_ms = -1.0;
      target.bpm = Some(120.0);
      target.playback_rate = 1.25;
    }
    engine.deck_mut(master).current_sec = 19.8;
    engine.sync_enabled = [true, true];
    engine.sync_lock = ["full", "full"];
    engine.leader = Some(master);
    engine.render_output_buffer(&mut [0.0_f32; 2], 2);
    let follower = engine.deck(master.other());
    assert_eq!(engine.leader, Some(master.other()));
    assert!((follower.playback_rate - 1.25).abs() < 0.000001);
    assert_eq!(engine.sync_lock[HorizontalBrowseTransportEngine::deck_index(master.other())], "full");
  }
}

#[test]
fn output_buffer_hands_over_after_tempo_stretched_master_reaches_end() {
  // Run with FRKB_R3_STRETCH_LIBRARY pointing to the bundled Rubber Band library.
  let mut engine = loaded_engine();
  engine.output_sample_rate = 44_100;
  for deck in [DeckId::Top, DeckId::Bottom] {
    let target = engine.deck_mut(deck);
    target.playing = true;
    target.current_sec = 0.0;
    target.last_observed_at_ms = -1.0;
    target.sample_rate = 44_100;
    target.duration_sec = 2.0;
    target.pcm_data = Arc::new(vec![0.1; 88_200]);
    target.fully_decoded_file_path = target.file_path.clone();
  }
  engine.top.duration_sec = 1.0;
  engine.top.master_tempo_enabled = true;
  engine.top.playback_rate = 1.25;
  engine.leader = Some(DeckId::Top);
  for _ in 0..100 {
    engine.render_output_buffer(&mut [0.0_f32; 1024], 2);
  }
  assert_eq!(engine.leader, Some(DeckId::Bottom), "master position: {}", engine.top.current_sec);
  assert!(engine.bottom.current_sec < engine.bottom.duration_sec);
}
