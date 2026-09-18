use super::*;

impl HorizontalBrowseTransportEngine {
  fn normalized_path(value: &Option<String>) -> &str {
    value.as_deref().map(str::trim).unwrap_or("")
  }

  fn has_full_track_pcm_state(deck_state: &DeckState) -> bool {
    let file_path = Self::normalized_path(&deck_state.file_path);
    !file_path.is_empty()
      && Self::normalized_path(&deck_state.loaded_file_path) == file_path
      && Self::normalized_path(&deck_state.fully_decoded_file_path) == file_path
      && deck_state.pcm_start_sec <= 0.0001
      && !deck_state.pcm_data.is_empty()
      && deck_state.sample_rate > 0
      && deck_state.channels > 0
  }

  fn decoded_pcm_end_timeline_sec(deck_state: &DeckState) -> Option<f64> {
    if deck_state.sample_rate == 0 || deck_state.channels == 0 {
      return None;
    }
    let frame_count = deck_state.pcm_data.len() / deck_state.channels as usize;
    if frame_count == 0 {
      return None;
    }
    let audio_end_sec =
      deck_state.pcm_start_sec + frame_count as f64 / deck_state.sample_rate as f64;
    let timeline_end_sec = Self::audio_sec_to_timeline_sec(deck_state, audio_end_sec);
    timeline_end_sec.is_finite().then_some(timeline_end_sec)
  }

  pub(super) fn effective_track_end_sec(deck_state: &DeckState) -> Option<f64> {
    let duration_sec = if deck_state.duration_sec.is_finite() && deck_state.duration_sec > 0.0 {
      Some(deck_state.duration_sec)
    } else {
      None
    };
    let decoded_end_sec = if Self::has_full_track_pcm_state(deck_state) {
      Self::decoded_pcm_end_timeline_sec(deck_state)
    } else {
      None
    };
    match (duration_sec, decoded_end_sec) {
      (Some(duration), Some(decoded_end)) => Some(duration.min(decoded_end)),
      (Some(duration), None) => Some(duration),
      (None, Some(decoded_end)) => Some(decoded_end),
      (None, None) => None,
    }
  }

  pub(super) fn original_beat_grid(&self, deck: DeckId) -> Option<BeatGridSnapshot> {
    let current_sec = Self::estimate_current_sec(self.deck(deck), self.last_now_ms);
    self.original_beat_grid_at_sec(deck, current_sec)
  }

  pub(super) fn original_beat_grid_at_sec(
    &self,
    deck: DeckId,
    sec: f64,
  ) -> Option<BeatGridSnapshot> {
    let deck_state = self.deck(deck);
    if !deck_state.rekordbox_beat_grid_entries.is_empty() {
      return Self::rekordbox_grid_as_fixed_snapshot_at_sec(deck_state, sec);
    }
    if let Some(clip) = Self::dynamic_grid_clip_at_sec(deck_state, sec) {
      return Some(Self::dynamic_grid_as_fixed_snapshot(clip));
    }
    let bpm = deck_state.bpm?;
    if !bpm.is_finite() || bpm <= 0.0 {
      return None;
    }
    Some(BeatGridSnapshot {
      bpm,
      beat_sec: 60.0 / bpm,
      first_beat_sec: (deck_state.first_beat_ms.unwrap_or(0.0).max(0.0)) / 1000.0,
      downbeat_beat_offset: deck_state
        .downbeat_beat_offset
        .and_then(Self::normalize_downbeat_beat_offset)
        .unwrap_or(0.0),
    })
  }

  pub(super) fn beat_grid(&self, deck: DeckId) -> Option<BeatGridSnapshot> {
    let current_sec = Self::estimate_current_sec(self.deck(deck), self.last_now_ms);
    self.beat_grid_at_sec(deck, current_sec)
  }

  pub(super) fn beat_grid_at_sec(&self, deck: DeckId, sec: f64) -> Option<BeatGridSnapshot> {
    let original = self.original_beat_grid_at_sec(deck, sec)?;
    let multiplier = self.bpm_multiplier[Self::deck_index(deck)];
    let adjusted_bpm = original.bpm
      * if multiplier.is_finite() && multiplier > 0.0 {
        multiplier
      } else {
        1.0
      };
    if !adjusted_bpm.is_finite() || adjusted_bpm <= 0.0 {
      return None;
    }
    Some(BeatGridSnapshot {
      bpm: adjusted_bpm,
      beat_sec: 60.0 / adjusted_bpm,
      first_beat_sec: original.first_beat_sec,
      downbeat_beat_offset: original.downbeat_beat_offset,
    })
  }

  pub(super) fn effective_bpm_for_deck(&self, deck: DeckId) -> f64 {
    let current_sec = Self::estimate_current_sec(self.deck(deck), self.last_now_ms);
    self.effective_bpm_for_deck_at_sec(deck, current_sec)
  }

  pub(super) fn effective_bpm_for_deck_at_sec(&self, deck: DeckId, sec: f64) -> f64 {
    let Some(grid) = self.beat_grid_at_sec(deck, sec) else {
      return 0.0;
    };
    let playback_rate = self.deck(deck).playback_rate;
    grid.bpm
      * if playback_rate.is_finite() && playback_rate > 0.0 {
        playback_rate
      } else {
        1.0
      }
  }

  pub(super) fn smooth_dynamic_sync_playback_rate(
    &mut self,
    deck: DeckId,
    output_sample_rate: f64,
  ) {
    let Some(leader) = self.leader else {
      return;
    };
    if deck == leader {
      return;
    }
    let deck_index = Self::deck_index(deck);
    if !self.sync_enabled[deck_index] || self.sync_lock[deck_index] == "off" {
      return;
    }
    if self.deck(deck).dynamic_beat_grid.is_empty()
      && self.deck(leader).dynamic_beat_grid.is_empty()
    {
      return;
    }

    let now_ms = self.last_now_ms;
    let leader_sec = Self::estimate_current_sec(self.deck(leader), now_ms);
    let target_sec = Self::estimate_current_sec(self.deck(deck), now_ms);
    let leader_effective_bpm = self.effective_bpm_for_deck_at_sec(leader, leader_sec);
    if !leader_effective_bpm.is_finite() || leader_effective_bpm <= 0.0 {
      return;
    }
    let multiplier = self.resolve_bpm_multiplier(deck, leader_effective_bpm);
    self.bpm_multiplier[deck_index] = multiplier;
    let Some(target_grid) = self.original_beat_grid_at_sec(deck, target_sec) else {
      return;
    };
    let adjusted_target_bpm = target_grid.bpm
      * if multiplier.is_finite() && multiplier > 0.0 {
        multiplier
      } else {
        1.0
      };
    if !adjusted_target_bpm.is_finite() || adjusted_target_bpm <= 0.0 {
      return;
    }
    let desired_rate = (leader_effective_bpm / adjusted_target_bpm).clamp(0.25, 4.0);
    let current_rate = Self::normalize_playback_rate(self.deck(deck).playback_rate);
    let diff = desired_rate - current_rate;
    if diff.abs() <= 0.000001 {
      return;
    }
    let smoothing_sec = 0.08;
    let alpha = (1.0 / (output_sample_rate.max(1.0) * smoothing_sec)).clamp(0.0, 1.0);
    let next_rate = if diff.abs() <= 0.00001 {
      desired_rate
    } else {
      current_rate + diff * alpha
    };
    self.deck_mut(deck).playback_rate = Self::normalize_playback_rate(next_rate);
  }

  pub(super) fn estimate_current_sec(deck: &DeckState, now_ms: f64) -> f64 {
    let base = if deck.current_sec.is_finite() {
      deck.current_sec
    } else {
      0.0
    };
    if deck.pcm_data.is_empty() || deck.sample_rate == 0 || deck.channels == 0 {
      return base;
    }
    if !deck.playing {
      return base;
    }
    if deck.last_observed_at_ms < 0.0 {
      return base;
    }
    if !deck.last_observed_at_ms.is_finite() || deck.last_observed_at_ms <= 0.0 {
      return base;
    }
    let rate = if deck.playback_rate.is_finite() && deck.playback_rate > 0.0 {
      deck.playback_rate
    } else {
      1.0
    };
    let delta_sec = ((now_ms - deck.last_observed_at_ms).max(0.0)) / 1000.0;
    let estimated = base + delta_sec * rate;
    if let Some(end_sec) = Self::effective_track_end_sec(deck) {
      estimated.min(end_sec)
    } else {
      estimated
    }
  }

  pub(super) fn resolve_leader_candidate(&self, requested: DeckId) -> Option<DeckId> {
    let now_ms = self.last_now_ms;
    if let Some(leader) = self.leader {
      if self.is_sync_ready(leader, now_ms) {
        return Some(leader);
      }
    }
    let other = requested.other();
    if self.is_playing_audible_at(other, now_ms) {
      return Some(other);
    }
    if self.is_sync_ready(other, now_ms) {
      return Some(other);
    }
    if self.is_sync_ready(requested, now_ms) {
      return Some(requested);
    }
    None
  }

  pub(super) fn resolve_bpm_multiplier(&self, deck: DeckId, master_effective_bpm: f64) -> f64 {
    let current_sec = Self::estimate_current_sec(self.deck(deck), self.last_now_ms);
    let Some(grid) = self.original_beat_grid_at_sec(deck, current_sec) else {
      return 1.0;
    };
    let candidates = [0.5_f64, 1.0, 2.0];
    let mut best = 1.0;
    let mut best_diff = f64::INFINITY;
    for candidate in candidates {
      let adjusted = grid.bpm * candidate;
      if !adjusted.is_finite() || adjusted <= 0.0 {
        continue;
      }
      let diff = (master_effective_bpm / adjusted).ln().abs();
      if diff < best_diff {
        best = candidate;
        best_diff = diff;
      }
    }
    best
  }

  pub(super) fn update_multipliers(&mut self) {
    let Some(leader) = self.leader else {
      self.bpm_multiplier = [1.0, 1.0];
      return;
    };
    if self.original_beat_grid(leader).is_none() {
      self.bpm_multiplier = [1.0, 1.0];
      return;
    }
    let leader_effective_bpm = self.effective_bpm_for_deck(leader);
    if !leader_effective_bpm.is_finite() || leader_effective_bpm <= 0.0 {
      self.bpm_multiplier = [1.0, 1.0];
      return;
    }
    for deck in [DeckId::Top, DeckId::Bottom] {
      let index = Self::deck_index(deck);
      self.bpm_multiplier[index] = if deck == leader {
        1.0
      } else {
        self.resolve_bpm_multiplier(deck, leader_effective_bpm)
      };
    }
  }

  pub(super) fn derive_state(&self, deck: DeckId, now_ms: f64) -> DeckDerivedState {
    let deck_state = self.deck(deck);
    let current_sec = Self::estimate_current_sec(deck_state, now_ms);
    let playing_audible = !self.audition_suspended
      && deck_state.playing
      && self.has_loaded_segment_covering(deck, current_sec);
    if self.beat_grid_at_sec(deck, current_sec).is_none() {
      return DeckDerivedState {
        estimated_current_sec: current_sec,
        effective_bpm: 0.0,
        render_current_sec: current_sec,
        playing_audible,
      };
    }
    DeckDerivedState {
      estimated_current_sec: current_sec,
      effective_bpm: self.effective_bpm_for_deck_at_sec(deck, current_sec),
      render_current_sec: current_sec,
      playing_audible,
    }
  }

  pub(super) fn recompute_distances(&mut self) {
    let now_ms = self.last_now_ms;
    for deck in [DeckId::Top, DeckId::Bottom] {
      let index = Self::deck_index(deck);
      if self.beat_grid(deck).is_none() {
        self.beat_distance[index] = 0.0;
        self.target_beat_distance[index] = 0.0;
        continue;
      };
      let current_sec = Self::estimate_current_sec(self.deck(deck), now_ms);
      self.beat_distance[index] = self
        .sync_beat_distance_at_sec(deck, current_sec)
        .unwrap_or(0.0);
      self.target_beat_distance[index] = self.beat_distance[index];
    }
    if let Some(leader) = self.leader {
      let leader_index = Self::deck_index(leader);
      let leader_target = self.beat_distance[leader_index];
      for deck in [DeckId::Top, DeckId::Bottom] {
        let index = Self::deck_index(deck);
        self.target_beat_distance[index] = if deck == leader {
          self.beat_distance[index]
        } else {
          leader_target
        };
      }
    }
  }

  #[cfg(test)]
  pub(super) fn target_sec_from_beat_distance(grid: BeatGridSnapshot, beat_distance: f64) -> f64 {
    grid.first_beat_sec + beat_distance * grid.beat_sec
  }

  #[cfg(test)]
  pub(super) fn nearest_grid_offset_sec(grid: BeatGridSnapshot, current_sec: f64) -> f64 {
    if !current_sec.is_finite() || !grid.beat_sec.is_finite() || grid.beat_sec <= 0.0 {
      return 0.0;
    }
    let beat_distance = (current_sec - grid.first_beat_sec) / grid.beat_sec;
    if !beat_distance.is_finite() {
      return 0.0;
    }
    current_sec - Self::target_sec_from_beat_distance(grid, beat_distance.round())
  }

  pub(super) fn sync_beat_distance_at_sec(&self, deck: DeckId, sec: f64) -> Option<f64> {
    let multiplier = self.bpm_multiplier[Self::deck_index(deck)];
    let deck_state = self.deck(deck);
    if !deck_state.rekordbox_beat_grid_entries.is_empty() {
      return Self::rekordbox_beat_distance_at_sec_with_multiplier(deck_state, sec, multiplier);
    }
    if !deck_state.dynamic_beat_grid.is_empty() {
      return Self::dynamic_beat_distance_at_sec_with_multiplier(deck_state, sec, multiplier);
    }
    let grid = self.beat_grid_at_sec(deck, sec)?;
    if !grid.beat_sec.is_finite() || grid.beat_sec <= 0.0 {
      return None;
    }
    Some((sec - grid.first_beat_sec) / grid.beat_sec)
  }

  fn sync_sec_at_beat_distance(
    &self,
    deck: DeckId,
    beat_distance: f64,
    anchor_sec: f64,
  ) -> Option<f64> {
    let multiplier = self.bpm_multiplier[Self::deck_index(deck)];
    let deck_state = self.deck(deck);
    if !deck_state.rekordbox_beat_grid_entries.is_empty() {
      return Self::rekordbox_sec_at_beat_distance_with_multiplier(
        deck_state,
        beat_distance,
        multiplier,
      );
    }
    if !deck_state.dynamic_beat_grid.is_empty() {
      return Self::dynamic_sec_at_beat_distance_with_multiplier(
        deck_state,
        beat_distance,
        multiplier,
      );
    }
    let grid = self.beat_grid_at_sec(deck, anchor_sec)?;
    if !grid.beat_sec.is_finite() || grid.beat_sec <= 0.0 {
      return None;
    }
    Some(grid.first_beat_sec + beat_distance * grid.beat_sec)
  }

  pub(super) fn nearest_valid_sec_matching_sync_phase(
    &self,
    target_deck: DeckId,
    anchor_sec: f64,
    leader_deck: DeckId,
    leader_current_sec: f64,
    min_sec: f64,
    max_sec: f64,
  ) -> Option<f64> {
    let leader_distance = self.sync_beat_distance_at_sec(leader_deck, leader_current_sec)?;
    let anchor_distance = self.sync_beat_distance_at_sec(target_deck, anchor_sec)?;
    let min_distance = self.sync_beat_distance_at_sec(target_deck, min_sec)?;
    let max_distance = self.sync_beat_distance_at_sec(target_deck, max_sec)?;
    let phase = leader_distance.rem_euclid(1.0);
    let low_distance = min_distance.min(max_distance);
    let high_distance = min_distance.max(max_distance);
    let min_index = (low_distance - phase).ceil();
    let max_index = (high_distance - phase).floor();
    if !min_index.is_finite() || !max_index.is_finite() || min_index > max_index {
      return Some(anchor_sec.clamp(min_sec, max_sec));
    }
    let anchor_index = ((anchor_distance - phase).round()).clamp(min_index, max_index);
    let target_distance = anchor_index + phase;
    let aligned_sec = self.sync_sec_at_beat_distance(target_deck, target_distance, anchor_sec)?;
    Some(aligned_sec.clamp(min_sec, max_sec))
  }

  fn alignment_min_sec_for_anchor(anchor_sec: f64, target_grid: BeatGridSnapshot) -> f64 {
    if !anchor_sec.is_finite() || anchor_sec >= 0.0 {
      return 0.0;
    }
    if target_grid.beat_sec.is_finite() && target_grid.beat_sec > 0.0 {
      anchor_sec - target_grid.beat_sec
    } else {
      anchor_sec
    }
  }

  pub(super) fn relax_sync_lock_after_grid_change(&mut self, updated_deck: DeckId) {
    let leader = self.leader;
    for deck in [DeckId::Top, DeckId::Bottom] {
      let index = Self::deck_index(deck);
      if !self.sync_enabled[index] || self.sync_lock[index] == "off" {
        continue;
      }
      if leader == Some(deck) {
        continue;
      }
      if deck == updated_deck || leader == Some(updated_deck) {
        self.set_sync_lock(deck, "tempo-only");
      }
    }
  }

  fn refresh_sync_state_with_multiplier_update(
    &mut self,
    allow_phase_alignment: bool,
    update_bpm_multipliers: bool,
  ) {
    self.auto_select_leader_from_playback();
    if update_bpm_multipliers {
      self.update_multipliers();
    } else if let Some(leader) = self.leader {
      self.bpm_multiplier[Self::deck_index(leader)] = 1.0;
    }
    self.recompute_distances();
    for deck in [DeckId::Top, DeckId::Bottom] {
      let index = Self::deck_index(deck);
      if !self.sync_enabled[index] {
        self.set_sync_lock(deck, "off");
        continue;
      }
      if self.leader.is_none() {
        self.set_sync_lock(deck, "off");
        continue;
      }
      if self.leader == Some(deck) {
        self.set_sync_lock(deck, "full");
        continue;
      }
      if self.sync_lock[index] == "off" {
        self.set_sync_lock(deck, "full");
      }
    }
    if let Some(leader) = self.leader {
      let now_ms = self.last_now_ms;
      if !self.is_sync_ready(leader, now_ms) {
        self.leader = None;
        for deck in [DeckId::Top, DeckId::Bottom] {
          self.set_sync_lock(deck, "off");
        }
        return;
      }
      let leader_current_sec = Self::estimate_current_sec(self.deck(leader), now_ms);
      let Some(leader_target_beat_distance) =
        self.sync_beat_distance_at_sec(leader, leader_current_sec)
      else {
        return;
      };
      for deck in [DeckId::Top, DeckId::Bottom] {
        if deck == leader {
          continue;
        }
        let deck_index = Self::deck_index(deck);
        if !self.sync_enabled[deck_index] || self.sync_lock[deck_index] == "off" {
          continue;
        }
        if !self.is_sync_ready(deck, now_ms) {
          self.set_sync_lock(deck, "off");
          continue;
        }
        if self.beat_grid(deck).is_none() {
          continue;
        }
        let target_current_sec = Self::estimate_current_sec(self.deck(deck), now_ms);
        self.target_beat_distance[deck_index] = leader_target_beat_distance;

        let leader_effective_bpm = self.effective_bpm_for_deck(leader);
        if let Some(tempo_rate) = {
          let multiplier = if update_bpm_multipliers {
            let resolved = self.resolve_bpm_multiplier(deck, leader_effective_bpm);
            self.bpm_multiplier[deck_index] = resolved;
            resolved
          } else {
            let current = self.bpm_multiplier[deck_index];
            if current.is_finite() && current > 0.0 {
              current
            } else {
              1.0
            }
          };
          self
            .original_beat_grid_at_sec(deck, target_current_sec)
            .and_then(|grid| {
              let adjusted_target_bpm = grid.bpm
                * if multiplier.is_finite() && multiplier > 0.0 {
                  multiplier
                } else {
                  1.0
                };
              if adjusted_target_bpm.is_finite() && adjusted_target_bpm > 0.0 {
                Some((leader_effective_bpm / adjusted_target_bpm).clamp(0.25, 4.0))
              } else {
                None
              }
            })
        } {
          let current_rate = Self::normalize_playback_rate(self.deck(deck).playback_rate);
          if (current_rate - tempo_rate).abs() > 0.000001 {
            // The follower was estimated with its previous rate above. Rebase it before changing
            // rate so the new value is not applied retroactively to the whole observation window.
            // Retroactive application accumulates a permanent phase offset during rapid tempo
            // changes, even though both decks still report the same effective BPM.
            let target = self.deck_mut(deck);
            target.current_sec = target_current_sec;
            target.last_observed_at_ms = now_ms;
            target.playback_rate = tempo_rate;
          }
        }

        if allow_phase_alignment
          && self.sync_lock[deck_index] == "full"
          && self.quantize_enabled[deck_index]
          && self.is_playing_audible_at(deck, now_ms)
        {
          let target_duration_sec = self.deck(deck).duration_sec.max(0.0);
          let Some(aligned_sec) = self.nearest_valid_sec_matching_sync_phase(
            deck,
            target_current_sec,
            leader,
            leader_current_sec,
            0.0,
            target_duration_sec,
          ) else {
            continue;
          };
          let phase_adjusted = (aligned_sec - target_current_sec).abs()
            > HORIZONTAL_BROWSE_MASTER_TEMPO_PHASE_RESET_THRESHOLD_SEC;
          {
            let target = self.deck_mut(deck);
            target.current_sec = aligned_sec;
            target.last_observed_at_ms = now_ms;
          }
          if phase_adjusted
            && horizontal_browse_transport_audio::should_use_master_tempo(self.deck(deck))
          {
            self.reset_and_prime_master_tempo_state(deck);
          }
        }
      }
      self.recompute_distances();
    }
  }

  pub(super) fn refresh_sync_state(&mut self, allow_phase_alignment: bool) {
    self.refresh_sync_state_with_multiplier_update(allow_phase_alignment, true);
  }

  fn refresh_sync_state_preserving_bpm_multipliers(&mut self, allow_phase_alignment: bool) {
    self.refresh_sync_state_with_multiplier_update(allow_phase_alignment, false);
  }

  pub(super) fn refresh(&mut self) {
    self.refresh_sync_state(true);
  }

  pub(super) fn sync_deck_to_now(&mut self, deck: DeckId, now_ms: f64) {
    let estimated = Self::estimate_current_sec(self.deck(deck), now_ms);
    let target = self.deck_mut(deck);
    target.current_sec = estimated;
    target.last_observed_at_ms = now_ms;
  }

  pub(super) fn apply_external_deck_state(
    &mut self,
    deck: DeckId,
    now_ms: f64,
    payload: HorizontalBrowseTransportDeckInput,
  ) {
    let current_file_path = self
      .deck(deck)
      .file_path
      .as_deref()
      .map(str::trim)
      .unwrap_or("")
      .to_string();
    let next_file_path = payload
      .file_path
      .as_deref()
      .map(str::trim)
      .unwrap_or("")
      .to_string();
    let same_file = current_file_path == next_file_path;
    let previous_current_sec = Self::estimate_current_sec(self.deck(deck), now_ms);
    let preserve_playhead =
      same_file && !next_file_path.is_empty() && self.deck(deck).playing && payload.playing;
    let next_current_sec = if preserve_playhead {
      previous_current_sec
    } else {
      payload.current_sec
    };
    let position_changed = !preserve_playhead
      && (previous_current_sec - next_current_sec).abs()
        > HORIZONTAL_BROWSE_LOOP_POSITION_EPSILON_SEC;
    let file_changed = !same_file;
    let was_master_tempo_active =
      horizontal_browse_transport_audio::should_use_master_tempo(self.deck(deck));

    {
      let target = self.deck_mut(deck);
      target.file_path = payload.file_path;
      target.title = payload.title;
      target.bpm = payload.bpm;
      target.first_beat_ms = payload.first_beat_ms;
      target.downbeat_beat_offset = payload
        .downbeat_beat_offset
        .filter(|value| value.is_finite())
        .and_then(HorizontalBrowseTransportEngine::normalize_downbeat_beat_offset);
      target.dynamic_beat_grid = HorizontalBrowseTransportEngine::normalize_dynamic_beat_grid(
        payload.beat_grid_clips,
        payload.duration_sec,
      );
      target.rekordbox_beat_grid_entries =
        HorizontalBrowseTransportEngine::normalize_rekordbox_beat_grid_entries(
          payload.rekordbox_beat_grid_entries,
        );
      target.time_basis_offset_ms = payload.time_basis_offset_ms;
      target.duration_sec = payload.duration_sec;
      target.current_sec = next_current_sec;
      target.last_observed_at_ms = if preserve_playhead {
        now_ms
      } else {
        payload.last_observed_at_ms
      };
      target.playing = payload.playing;
      target.playback_rate = Self::normalize_playback_rate(payload.playback_rate);
      target.master_tempo_enabled = payload.master_tempo_enabled;
      if next_file_path.is_empty() {
        target.cue_monitor_enabled = false;
        target.cue_monitor_gain = 0.0;
      }
      target.metronome_state.next_beat_index = None;
      if file_changed || payload.playing {
        target.scrub_preview.active = false;
        target.scrub_preview.rate = 0.0;
        if file_changed {
          target.scrub_preview.current_sec = 0.0;
          target.scrub_preview.level = 0.0;
        }
      }
      if file_changed || position_changed {
        horizontal_browse_transport_audio::reset_band_filter_state(target);
      }
    }

    self.sync_master_tempo_state_after_change(
      deck,
      was_master_tempo_active,
      file_changed || position_changed,
    );
  }

  pub(super) fn set_playback_rate(&mut self, deck: DeckId, now_ms: f64, playback_rate: f64) {
    self.mark_state_changed();
    self.last_now_ms = now_ms;
    self.sync_deck_to_now(deck, now_ms);
    let was_master_tempo_active =
      horizontal_browse_transport_audio::should_use_master_tempo(self.deck(deck));
    {
      let target = self.deck_mut(deck);
      target.playback_rate = Self::normalize_playback_rate(playback_rate);
    }
    self.sync_master_tempo_state_after_change(deck, was_master_tempo_active, false);
    // A tempo control changes speed, not the user's half/double BeatSync interpretation.
    // Re-resolving the multiplier on every drag event can flip 1x <-> 0.5x at a threshold and
    // redefine the follower grid without phase alignment.
    self.refresh_sync_state_preserving_bpm_multipliers(false);
  }

  pub(super) fn set_tempo_nudge_playback_rate(
    &mut self,
    deck: DeckId,
    now_ms: f64,
    playback_rate: f64,
  ) {
    self.mark_state_changed();
    self.last_now_ms = now_ms;
    self.sync_deck_to_now(deck, now_ms);
    let was_master_tempo_active =
      horizontal_browse_transport_audio::should_use_master_tempo(self.deck(deck));
    {
      let target = self.deck_mut(deck);
      target.playback_rate = Self::normalize_playback_rate(playback_rate);
    }
    let deck_index = Self::deck_index(deck);
    if self.sync_enabled[deck_index] && self.sync_lock[deck_index] != "off" {
      self.set_sync_lock(deck, "tempo-only");
    }
    self.sync_master_tempo_state_after_change(deck, was_master_tempo_active, false);
    self.recompute_distances();
  }

  pub(super) fn set_master_tempo_enabled(&mut self, deck: DeckId, now_ms: f64, enabled: bool) {
    self.mark_state_changed();
    self.last_now_ms = now_ms;
    self.sync_deck_to_now(deck, now_ms);
    let was_master_tempo_active =
      horizontal_browse_transport_audio::should_use_master_tempo(self.deck(deck));
    {
      let target = self.deck_mut(deck);
      target.master_tempo_enabled = enabled;
    }
    self.sync_master_tempo_state_after_change(deck, was_master_tempo_active, false);
  }

  pub(super) fn set_leader(&mut self, deck: Option<DeckId>) {
    self.mark_state_changed();
    self.leader = deck.filter(|candidate| self.is_loaded(*candidate));
    self.refresh();
  }

  pub(super) fn set_output_state(&mut self, crossfader_value: f64, master_gain: f64) {
    self.mark_state_changed();
    self.crossfader_value = Self::clamp_crossfader_value(crossfader_value);
    self.master_gain = Self::clamp_unit_gain(master_gain);
    self.refresh_output_gains();
  }

  pub(super) fn set_band_state(&mut self, deck: DeckId, bands: HorizontalBrowseTransportBandState) {
    self.mark_state_changed();
    let target = self.deck_mut(deck);
    target.band_state = bands;
    horizontal_browse_transport_audio::reset_band_filter_state(target);
  }

  pub(super) fn set_cue_monitor_enabled(&mut self, deck: DeckId, enabled: bool) {
    self.mark_state_changed();
    let target = self.deck_mut(deck);
    target.cue_monitor_enabled = enabled && !Self::normalized_path(&target.file_path).is_empty();
    self.refresh_output_gains();
  }

  pub(super) fn sync_loop_before_play(&mut self, deck: DeckId) {
    if !self.deck(deck).loop_active {
      return;
    }
    let loop_start_sec = self.deck(deck).loop_start_sec;
    let loop_end_sec = self.deck(deck).loop_end_sec;
    let current_sec = Self::estimate_current_sec(self.deck(deck), self.last_now_ms);
    if current_sec >= loop_start_sec + HORIZONTAL_BROWSE_LOOP_POSITION_EPSILON_SEC
      && current_sec < loop_end_sec - HORIZONTAL_BROWSE_LOOP_END_EPSILON_SEC
    {
      return;
    }
    let now_ms = self.last_now_ms;
    {
      let target = self.deck_mut(deck);
      target.current_sec = loop_start_sec;
      target.last_observed_at_ms = now_ms;
    }
    self.reset_and_prime_master_tempo_state(deck);
  }

  pub(super) fn set_playing(&mut self, deck: DeckId, now_ms: f64, playing: bool) {
    self.mark_state_changed();
    self.last_now_ms = now_ms;
    self.sync_deck_to_now(deck, now_ms);
    if playing && Self::estimate_current_sec(self.deck(deck), now_ms) >= 0.0 {
      self.sync_loop_before_play(deck);
    }
    {
      let target = self.deck_mut(deck);
      target.playing = playing;
      if playing {
        target.scrub_preview.active = false;
        target.scrub_preview.rate = 0.0;
      }
    }
    self.reset_and_prime_master_tempo_state(deck);
    self.refresh();
  }

  pub(super) fn set_audition_suspended(&mut self, now_ms: f64, suspended: bool) {
    if self.audition_suspended == suspended {
      return;
    }

    self.mark_state_changed();
    self.last_now_ms = now_ms;

    if suspended {
      // The output callback and this mutation share the engine mutex. Once this method
      // acquires it, both decks have completed the same output buffer. Rebase both at
      // the same external instant, then disable wall-clock estimation while frozen.
      for deck in [DeckId::Top, DeckId::Bottom] {
        self.sync_deck_to_now(deck, now_ms);
        self.deck_mut(deck).last_observed_at_ms = -1.0;
      }
    } else {
      // Loaded decks are advanced by the shared audio callback. Pending/unloaded decks
      // must remain at their requested position until audio is actually available.
      for deck in [DeckId::Top, DeckId::Bottom] {
        self.deck_mut(deck).last_observed_at_ms = -1.0;
      }
    }

    // Do not refresh BeatSync, elect a leader, or reset Master Tempo here. Those are
    // part of the frozen scene and must survive audition bit-for-bit.
    self.audition_suspended = suspended;
  }

  pub(super) fn seek(&mut self, deck: DeckId, now_ms: f64, current_sec: f64) {
    self.mark_state_changed();
    self.last_now_ms = now_ms;
    {
      let target = self.deck_mut(deck);
      target.current_sec = if !current_sec.is_finite() {
        0.0
      } else if target.duration_sec.is_finite() && target.duration_sec > 0.0 {
        current_sec.min(target.duration_sec)
      } else {
        current_sec
      };
      target.last_observed_at_ms = now_ms;
      target.metronome_state.next_beat_index = None;
      target.scrub_preview.active = false;
      target.scrub_preview.rate = 0.0;
      horizontal_browse_transport_audio::reset_band_filter_state(target);
    }
    self.reset_and_prime_master_tempo_state(deck);
    self.refresh();
  }

  pub(super) fn set_scrub_preview(
    &mut self,
    deck: DeckId,
    now_ms: f64,
    active: bool,
    current_sec: f64,
    rate: f64,
  ) {
    self.last_now_ms = now_ms;
    let target = self.deck_mut(deck);
    let duration_sec = target.duration_sec;
    let previous_active = target.scrub_preview.active;
    let previous_current_sec = target.scrub_preview.current_sec;
    target.scrub_preview.current_sec = if !current_sec.is_finite() {
      0.0
    } else if duration_sec.is_finite() && duration_sec > 0.0 {
      current_sec.min(duration_sec)
    } else {
      current_sec
    };
    target.scrub_preview.active = active;
    target.scrub_preview.rate = if active && rate.is_finite() {
      rate
    } else {
      0.0
    };
    if active
      && (!previous_active
        || (target.scrub_preview.current_sec - previous_current_sec).abs() > 0.05)
    {
      horizontal_browse_transport_audio::reset_band_filter_state(target);
    }
  }

  pub(super) fn set_metronome(&mut self, deck: DeckId, enabled: bool, volume_level: u8) {
    self.mark_state_changed();
    let target = self.deck_mut(deck);
    target.metronome_enabled = enabled;
    target.metronome_volume_level = volume_level.clamp(1, 3);
    if !enabled {
      target.metronome_state = MetronomeState::default();
      return;
    }
    target.metronome_state.next_beat_index = None;
  }

  pub(super) fn toggle_loop(&mut self, deck: DeckId, now_ms: f64) {
    self.mark_state_changed();
    self.last_now_ms = now_ms;
    self.sync_deck_to_now(deck, now_ms);
    if self.deck(deck).loop_active {
      self.deactivate_loop(deck);
      self.refresh();
      return;
    }
    let anchor_sec = if self.deck(deck).playing {
      Self::estimate_current_sec(self.deck(deck), now_ms)
    } else {
      self.deck(deck).current_sec
    };
    self.activate_loop_from_anchor(deck, anchor_sec);
    self.refresh();
  }

  pub(super) fn step_loop_beats_command(&mut self, deck: DeckId, direction: i32, now_ms: f64) {
    self.mark_state_changed();
    self.last_now_ms = now_ms;
    self.sync_deck_to_now(deck, now_ms);
    self.step_loop_beats(deck, direction);
    self.refresh();
  }

  pub(super) fn set_loop_from_range_command(&mut self, deck: DeckId, start_sec: f64, end_sec: f64) {
    self.mark_state_changed();
    self.set_loop_from_range(deck, start_sec, end_sec);
    self.refresh();
  }

  pub(super) fn clear_loop(&mut self, deck: DeckId) {
    self.mark_state_changed();
    self.deactivate_loop(deck);
    self.refresh();
  }

  pub(super) fn set_sync_enabled(&mut self, deck: DeckId, enabled: bool) {
    self.mark_state_changed();
    self.sync_deck_to_now(deck, self.last_now_ms);
    let index = Self::deck_index(deck);
    self.sync_enabled[index] = enabled;
    if !enabled {
      self.set_sync_lock(deck, "off");
      self.refresh_sync_state(false);
      return;
    }
    let leader = self.resolve_leader_candidate(deck);
    if self.leader != leader {
      self.leader = leader;
    }
    self.refresh_sync_state(false);
  }

  pub(super) fn beatsync(&mut self, deck: DeckId) {
    self.mark_state_changed();
    let Some(leader) = self.resolve_leader_candidate(deck) else {
      return;
    };
    if leader == deck {
      self.leader = Some(deck);
      self.sync_enabled[Self::deck_index(deck)] = true;
      self.set_sync_lock(deck, "full");
      self.refresh_sync_state(false);
      return;
    }
    self.leader = Some(leader);
    self.sync_enabled[Self::deck_index(deck)] = true;
    self.set_sync_lock(deck, "full");
    let now_ms = self.last_now_ms;
    let leader_index = Self::deck_index(leader);
    let deck_index = Self::deck_index(deck);
    self.bpm_multiplier[leader_index] = 1.0;
    let leader_effective_bpm = self.effective_bpm_for_deck(leader);
    self.bpm_multiplier[deck_index] = self.resolve_bpm_multiplier(deck, leader_effective_bpm);
    if let Some(target_grid) = self.beat_grid(deck) {
      let leader_current_sec = Self::estimate_current_sec(self.deck(leader), now_ms);
      let target_current_sec = Self::estimate_current_sec(self.deck(deck), now_ms);
      let target_duration_sec = self.deck(deck).duration_sec.max(0.0);
      let min_sec = Self::alignment_min_sec_for_anchor(target_current_sec, target_grid);
      let target_playback_rate = (leader_effective_bpm / target_grid.bpm).clamp(0.25, 4.0);
      let target_sec = self
        .nearest_valid_sec_matching_sync_phase(
          deck,
          target_current_sec,
          leader,
          leader_current_sec,
          min_sec,
          target_duration_sec,
        )
        .unwrap_or_else(|| target_current_sec.clamp(min_sec, target_duration_sec));
      let target = self.deck_mut(deck);
      target.current_sec = target_sec;
      target.last_observed_at_ms = now_ms;
      self.deck_mut(deck).playback_rate = target_playback_rate;
      self.reset_and_prime_master_tempo_state(deck);
    }
    self.refresh_sync_state(false);
  }

  pub(super) fn align_to_leader(
    &mut self,
    deck: DeckId,
    target_sec: Option<f64>,
    skip_grid_snap: bool,
  ) {
    self.mark_state_changed();
    let Some(leader) = self.resolve_leader_candidate(deck) else {
      return;
    };
    if leader == deck {
      self.leader = Some(deck);
      self.sync_enabled[Self::deck_index(deck)] = true;
      self.set_sync_lock(deck, "full");
      self.refresh_sync_state(false);
      return;
    }

    self.leader = Some(leader);
    self.sync_enabled[Self::deck_index(deck)] = true;
    self.set_sync_lock(deck, "full");

    let now_ms = self.last_now_ms;
    let leader_index = Self::deck_index(leader);
    let deck_index = Self::deck_index(deck);
    self.bpm_multiplier[leader_index] = 1.0;
    let leader_effective_bpm = self.effective_bpm_for_deck(leader);
    self.bpm_multiplier[deck_index] = self.resolve_bpm_multiplier(deck, leader_effective_bpm);

    if let Some(target_grid) = self.beat_grid(deck) {
      let target_playback_rate = (leader_effective_bpm / target_grid.bpm).clamp(0.25, 4.0);
      let snapped_sec = if !skip_grid_snap {
        let leader_current_sec = Self::estimate_current_sec(self.deck(leader), now_ms);
        let anchor_sec = target_sec
          .filter(|value| value.is_finite())
          .unwrap_or_else(|| Self::estimate_current_sec(self.deck(deck), now_ms));
        let target_duration_sec = self.deck(deck).duration_sec.max(0.0);
        let min_sec = Self::alignment_min_sec_for_anchor(anchor_sec, target_grid);
        self.nearest_valid_sec_matching_sync_phase(
          deck,
          anchor_sec,
          leader,
          leader_current_sec,
          min_sec,
          target_duration_sec,
        )
      } else {
        None
      };
      let target = self.deck_mut(deck);
      target.playback_rate = target_playback_rate;
      target.last_observed_at_ms = now_ms;
      target.metronome_state.next_beat_index = None;
      if let Some(sec) = snapped_sec {
        target.current_sec = sec;
      }
      self.reset_and_prime_master_tempo_state(deck);
    }

    self.refresh_sync_state(false);
  }
}
