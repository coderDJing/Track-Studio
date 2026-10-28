use super::*;

pub(super) struct DeckOutputFrame {
  pub(super) program: (f32, f32),
  pub(super) monitor: (f32, f32),
  pub(super) metronome: f32,
}

impl HorizontalBrowseTransportEngine {
  pub(super) fn render_output_buffer<T: cpal::SizedSample + cpal::FromSample<f32>>(
    &mut self,
    data: &mut [T],
    channels: usize,
  ) {
    for frame in data.chunks_mut(channels) {
      let (left, right) = self.mix_output_frame();
      if let Some(sample) = frame.get_mut(0) {
        *sample = T::from_sample(left);
      }
      if channels >= 2 {
        if let Some(sample) = frame.get_mut(1) {
          *sample = T::from_sample(right);
        }
        for channel in 2..channels {
          if let Some(sample) = frame.get_mut(channel) {
            *sample = T::from_sample((left + right) * 0.5);
          }
        }
      }
    }
    self.handover_finished_master_after_output();
  }

  fn handover_finished_master_after_output(&mut self) {
    if self.audition_suspended {
      return;
    }
    let Some(master) = self.leader else {
      return;
    };
    let master_state = self.deck(master);
    let finished = master_state.playing
      && Self::effective_track_end_sec(master_state)
        .is_some_and(|end_sec| master_state.current_sec >= end_sec);
    if !finished || !self.is_playing_audible_at(master.other(), self.last_now_ms) {
      return;
    }
    self.refresh_sync_state(false);
    if self.leader != Some(master) {
      self.mark_state_changed();
    }
  }

  #[cfg(test)]
  pub(super) fn sample_deck(&mut self, deck: DeckId) -> ((f32, f32), f32) {
    let deck_output = self.sample_deck_mix(deck);
    (deck_output.program, deck_output.metronome)
  }

  pub(super) fn sample_deck_mix(&mut self, deck: DeckId) -> DeckOutputFrame {
    let output_sample_rate = self.output_sample_rate.max(1) as f64;
    self.smooth_dynamic_sync_playback_rate(deck, output_sample_rate);
    self.advance_auto_gain(deck, output_sample_rate);
    self.refresh_output_gains();
    let before_sec = self.deck(deck).current_sec;
    let was_playing = self.deck(deck).playing;
    let scrub_rendering =
      horizontal_browse_transport_audio::is_scrub_preview_rendering(self.deck(deck));
    let (deck_left, deck_right) = {
      let target = self.deck_mut(deck);
      let (raw_left, raw_right) =
        horizontal_browse_transport_audio::sample_deck(target, output_sample_rate);
      horizontal_browse_transport_audio::apply_band_filter(
        target,
        raw_left,
        raw_right,
        output_sample_rate,
      )
    };
    let after_sec = self.deck(deck).current_sec;
    let program_gain = self.deck(deck).gain;
    let monitor_gain = self.deck(deck).cue_monitor_gain;
    let metronome = if scrub_rendering {
      0.0
    } else {
      self.sample_metronome(deck, before_sec, after_sec, was_playing) * program_gain
    };
    DeckOutputFrame {
      program: (deck_left * program_gain, deck_right * program_gain),
      monitor: (deck_left * monitor_gain, deck_right * monitor_gain),
      metronome,
    }
  }
}
