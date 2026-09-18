use super::*;

impl HorizontalBrowseTransportEngine {
  pub(super) fn snapshot(&self, now_ms: f64) -> HorizontalBrowseTransportSnapshot {
    let top = self.deck_snapshot(DeckId::Top, now_ms);
    let bottom = self.deck_snapshot(DeckId::Bottom, now_ms);
    HorizontalBrowseTransportSnapshot {
      snapshot_sequence: next_snapshot_sequence(),
      state_revision: self.state_revision as f64,
      audition_suspended: self.audition_suspended,
      leader_deck: self.leader.map(|deck| deck.as_str().to_string()),
      top,
      bottom,
      output: self.output_snapshot(),
    }
  }

  pub(super) fn output_snapshot(&self) -> HorizontalBrowseTransportOutputSnapshot {
    HorizontalBrowseTransportOutputSnapshot {
      crossfader_value: self.crossfader_value as f64,
      master_gain: self.master_gain as f64,
      top_deck_gain: self.top.gain as f64,
      bottom_deck_gain: self.bottom.gain as f64,
      limiter_overload: self.master_limiter.overload(),
      limiter_gain_reduction_db: self.master_limiter.gain_reduction_db() as f64,
      sample_rate: self.output_sample_rate as f64,
      channels: self.output_channels as f64,
    }
  }

  pub(super) fn deck_snapshot(
    &self,
    deck: DeckId,
    now_ms: f64,
  ) -> HorizontalBrowseTransportDeckSnapshot {
    let deck_state = self.deck(deck);
    let derived = self.derive_state(deck, now_ms);
    let audio_current_sec =
      Self::timeline_sec_to_audio_sec(deck_state, derived.estimated_current_sec);
    let loaded = self.is_loaded(deck);
    let (loaded_segment_start_sec, loaded_segment_end_sec) = if loaded {
      (
        deck_state.pcm_start_sec,
        self.resolve_loaded_segment_end_sec(deck),
      )
    } else {
      (0.0, 0.0)
    };
    let playhead_loaded = self.has_loaded_segment_covering(deck, derived.estimated_current_sec);
    let full_decoding = deck_state.pending_full_decode_file_path.is_some();
    let effective_duration_sec =
      Self::effective_track_end_sec(deck_state).unwrap_or(deck_state.duration_sec);
    HorizontalBrowseTransportDeckSnapshot {
      deck: deck.as_str().to_string(),
      label: deck_state
        .title
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| {
          deck_state
            .file_path
            .as_ref()
            .and_then(|path| path.split(['/', '\\']).last().map(|s| s.to_string()))
            .unwrap_or_default()
        }),
      loaded,
      fully_decoded: self.is_fully_decoded(deck),
      decoding: deck_state.pending_decode_file_path.is_some() || full_decoding,
      full_decoding,
      play_requested: deck_state.playing,
      playing_audible: derived.playing_audible,
      playhead_loaded,
      playing: deck_state.playing,
      current_sec: derived.estimated_current_sec,
      audio_current_sec,
      loaded_segment_start_sec,
      loaded_segment_end_sec,
      duration_sec: deck_state.duration_sec,
      effective_duration_sec,
      playback_rate: deck_state.playback_rate,
      master_tempo_enabled: deck_state.master_tempo_enabled,
      bpm: deck_state.bpm.unwrap_or(0.0),
      effective_bpm: derived.effective_bpm,
      render_current_sec: derived.render_current_sec,
      sync_enabled: self.sync_enabled[Self::deck_index(deck)],
      sync_lock: self.sync_lock[Self::deck_index(deck)].to_string(),
      leader: self.leader == Some(deck),
      loop_active: deck_state.loop_active,
      loop_beat_value: deck_state.loop_beat_value,
      loop_start_beat_index: deck_state.loop_start_beat_index,
      loop_start_sec: deck_state.loop_start_sec,
      loop_end_sec: deck_state.loop_end_sec,
      bands: deck_state.band_state,
      cue_monitor_enabled: deck_state.cue_monitor_enabled,
      auto_gain_enabled: deck_state.auto_gain.enabled,
      auto_gain_status: deck_state.auto_gain.status.to_string(),
      auto_gain_value: deck_state.auto_gain.target_linear as f64,
    }
  }
}
