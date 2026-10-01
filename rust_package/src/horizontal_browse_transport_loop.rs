use super::*;

impl HorizontalBrowseTransportEngine {
  pub(super) fn sync_loop_range_for_deck(&mut self, deck: DeckId) -> bool {
    // Explicit ranges retain their audio positions when the beat grid is refreshed.
    if self.deck(deck).loop_exact_beat_sec.is_some() {
      let start_sec = self.deck(deck).loop_start_sec;
      let end_sec = self.deck(deck).loop_end_sec;
      return self.sync_exact_loop_range(deck, start_sec, end_sec);
    }
    let start_beat_index = self.deck(deck).loop_start_beat_index;
    let beat_value = self.deck(deck).loop_beat_value;
    let Some(start_beat_index) = start_beat_index else {
      let target = self.deck_mut(deck);
      target.loop_active = false;
      target.loop_start_sec = 0.0;
      target.loop_end_sec = 0.0;
      return false;
    };
    let Some(grid) = self.original_beat_grid(deck) else {
      let target = self.deck_mut(deck);
      target.loop_active = false;
      target.loop_start_beat_index = None;
      target.loop_start_sec = 0.0;
      target.loop_end_sec = 0.0;
      return false;
    };
    let duration_sec = self.deck(deck).duration_sec.max(0.0);
    let raw_start_sec = grid.first_beat_sec + start_beat_index as f64 * grid.beat_sec;
    let raw_end_sec = raw_start_sec + beat_value.max(0.0) * grid.beat_sec;
    let clamped_start_sec = if raw_end_sec <= 0.0 {
      0.0
    } else {
      raw_start_sec.clamp(0.0, duration_sec)
    };
    let clamped_end_sec = if raw_end_sec <= 0.0 {
      (beat_value.max(0.0) * grid.beat_sec).clamp(0.0, duration_sec)
    } else {
      raw_end_sec.clamp(clamped_start_sec, duration_sec)
    };
    if !clamped_end_sec.is_finite()
      || clamped_end_sec - clamped_start_sec <= HORIZONTAL_BROWSE_LOOP_POSITION_EPSILON_SEC
    {
      let target = self.deck_mut(deck);
      target.loop_active = false;
      target.loop_start_beat_index = None;
      target.loop_start_sec = 0.0;
      target.loop_end_sec = 0.0;
      return false;
    }
    let target = self.deck_mut(deck);
    target.loop_active = true;
    target.loop_start_sec = clamped_start_sec;
    target.loop_end_sec = clamped_end_sec;
    true
  }

  pub(super) fn deactivate_loop(&mut self, deck: DeckId) {
    let target = self.deck_mut(deck);
    target.loop_active = false;
    target.loop_start_beat_index = None;
    target.loop_exact_beat_sec = None;
    target.loop_start_sec = 0.0;
    target.loop_end_sec = 0.0;
  }

  pub(super) fn activate_loop_from_anchor(&mut self, deck: DeckId, anchor_sec: f64) -> bool {
    let Some(grid) = self.original_beat_grid(deck) else {
      self.deactivate_loop(deck);
      return false;
    };
    let beats_from_first = (anchor_sec - grid.first_beat_sec) / grid.beat_sec;
    if !beats_from_first.is_finite() {
      self.deactivate_loop(deck);
      return false;
    }
    let start_beat_index =
      (beats_from_first + HORIZONTAL_BROWSE_LOOP_BEAT_INDEX_EPSILON).floor() as i32;
    {
      let target = self.deck_mut(deck);
      target.loop_active = true;
      target.loop_start_beat_index = Some(start_beat_index);
      target.loop_exact_beat_sec = None;
      target.loop_beat_value = if target.loop_beat_value.is_finite() && target.loop_beat_value > 0.0
      {
        target.loop_beat_value
      } else {
        HORIZONTAL_BROWSE_LOOP_DEFAULT_BEAT_VALUE
      };
    }
    self.sync_loop_range_for_deck(deck)
  }

  pub(super) fn resolve_loop_beat_value_index(value: f64) -> usize {
    let exact = HORIZONTAL_BROWSE_LOOP_BEAT_VALUES
      .iter()
      .position(|candidate| (*candidate - value).abs() <= 1e-9);
    if let Some(index) = exact {
      return index;
    }
    HORIZONTAL_BROWSE_LOOP_BEAT_VALUES
      .iter()
      .position(|candidate| *candidate >= value)
      .unwrap_or(HORIZONTAL_BROWSE_LOOP_BEAT_VALUES.len() - 1)
  }

  pub(super) fn step_loop_beats(&mut self, deck: DeckId, direction: i32) {
    let current_value = self.deck(deck).loop_beat_value;
    let current_index = Self::resolve_loop_beat_value_index(current_value);
    let next_index = (current_index as i32 + direction)
      .clamp(0, HORIZONTAL_BROWSE_LOOP_BEAT_VALUES.len() as i32 - 1) as usize;
    let next_beat_value = HORIZONTAL_BROWSE_LOOP_BEAT_VALUES[next_index];
    {
      let target = self.deck_mut(deck);
      target.loop_beat_value = next_beat_value;
      if !target.loop_active {
        return;
      }
      if let Some(beat_sec) = target.loop_exact_beat_sec {
        target.loop_end_sec = target.loop_start_sec + next_beat_value * beat_sec;
      }
    }
    if !self.sync_loop_range_for_deck(deck) {
      self.deactivate_loop(deck);
      return;
    }
    if self.deck(deck).playing {
      let current_sec = Self::estimate_current_sec(self.deck(deck), self.last_now_ms);
      let loop_start_sec = self.deck(deck).loop_start_sec;
      let loop_end_sec = self.deck(deck).loop_end_sec;
      let duration_sec = (loop_end_sec - loop_start_sec).max(0.0);
      let has_reached_later_half = current_sec
        >= loop_start_sec + duration_sec * 0.5 - HORIZONTAL_BROWSE_LOOP_POSITION_EPSILON_SEC;
      if current_sec < loop_start_sec + HORIZONTAL_BROWSE_LOOP_POSITION_EPSILON_SEC
        || current_sec >= loop_end_sec - HORIZONTAL_BROWSE_LOOP_END_EPSILON_SEC
        || has_reached_later_half
      {
        let now_ms = self.last_now_ms;
        {
          let target = self.deck_mut(deck);
          target.current_sec = loop_start_sec;
          target.last_observed_at_ms = now_ms;
        }
        self.reset_and_prime_master_tempo_state(deck);
      }
    }
  }

  fn sync_exact_loop_range(&mut self, deck: DeckId, start_sec: f64, end_sec: f64) -> bool {
    let duration_sec = self.deck(deck).duration_sec.max(0.0);
    if !start_sec.is_finite() || !end_sec.is_finite() {
      self.deactivate_loop(deck);
      return false;
    }
    let start_sec = start_sec.clamp(0.0, duration_sec);
    let end_sec = end_sec.clamp(0.0, duration_sec);
    if end_sec - start_sec <= HORIZONTAL_BROWSE_LOOP_POSITION_EPSILON_SEC {
      self.deactivate_loop(deck);
      return false;
    }
    let target = self.deck_mut(deck);
    target.loop_active = true;
    target.loop_start_sec = start_sec;
    target.loop_end_sec = end_sec;
    true
  }

  pub(super) fn set_loop_from_range(
    &mut self,
    deck: DeckId,
    start_sec: f64,
    end_sec: f64,
    preserve_exact_range: bool,
  ) -> bool {
    let grid = if preserve_exact_range {
      self.original_beat_grid_at_sec(deck, start_sec)
    } else {
      self.original_beat_grid(deck)
    };
    let Some(grid) = grid else {
      self.deactivate_loop(deck);
      return false;
    };
    let duration_sec = end_sec - start_sec;
    if !start_sec.is_finite()
      || !end_sec.is_finite()
      || !duration_sec.is_finite()
      || duration_sec <= HORIZONTAL_BROWSE_LOOP_POSITION_EPSILON_SEC
    {
      self.deactivate_loop(deck);
      return false;
    }
    let start_beat_index = ((start_sec - grid.first_beat_sec) / grid.beat_sec).round() as i32;
    let raw_beat_value = duration_sec / grid.beat_sec;
    if !raw_beat_value.is_finite() || raw_beat_value <= 0.0 {
      self.deactivate_loop(deck);
      return false;
    }
    let nearest_beat_value = HORIZONTAL_BROWSE_LOOP_BEAT_VALUES
      .iter()
      .copied()
      .min_by(|left, right| {
        (left - raw_beat_value)
          .abs()
          .partial_cmp(&(right - raw_beat_value).abs())
          .unwrap_or(std::cmp::Ordering::Equal)
      })
      .unwrap_or(HORIZONTAL_BROWSE_LOOP_DEFAULT_BEAT_VALUE);
    {
      let target = self.deck_mut(deck);
      target.loop_active = true;
      target.loop_start_beat_index = Some(start_beat_index);
      target.loop_beat_value = nearest_beat_value;
      target.loop_exact_beat_sec = if preserve_exact_range {
        Some(duration_sec / nearest_beat_value)
      } else {
        None
      };
    }
    if preserve_exact_range {
      return self.sync_exact_loop_range(deck, start_sec, end_sec);
    }
    self.sync_loop_range_for_deck(deck)
  }
}
