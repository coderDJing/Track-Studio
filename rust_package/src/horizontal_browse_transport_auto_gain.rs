use super::*;

pub(super) const AUTO_GAIN_STATUS_OFF: &str = "off";
pub(super) const AUTO_GAIN_STATUS_ACTIVE: &str = "active";
pub(super) const AUTO_GAIN_STATUS_MASTER: &str = "master";
pub(super) const AUTO_GAIN_STATUS_PENDING: &str = "pending";
pub(super) const AUTO_GAIN_STATUS_UNAVAILABLE: &str = "unavailable";

const AUTO_GAIN_MAX_BOOST_DB: f64 = 16.0;
const AUTO_GAIN_MIN_GAIN_DB: f64 = -60.0;
const AUTO_GAIN_PEAK_LIMIT_DBFS: f64 = -1.0;
const AUTO_GAIN_LOUDNESS_FLOOR_DB: f64 = -70.0;
const AUTO_GAIN_EPSILON: f64 = 1e-9;
const AUTO_GAIN_SMOOTHING_SEC: f64 = 0.12;

#[derive(Clone, Copy)]
pub(super) struct LoudnessAnalysis {
  pub(super) integrated_db: f64,
  pub(super) peak_db: f64,
}

#[derive(Clone, Copy)]
pub(super) struct DeckAutoGainState {
  pub(super) enabled: bool,
  pub(super) status: &'static str,
  pub(super) current_linear: f32,
  pub(super) target_linear: f32,
}

impl Default for DeckAutoGainState {
  fn default() -> Self {
    Self {
      enabled: true,
      status: AUTO_GAIN_STATUS_PENDING,
      current_linear: 1.0,
      target_linear: 1.0,
    }
  }
}

pub(super) fn analyze_loudness(samples: &[f32], channels: u16) -> Option<LoudnessAnalysis> {
  let channel_count = channels.max(1) as usize;
  let frame_count = samples.len() / channel_count;
  if frame_count == 0 {
    return None;
  }

  let mut total_energy = 0.0_f64;
  let mut peak = 0.0_f64;
  for frame in 0..frame_count {
    let base = frame * channel_count;
    let mut frame_energy = 0.0_f64;
    for channel in 0..channel_count {
      let sample = samples.get(base + channel).copied().unwrap_or(0.0) as f64;
      frame_energy += sample * sample;
      peak = peak.max(sample.abs());
    }
    total_energy += frame_energy / channel_count as f64;
  }

  let mean_square = total_energy / frame_count as f64;
  let integrated_db =
    (10.0 * mean_square.max(AUTO_GAIN_EPSILON).log10()).max(AUTO_GAIN_LOUDNESS_FLOOR_DB);
  let peak_db = 20.0 * peak.max(AUTO_GAIN_EPSILON).log10();
  if !integrated_db.is_finite() || !peak_db.is_finite() {
    return None;
  }
  Some(LoudnessAnalysis {
    integrated_db,
    peak_db,
  })
}

fn db_to_linear(db: f64) -> f32 {
  10.0_f64.powf(db / 20.0) as f32
}

fn linear_to_db(value: f32) -> f64 {
  20.0 * (value as f64).max(AUTO_GAIN_EPSILON).log10()
}

fn normalize_auto_gain_linear(value: f32) -> f32 {
  if !value.is_finite() {
    return 1.0;
  }
  let max_linear = db_to_linear(AUTO_GAIN_MAX_BOOST_DB);
  value.clamp(0.0, max_linear)
}

fn resolve_aligned_gain(reference_integrated_db: f64, target: LoudnessAnalysis) -> f32 {
  let desired_db = reference_integrated_db - target.integrated_db;
  let peak_cap_db = AUTO_GAIN_PEAK_LIMIT_DBFS - target.peak_db;
  let gain_db = desired_db
    .min(AUTO_GAIN_MAX_BOOST_DB)
    .min(peak_cap_db)
    .max(AUTO_GAIN_MIN_GAIN_DB);
  db_to_linear(gain_db)
}

impl HorizontalBrowseTransportEngine {
  pub(super) fn deck_file_will_change(
    &self,
    deck: DeckId,
    next_file_path: &Option<String>,
  ) -> bool {
    let current = self
      .deck(deck)
      .file_path
      .as_deref()
      .map(str::trim)
      .unwrap_or("");
    let next = next_file_path.as_deref().map(str::trim).unwrap_or("");
    current != next
  }

  pub(super) fn reset_deck_auto_gain_for_file_change(&mut self, deck: DeckId) {
    let target = self.deck_mut(deck);
    target.loudness_analysis = None;
    target.loudness_failed = false;
    target.auto_gain.current_linear = 1.0;
    target.auto_gain.target_linear = 1.0;
    target.auto_gain.status = if target.auto_gain.enabled {
      AUTO_GAIN_STATUS_PENDING
    } else {
      AUTO_GAIN_STATUS_OFF
    };
    self.refresh_output_gains();
  }

  pub(super) fn set_deck_loudness_result(
    &mut self,
    deck: DeckId,
    file_path: &str,
    analysis: Option<LoudnessAnalysis>,
  ) {
    let current = self
      .deck(deck)
      .file_path
      .as_deref()
      .map(str::trim)
      .unwrap_or("");
    if !crate::file_path_comparison::same_file_path(current, file_path) {
      return;
    }
    let target = self.deck_mut(deck);
    target.loudness_analysis = analysis;
    target.loudness_failed = analysis.is_none();
    self.mark_state_changed();
    self.refresh_auto_gain();
  }

  pub(super) fn set_auto_gain_enabled(&mut self, deck: DeckId, enabled: bool) {
    let target = self.deck_mut(deck);
    if target.auto_gain.enabled == enabled {
      return;
    }
    target.auto_gain.enabled = enabled;
    self.mark_state_changed();
    self.refresh_auto_gain();
  }

  fn resolve_reference_loudness_db(&self, deck: DeckId) -> Option<f64> {
    let target = self.deck(deck);
    if target.loudness_failed {
      return None;
    }
    let analysis = target.loudness_analysis?;
    let reference_gain = if target.auto_gain.enabled {
      target.auto_gain.current_linear
    } else {
      1.0
    };
    Some(analysis.integrated_db + linear_to_db(reference_gain))
  }

  fn set_auto_gain_target(
    &mut self,
    deck: DeckId,
    target_linear: f32,
    status: &'static str,
  ) -> bool {
    let safe_target = normalize_auto_gain_linear(target_linear);
    let target = self.deck_mut(deck);
    let changed = target.auto_gain.status != status
      || (target.auto_gain.target_linear - safe_target).abs() > 0.00001;
    target.auto_gain.status = status;
    target.auto_gain.target_linear = safe_target;
    if !target.playing {
      target.auto_gain.current_linear = safe_target;
    }
    changed
  }

  pub(super) fn refresh_auto_gain(&mut self) {
    let leader = self.leader;
    let reference_db = leader.and_then(|deck| self.resolve_reference_loudness_db(deck));
    let mut changed = false;
    for deck in [DeckId::Top, DeckId::Bottom] {
      let deck_state = self.deck(deck);
      if !deck_state.auto_gain.enabled {
        changed |= self.set_auto_gain_target(deck, 1.0, AUTO_GAIN_STATUS_OFF);
        continue;
      }
      if deck_state.loudness_failed {
        changed |= self.set_auto_gain_target(deck, 1.0, AUTO_GAIN_STATUS_UNAVAILABLE);
        continue;
      }
      let Some(analysis) = deck_state.loudness_analysis else {
        changed |= self.set_auto_gain_target(deck, 1.0, AUTO_GAIN_STATUS_PENDING);
        continue;
      };
      if leader == Some(deck) {
        let preserved_gain = self.deck(deck).auto_gain.current_linear;
        changed |= self.set_auto_gain_target(deck, preserved_gain, AUTO_GAIN_STATUS_MASTER);
        continue;
      }
      let Some(reference_integrated_db) = reference_db else {
        changed |= self.set_auto_gain_target(deck, 1.0, AUTO_GAIN_STATUS_PENDING);
        continue;
      };
      let gain = resolve_aligned_gain(reference_integrated_db, analysis);
      changed |= self.set_auto_gain_target(deck, gain, AUTO_GAIN_STATUS_ACTIVE);
    }
    if changed {
      self.mark_state_changed();
    }
    self.refresh_output_gains();
  }

  pub(super) fn advance_auto_gain(&mut self, deck: DeckId, output_sample_rate: f64) {
    let sample_rate = output_sample_rate.max(1.0);
    let smoothing_frames = (AUTO_GAIN_SMOOTHING_SEC * sample_rate).max(1.0);
    let coefficient = 1.0 - (-1.0 / smoothing_frames).exp();
    let target = self.deck_mut(deck);
    let diff = target.auto_gain.target_linear - target.auto_gain.current_linear;
    if diff.abs() <= 0.00001 {
      target.auto_gain.current_linear = target.auto_gain.target_linear;
      return;
    }
    target.auto_gain.current_linear += diff * coefficient as f32;
  }
}
