use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use napi_derive::napi;
use rekordcrate::util::ColorIndex;

use crate::pioneer_anlz_raw;

#[napi(object)]
#[derive(Clone, Debug)]
pub struct PioneerHotCueRecord {
  pub slot: u32,
  pub label: String,
  pub time_sec: f64,
  pub is_loop: bool,
  pub loop_time_sec: Option<f64>,
  pub loop_numerator: Option<u32>,
  pub loop_denominator: Option<u32>,
  pub comment: Option<String>,
  pub color_index: Option<u32>,
  pub color_name: Option<String>,
  pub color_hex: Option<String>,
  pub source: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct PioneerMemoryCueRecord {
  pub time_sec: f64,
  pub is_loop: bool,
  pub loop_time_sec: Option<f64>,
  pub loop_numerator: Option<u32>,
  pub loop_denominator: Option<u32>,
  pub active_loop: Option<bool>,
  pub order: u32,
  pub comment: Option<String>,
  pub color_index: Option<u32>,
  pub color_name: Option<String>,
  pub color_hex: Option<String>,
  pub source: Option<String>,
}

#[napi(object)]
pub struct PioneerCueDump {
  pub analyze_file_path: String,
  pub cue_file_path: String,
  pub hot_cues: Vec<PioneerHotCueRecord>,
  pub memory_cues: Vec<PioneerMemoryCueRecord>,
  pub error: Option<String>,
}

#[derive(Clone)]
struct ScoredHotCue {
  record: PioneerHotCueRecord,
  score: u32,
}

#[derive(Clone)]
struct ScoredMemoryCue {
  record: PioneerMemoryCueRecord,
  score: u32,
  time_ms: u32,
  loop_time_ms: Option<u32>,
  active_state_score: Option<u32>,
}

const REKORDBOX_DEFAULT_HOT_CUE_HEX: &str = "#30d26e";

const REKORDBOX_HOT_CUE_COLORS: [&str; 63] = [
  REKORDBOX_DEFAULT_HOT_CUE_HEX,
  "#305aff",
  "#5073ff",
  "#508cff",
  "#50a0ff",
  "#50b4ff",
  "#50b0f2",
  "#50aee8",
  "#45acdb",
  "#00e0ff",
  "#19daf0",
  "#32d2e6",
  "#21b4b9",
  "#20aaa0",
  "#1fa392",
  "#19a08c",
  "#14a584",
  "#14aa7d",
  "#10b176",
  "#30d26e",
  "#37de5a",
  "#3ceb50",
  "#28e214",
  "#7dc13d",
  "#8cc832",
  "#9bd723",
  "#a5e116",
  "#a5dc0a",
  "#aad208",
  "#b4c805",
  "#b4be04",
  "#bab404",
  "#c3af04",
  "#e1aa00",
  "#ffa000",
  "#ff9600",
  "#ff8c00",
  "#ff7500",
  "#e0641b",
  "#e0461e",
  "#e0301e",
  "#e02823",
  "#e62828",
  "#ff376f",
  "#ff2d6f",
  "#ff127b",
  "#f51e8c",
  "#eb2da0",
  "#e637b4",
  "#de44cf",
  "#de448d",
  "#e630b4",
  "#e619dc",
  "#e600ff",
  "#dc00ff",
  "#cc00ff",
  "#b432ff",
  "#b93cff",
  "#c542ff",
  "#aa5aff",
  "#aa72ff",
  "#8272ff",
  "#6473ff",
];

fn build_empty_cue_dump(
  analyze_file_path: String,
  cue_file_path: String,
  error: impl Into<String>,
) -> PioneerCueDump {
  PioneerCueDump {
    analyze_file_path,
    cue_file_path,
    hot_cues: Vec::new(),
    memory_cues: Vec::new(),
    error: Some(error.into()),
  }
}

fn normalize_input_path(input_path: &str) -> String {
  input_path.trim().to_string()
}

fn build_pioneer_cue_candidates(input_path: &Path) -> Vec<PathBuf> {
  let mut candidates = Vec::new();
  let mut seen = HashSet::new();

  let push_unique = |path: PathBuf, acc: &mut Vec<PathBuf>, seen_set: &mut HashSet<String>| {
    let key = path.to_string_lossy().to_string();
    if seen_set.insert(key) {
      acc.push(path);
    }
  };

  let parsed = input_path.to_path_buf();
  let stem = parsed
    .file_stem()
    .map(|value| value.to_string_lossy().to_string());
  let parent = parsed.parent().map(|value| value.to_path_buf());

  if let (Some(parent), Some(stem)) = (parent.clone(), stem.clone()) {
    push_unique(
      parent.join(format!("{stem}.EXT")),
      &mut candidates,
      &mut seen,
    );
    push_unique(
      parent.join(format!("{stem}.DAT")),
      &mut candidates,
      &mut seen,
    );
    push_unique(
      parent.join(format!("{stem}.2EX")),
      &mut candidates,
      &mut seen,
    );
  }

  push_unique(parsed, &mut candidates, &mut seen);
  candidates
}

fn candidate_priority(candidate_path: &Path) -> u32 {
  match candidate_path
    .extension()
    .map(|value| value.to_string_lossy().to_ascii_uppercase())
    .unwrap_or_default()
    .as_str()
  {
    "2EX" => 300,
    "EXT" => 200,
    "DAT" => 100,
    _ => 0,
  }
}

fn seconds_from_millis(value: u32) -> f64 {
  f64::from(value) / 1000.0
}

fn normalize_comment(value: &str) -> Option<String> {
  if value.is_empty() {
    None
  } else {
    Some(value.to_string())
  }
}

fn decode_utf16be_string(bytes: &[u8]) -> Option<String> {
  if bytes.is_empty() || bytes.len() % 2 != 0 {
    return None;
  }
  let mut units = Vec::with_capacity(bytes.len() / 2);
  for chunk in bytes.chunks_exact(2) {
    let value = u16::from_be_bytes([chunk[0], chunk[1]]);
    if value == 0 {
      break;
    }
    units.push(value);
  }
  if units.is_empty() {
    None
  } else {
    String::from_utf16(&units)
      .ok()
      .and_then(|text| normalize_comment(&text))
  }
}

fn hot_cue_label(slot: u32) -> String {
  if slot < 26 {
    let ascii = b'A' + u8::try_from(slot).unwrap_or(0);
    char::from(ascii).to_string()
  } else {
    (slot + 1).to_string()
  }
}

fn memory_color_triplet(color: &ColorIndex) -> (Option<u32>, Option<String>, Option<String>) {
  match color {
    ColorIndex::None => (None, None, None),
    ColorIndex::Pink => (
      Some(1),
      Some("pink".to_string()),
      Some("#ff7ab6".to_string()),
    ),
    ColorIndex::Red => (
      Some(2),
      Some("red".to_string()),
      Some("#ff4b57".to_string()),
    ),
    ColorIndex::Orange => (
      Some(3),
      Some("orange".to_string()),
      Some("#ff9a3d".to_string()),
    ),
    ColorIndex::Yellow => (
      Some(4),
      Some("yellow".to_string()),
      Some("#ffd34d".to_string()),
    ),
    ColorIndex::Green => (
      Some(5),
      Some("green".to_string()),
      Some("#41d36f".to_string()),
    ),
    ColorIndex::Aqua => (
      Some(6),
      Some("aqua".to_string()),
      Some("#3fd7d3".to_string()),
    ),
    ColorIndex::Blue => (
      Some(7),
      Some("blue".to_string()),
      Some("#4a78ff".to_string()),
    ),
    ColorIndex::Purple => (
      Some(8),
      Some("purple".to_string()),
      Some("#c26bff".to_string()),
    ),
  }
}

fn hot_cue_color_triplet(
  color_index: u8,
  rgb: (u8, u8, u8),
) -> (Option<u32>, Option<String>, Option<String>) {
  let resolved_index = if color_index == 0 {
    None
  } else {
    Some(u32::from(color_index))
  };
  let resolved_hex = if rgb != (0, 0, 0) {
    Some(format!("#{:02x}{:02x}{:02x}", rgb.0, rgb.1, rgb.2))
  } else if usize::from(color_index) < REKORDBOX_HOT_CUE_COLORS.len() {
    Some(REKORDBOX_HOT_CUE_COLORS[usize::from(color_index)].to_string())
  } else {
    Some(REKORDBOX_DEFAULT_HOT_CUE_HEX.to_string())
  };
  (resolved_index, resolved_hex.clone(), resolved_hex)
}

fn extended_cue_style(content: &[u8]) -> Result<(Option<String>, u8, (u8, u8, u8)), String> {
  // Native older PCP2 entries can be 40/44 bytes, ending before an RGB block.
  // Their fixed payload is 24 bytes after the sixteen-byte entry header.
  if content.len() < 24 || (content.len() > 24 && content.len() < 28) {
    return Err("extended cue fixed payload is truncated".to_string());
  }
  if content.len() == 24 {
    return Ok((None, 0, (0, 0, 0)));
  }
  let len_comment = pioneer_anlz_raw::read_be_u32(&content[24..28])? as usize;
  if len_comment % 2 != 0 || len_comment > content.len() - 28 {
    return Err("extended cue comment is truncated or has invalid UTF16 length".to_string());
  }
  let comment_end = 28 + len_comment;
  let comment = decode_utf16be_string(&content[28..comment_end]);
  let suffix = &content[comment_end..];
  if suffix.is_empty() {
    return Ok((comment, 0, (0, 0, 0)));
  }
  if suffix.len() < 4 {
    return Err("extended cue RGB payload is truncated".to_string());
  }
  Ok((comment, suffix[0], (suffix[1], suffix[2], suffix[3])))
}

fn extended_loop_beats(content: &[u8], is_loop: bool) -> (Option<u32>, Option<u32>) {
  if !is_loop {
    return (None, None);
  }
  // PCP2 offsets 36/38 are BE u16 beat counts, including native 0/0 manual loops.
  // The parser has already checked its fixed 24-byte content before calling this.
  (
    Some(u32::from(u16::from_be_bytes([content[20], content[21]]))),
    Some(u32::from(u16::from_be_bytes([content[22], content[23]]))),
  )
}

fn score_hot_cue(record: &PioneerHotCueRecord, base_priority: u32, extended: bool) -> u32 {
  let mut score = base_priority;
  if extended {
    score += 1000;
  }
  if record.is_loop {
    score += 80;
  }
  if record.comment.is_some() {
    score += 40;
  }
  if record.color_hex.is_some() {
    score += 20;
  }
  score
}

fn score_memory_cue(record: &PioneerMemoryCueRecord, base_priority: u32, extended: bool) -> u32 {
  let mut score = base_priority;
  if extended {
    score += 1000;
  }
  if record.is_loop {
    score += 80;
  }
  if record.comment.is_some() {
    score += 40;
  }
  if record.color_hex.is_some() {
    score += 20;
  }
  score
}

fn merge_hot_cue(
  target: &mut HashMap<u32, ScoredHotCue>,
  candidate: PioneerHotCueRecord,
  score: u32,
) {
  let slot = candidate.slot;
  match target.get(&slot) {
    Some(existing) if existing.score >= score => {}
    _ => {
      target.insert(
        slot,
        ScoredHotCue {
          record: candidate,
          score,
        },
      );
    }
  }
}

fn merge_memory_cue(
  target: &mut HashMap<String, ScoredMemoryCue>,
  mut candidate: PioneerMemoryCueRecord,
  time_ms: u32,
  loop_time_ms: Option<u32>,
  score: u32,
) {
  let key = format!("{time_ms}:{}", loop_time_ms.unwrap_or(0));
  let active_state_score = candidate.active_loop.map(|_| score);
  match target.get_mut(&key) {
    Some(existing) if existing.score >= score => {
      // PCP2 has comments/colors but no active-loop status. A later PCPT record
      // must still enrich that selected extended record with its native status.
      if candidate.active_loop.is_some()
        && existing
          .active_state_score
          .map_or(true, |priority| score > priority)
      {
        existing.record.active_loop = candidate.active_loop;
        existing.active_state_score = active_state_score;
      }
    }
    _ => {
      let retained_state_score = target
        .get(&key)
        .and_then(|existing| existing.active_state_score);
      if let Some(existing) = target.get(&key) {
        if candidate.active_loop.is_none()
          || retained_state_score.is_some_and(|priority| priority >= score)
        {
          candidate.active_loop = existing.record.active_loop;
        }
      }
      let chosen_state_score = match (active_state_score, retained_state_score) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (left, right) => left.or(right),
      };
      target.insert(
        key,
        ScoredMemoryCue {
          record: candidate,
          score,
          time_ms,
          loop_time_ms,
          active_state_score: chosen_state_score,
        },
      );
    }
  }
}

fn parse_cues_from_file(
  candidate_path: &Path,
  hot_cues: &mut HashMap<u32, ScoredHotCue>,
  memory_cues: &mut HashMap<String, ScoredMemoryCue>,
) -> Result<bool, String> {
  let sections = pioneer_anlz_raw::read_pioneer_anlz_sections(candidate_path)
    .map_err(|error| format!("parse cue file failed: {error}"))?;
  let base_priority = candidate_priority(candidate_path);
  let mut did_parse_any_section = false;

  for section in sections {
    if pioneer_anlz_raw::section_kind_eq(&section, b"PCOB") {
      did_parse_any_section = true;
      if section.header_data.len() < 4 {
        continue;
      }
      let list_type = pioneer_anlz_raw::read_be_u32(&section.header_data[0..4])?;
      let nested = pioneer_anlz_raw::parse_nested_anlz_sections(&section.content)
        .map_err(|error| format!("parse cue list failed: {error}"))?;
      for (index, cue_section) in nested.iter().enumerate() {
        if !pioneer_anlz_raw::section_kind_eq(cue_section, b"PCPT") {
          continue;
        }
        if cue_section.header_data.len() < 16 || cue_section.content.len() < 12 {
          continue;
        }
        let hot_cue = pioneer_anlz_raw::read_be_u32(&cue_section.header_data[0..4])?;
        let time_ms = pioneer_anlz_raw::read_be_u32(&cue_section.content[4..8])?;
        let raw_loop_time = pioneer_anlz_raw::read_be_u32(&cue_section.content[8..12])?;
        let cue_type = cue_section.content[0];
        let loop_time_ms = if cue_type == 2 && raw_loop_time > time_ms {
          Some(raw_loop_time)
        } else {
          None
        };
        if list_type == 1 {
          if hot_cue == 0 {
            continue;
          }
          let slot = hot_cue.saturating_sub(1);
          let record = PioneerHotCueRecord {
            slot,
            label: hot_cue_label(slot),
            time_sec: seconds_from_millis(time_ms),
            is_loop: loop_time_ms.is_some(),
            loop_time_sec: loop_time_ms.map(seconds_from_millis),
            loop_numerator: None,
            loop_denominator: None,
            comment: None,
            color_index: None,
            color_name: None,
            color_hex: Some(REKORDBOX_DEFAULT_HOT_CUE_HEX.to_string()),
            source: Some("rekordbox".to_string()),
          };
          let score = score_hot_cue(&record, base_priority, false);
          merge_hot_cue(hot_cues, record, score);
        } else {
          let record = PioneerMemoryCueRecord {
            time_sec: seconds_from_millis(time_ms),
            is_loop: loop_time_ms.is_some(),
            loop_time_sec: loop_time_ms.map(seconds_from_millis),
            loop_numerator: None,
            loop_denominator: None,
            active_loop: Some(
              loop_time_ms.is_some()
                && pioneer_anlz_raw::read_be_u32(&cue_section.header_data[4..8])? == 4,
            ),
            order: u32::try_from(index).unwrap_or(u32::MAX),
            comment: None,
            color_index: None,
            color_name: None,
            color_hex: None,
            source: Some("rekordbox".to_string()),
          };
          let score = score_memory_cue(&record, base_priority, false);
          merge_memory_cue(memory_cues, record, time_ms, loop_time_ms, score);
        }
      }
      continue;
    }
    if pioneer_anlz_raw::section_kind_eq(&section, b"PCO2") {
      did_parse_any_section = true;
      if section.header_data.len() < 4 {
        continue;
      }
      let list_type = pioneer_anlz_raw::read_be_u32(&section.header_data[0..4])?;
      let nested = pioneer_anlz_raw::parse_nested_anlz_sections(&section.content)
        .map_err(|error| format!("parse extended cue list failed: {error}"))?;
      for (index, cue_section) in nested.iter().enumerate() {
        if !pioneer_anlz_raw::section_kind_eq(cue_section, b"PCP2") {
          continue;
        }
        if cue_section.header_data.len() < 4 || cue_section.content.len() < 24 {
          continue;
        }
        let hot_cue = pioneer_anlz_raw::read_be_u32(&cue_section.header_data[0..4])?;
        let cue_type = cue_section.content[0];
        let time_ms = pioneer_anlz_raw::read_be_u32(&cue_section.content[4..8])?;
        let raw_loop_time = pioneer_anlz_raw::read_be_u32(&cue_section.content[8..12])?;
        let loop_time_ms = if cue_type == 2 && raw_loop_time > time_ms {
          Some(raw_loop_time)
        } else {
          None
        };
        let (comment, hot_cue_color_index, hot_cue_color_rgb) =
          extended_cue_style(&cue_section.content)?;
        let (loop_numerator, loop_denominator) =
          extended_loop_beats(&cue_section.content, loop_time_ms.is_some());
        if list_type == 1 {
          if hot_cue == 0 {
            continue;
          }
          let slot = hot_cue.saturating_sub(1);
          let (color_index, color_name, color_hex) =
            hot_cue_color_triplet(hot_cue_color_index, hot_cue_color_rgb);
          let record = PioneerHotCueRecord {
            slot,
            label: hot_cue_label(slot),
            time_sec: seconds_from_millis(time_ms),
            is_loop: loop_time_ms.is_some(),
            loop_time_sec: loop_time_ms.map(seconds_from_millis),
            loop_numerator,
            loop_denominator,
            comment,
            color_index,
            color_name,
            color_hex,
            source: Some("rekordbox".to_string()),
          };
          let score = score_hot_cue(&record, base_priority, true);
          merge_hot_cue(hot_cues, record, score);
        } else {
          let memory_color = match cue_section.content[12] {
            1 => ColorIndex::Pink,
            2 => ColorIndex::Red,
            3 => ColorIndex::Orange,
            4 => ColorIndex::Yellow,
            5 => ColorIndex::Green,
            6 => ColorIndex::Aqua,
            7 => ColorIndex::Blue,
            8 => ColorIndex::Purple,
            _ => ColorIndex::None,
          };
          let (color_index, color_name, color_hex) = memory_color_triplet(&memory_color);
          let record = PioneerMemoryCueRecord {
            time_sec: seconds_from_millis(time_ms),
            is_loop: loop_time_ms.is_some(),
            loop_time_sec: loop_time_ms.map(seconds_from_millis),
            loop_numerator,
            loop_denominator,
            active_loop: None,
            order: u32::try_from(index).unwrap_or(u32::MAX),
            comment,
            color_index,
            color_name,
            color_hex,
            source: Some("rekordbox".to_string()),
          };
          let score = score_memory_cue(&record, base_priority, true);
          merge_memory_cue(memory_cues, record, time_ms, loop_time_ms, score);
        }
      }
    }
  }

  Ok(did_parse_any_section)
}

#[napi]
pub fn read_pioneer_cues(analyze_file_path: String) -> PioneerCueDump {
  let normalized_input = normalize_input_path(&analyze_file_path);
  if normalized_input.is_empty() {
    return build_empty_cue_dump(
      analyze_file_path,
      String::new(),
      "analyze_file_path is empty",
    );
  }

  let input_path = Path::new(&normalized_input);
  let candidates = build_pioneer_cue_candidates(input_path);
  let mut hot_cues = HashMap::new();
  let mut memory_cues = HashMap::new();
  let mut last_error: Option<String> = None;
  let mut cue_file_path = String::new();
  let mut parsed_any_file = false;

  for candidate in candidates {
    if !candidate.exists() {
      continue;
    }
    match parse_cues_from_file(&candidate, &mut hot_cues, &mut memory_cues) {
      Ok(did_parse_sections) => {
        if !did_parse_sections {
          continue;
        }
        parsed_any_file = true;
        if cue_file_path.is_empty() {
          cue_file_path = candidate.to_string_lossy().to_string();
        }
      }
      Err(error) => {
        last_error = Some(error);
      }
    }
  }

  if !parsed_any_file {
    return build_empty_cue_dump(
      normalized_input,
      cue_file_path,
      last_error.unwrap_or_else(|| "cue file not found".to_string()),
    );
  }

  let mut hot_cue_values = hot_cues
    .into_values()
    .map(|entry| entry.record)
    .collect::<Vec<_>>();
  hot_cue_values.sort_by(|left, right| left.slot.cmp(&right.slot));

  let mut memory_cue_values = memory_cues.into_values().collect::<Vec<_>>();
  memory_cue_values.sort_by(|left, right| {
    left
      .record
      .order
      .cmp(&right.record.order)
      .then(left.time_ms.cmp(&right.time_ms))
      .then(left.loop_time_ms.cmp(&right.loop_time_ms))
  });

  PioneerCueDump {
    analyze_file_path: normalized_input,
    cue_file_path,
    hot_cues: hot_cue_values,
    memory_cues: memory_cue_values
      .into_iter()
      .map(|entry| entry.record)
      .collect(),
    error: None,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn preserves_cue_comment_whitespace_for_editing() {
    assert_eq!(
      normalize_comment("  Native comment  ").as_deref(),
      Some("  Native comment  ")
    );
    assert_eq!(normalize_comment("  ").as_deref(), Some("  "));
    assert_eq!(normalize_comment(""), None);
    let encoded: Vec<u8> = "  中文  \0"
      .encode_utf16()
      .flat_map(u16::to_be_bytes)
      .collect();
    assert_eq!(decode_utf16be_string(&encoded).as_deref(), Some("  中文  "));
  }

  #[test]
  fn reads_native_rgb_before_palette_and_retains_zero_rgb_display_color() {
    let (index, _, color) = hot_cue_color_triplet(21, (0, 255, 0));
    assert_eq!(index, Some(21));
    assert_eq!(color.as_deref(), Some("#00ff00"));
    assert_eq!(
      hot_cue_color_triplet(21, (0, 0, 0)).2.as_deref(),
      Some("#3ceb50")
    );
    assert_eq!(
      hot_cue_color_triplet(0, (0, 0, 0)).2.as_deref(),
      Some(REKORDBOX_DEFAULT_HOT_CUE_HEX)
    );
  }

  #[test]
  fn accepts_compact_extended_entries_and_rejects_partial_optional_fields() {
    for length in [24, 28] {
      assert_eq!(
        extended_cue_style(&vec![0u8; length]).unwrap(),
        (None, 0, (0, 0, 0))
      );
    }
    for length in [23, 25, 26, 27, 29, 30, 31] {
      assert!(extended_cue_style(&vec![0u8; length]).is_err());
    }
    let mut comment_only = vec![0u8; 28];
    comment_only[24..28].copy_from_slice(&4u32.to_be_bytes());
    comment_only.extend("中\0".encode_utf16().flat_map(u16::to_be_bytes));
    assert_eq!(
      extended_cue_style(&comment_only).unwrap(),
      (Some("中".to_string()), 0, (0, 0, 0))
    );
    comment_only[24..28].copy_from_slice(&3u32.to_be_bytes());
    assert!(extended_cue_style(&comment_only).is_err());
  }

  #[test]
  fn compact_extended_cues_are_not_dropped_by_the_file_reader() {
    let entry = |hot_cue: u32, size: usize, start: u32, end: u32, memory_color: u8| {
      let mut data = vec![0u8; size];
      data[0..4].copy_from_slice(b"PCP2");
      data[4..8].copy_from_slice(&16u32.to_be_bytes());
      data[8..12].copy_from_slice(&(size as u32).to_be_bytes());
      data[12..16].copy_from_slice(&hot_cue.to_be_bytes());
      data[16] = if end > start && end != u32::MAX { 2 } else { 1 };
      data[18..20].copy_from_slice(&1000u16.to_be_bytes());
      data[20..24].copy_from_slice(&start.to_be_bytes());
      data[24..28].copy_from_slice(&end.to_be_bytes());
      data[28] = memory_color;
      data[36..38].copy_from_slice(&8u16.to_be_bytes());
      data[38..40].copy_from_slice(&1u16.to_be_bytes());
      data
    };
    let list = |hot: u32, point: Vec<u8>| {
      let mut data = vec![0u8; 20];
      data[0..4].copy_from_slice(b"PCO2");
      data[4..8].copy_from_slice(&20u32.to_be_bytes());
      data[8..12].copy_from_slice(&((20 + point.len()) as u32).to_be_bytes());
      data[12..16].copy_from_slice(&hot.to_be_bytes());
      data[16..18].copy_from_slice(&1u16.to_be_bytes());
      data.extend(point);
      data
    };
    let memory_list = list(0, entry(0, 44, 1000, 2000, 2));
    // Native point entries can retain a former loop's 8/1 fraction at offsets 36/38.
    let memory_point_list = list(0, entry(0, 44, 236, u32::MAX, 0));
    let hot_list = list(1, entry(1, 40, 3000, u32::MAX, 0));
    let hot_loop_list = list(1, entry(2, 40, 30029, 33340, 0));
    let mut document = vec![0u8; 12];
    document[0..4].copy_from_slice(b"PMAI");
    document[4..8].copy_from_slice(&12u32.to_be_bytes());
    document[8..12].copy_from_slice(
      &((12 + memory_list.len() + memory_point_list.len() + hot_list.len() + hot_loop_list.len())
        as u32)
        .to_be_bytes(),
    );
    document.extend(memory_list);
    document.extend(memory_point_list);
    document.extend(hot_list);
    document.extend(hot_loop_list);
    let temp_root = std::env::temp_dir();
    let unique = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap()
      .as_nanos();
    let file = temp_root.join(format!(
      "frkb-compact-cue-{}-{unique}.EXT",
      std::process::id()
    ));
    assert!(file.starts_with(&temp_root));
    std::fs::write(&file, document).unwrap();
    let mut hot = HashMap::new();
    let mut memory = HashMap::new();
    let result = parse_cues_from_file(&file, &mut hot, &mut memory);
    std::fs::remove_file(&file).unwrap();
    assert!(result.unwrap());
    assert_eq!(memory.len(), 2);
    let memory_point = &memory["236:0"].record;
    assert_eq!(memory_point.time_sec, 0.236);
    assert!(!memory_point.is_loop);
    assert_eq!(memory_point.loop_time_sec, None);
    assert_eq!(memory_point.loop_numerator, None);
    assert_eq!(memory_point.loop_denominator, None);
    assert_eq!(memory["1000:2000"].record.loop_numerator, Some(8));
    assert_eq!(memory["1000:2000"].record.loop_denominator, Some(1));
    assert_eq!(memory["1000:2000"].record.color_index, Some(2));
    assert_eq!(
      memory["1000:2000"].record.color_hex.as_deref(),
      Some("#ff4b57")
    );
    assert_eq!(hot.len(), 2);
    assert_eq!(
      hot[&0].record.color_hex.as_deref(),
      Some(REKORDBOX_DEFAULT_HOT_CUE_HEX)
    );
    assert_eq!(hot[&0].record.time_sec, 3.0);
    assert!(!hot[&0].record.is_loop);
    assert_eq!(hot[&0].record.loop_time_sec, None);
    assert_eq!(hot[&0].record.loop_numerator, None);
    assert_eq!(hot[&0].record.loop_denominator, None);
    assert_eq!(hot[&1].record.time_sec, 30.029);
    assert_eq!(hot[&1].record.loop_time_sec, Some(33.34));
    assert_eq!(hot[&1].record.loop_numerator, Some(8));
    assert_eq!(hot[&1].record.loop_denominator, Some(1));
    let extended = hot.remove(&1).unwrap();
    for extended_first in [false, true] {
      let mut records = HashMap::new();
      let mut legacy = extended.record.clone();
      legacy.loop_numerator = None;
      legacy.loop_denominator = None;
      let ordered = if extended_first {
        [(extended.record.clone(), extended.score), (legacy, 200)]
      } else {
        [(legacy, 200), (extended.record.clone(), extended.score)]
      };
      for (record, score) in ordered {
        merge_hot_cue(&mut records, record, score);
      }
      assert_eq!(records[&1].record.loop_numerator, Some(8));
      assert_eq!(records[&1].record.loop_denominator, Some(1));
    }
  }

  #[test]
  fn extended_manual_loops_preserve_zero_fraction_and_points_omit_it() {
    let mut content = vec![0u8; 24];
    assert_eq!(extended_loop_beats(&content, true), (Some(0), Some(0)));
    content[20..22].copy_from_slice(&8u16.to_be_bytes());
    content[22..24].copy_from_slice(&1u16.to_be_bytes());
    assert_eq!(extended_loop_beats(&content, true), (Some(8), Some(1)));
    assert_eq!(extended_loop_beats(&content, false), (None, None));
  }

  fn memory_record(active_loop: Option<bool>, comment: Option<&str>) -> PioneerMemoryCueRecord {
    PioneerMemoryCueRecord {
      time_sec: 1.0,
      is_loop: true,
      loop_time_sec: Some(2.0),
      loop_numerator: None,
      loop_denominator: None,
      active_loop,
      order: 0,
      comment: comment.map(str::to_string),
      color_index: Some(2),
      color_name: Some("Red".to_string()),
      color_hex: Some("#ff0000".to_string()),
      source: Some("rekordbox".to_string()),
    }
  }

  #[test]
  fn memory_active_status_survives_extended_metadata_in_both_parse_orders() {
    for extended_first in [false, true] {
      let mut records = HashMap::new();
      let legacy = memory_record(Some(true), None);
      let mut extended = memory_record(None, Some("Native comment"));
      extended.loop_numerator = Some(8);
      extended.loop_denominator = Some(1);
      let ordered = if extended_first {
        [(extended, 1200), (legacy, 200)]
      } else {
        [(legacy, 200), (extended, 1200)]
      };
      for (record, score) in ordered {
        merge_memory_cue(&mut records, record, 1000, Some(2000), score);
      }
      let selected = &records["1000:2000"].record;
      assert_eq!(selected.active_loop, Some(true));
      assert_eq!(selected.comment.as_deref(), Some("Native comment"));
      assert_eq!(selected.color_hex.as_deref(), Some("#ff0000"));
      assert_eq!(selected.loop_numerator, Some(8));
      assert_eq!(selected.loop_denominator, Some(1));
    }
  }

  #[test]
  fn active_status_uses_native_source_priority_independently_of_metadata_score() {
    let mut records = HashMap::new();
    merge_memory_cue(
      &mut records,
      memory_record(Some(false), None),
      1000,
      Some(2000),
      200,
    );
    merge_memory_cue(
      &mut records,
      memory_record(None, Some("Extended")),
      1000,
      Some(2000),
      1200,
    );
    merge_memory_cue(
      &mut records,
      memory_record(Some(true), None),
      1000,
      Some(2000),
      100,
    );
    assert_eq!(records["1000:2000"].record.active_loop, Some(false));
    assert_eq!(
      records["1000:2000"].record.comment.as_deref(),
      Some("Extended")
    );
  }

  #[test]
  fn legacy_pcpt_status_is_read_from_native_offset_16() {
    let mut entry = vec![0u8; 56];
    entry[0..4].copy_from_slice(b"PCPT");
    entry[4..8].copy_from_slice(&28u32.to_be_bytes());
    entry[8..12].copy_from_slice(&56u32.to_be_bytes());
    entry[16..20].copy_from_slice(&4u32.to_be_bytes());
    entry[20..24].copy_from_slice(&0x10000u32.to_be_bytes());
    entry[24..28].fill(0xff);
    entry[28] = 2;
    entry[30..32].copy_from_slice(&1000u16.to_be_bytes());
    entry[32..36].copy_from_slice(&1000u32.to_be_bytes());
    entry[36..40].copy_from_slice(&2000u32.to_be_bytes());
    let mut list = vec![0u8; 24];
    list[0..4].copy_from_slice(b"PCOB");
    list[4..8].copy_from_slice(&24u32.to_be_bytes());
    list[8..12].copy_from_slice(&80u32.to_be_bytes());
    list[18..20].copy_from_slice(&1u16.to_be_bytes());
    list.extend(entry);
    let mut document = vec![0u8; 12];
    document[0..4].copy_from_slice(b"PMAI");
    document[4..8].copy_from_slice(&12u32.to_be_bytes());
    document[8..12].copy_from_slice(&92u32.to_be_bytes());
    document.extend(list);
    let temp_root = std::env::temp_dir();
    let unique = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap()
      .as_nanos();
    let file = temp_root.join(format!(
      "frkb-native-memory-cue-{}-{unique}.DAT",
      std::process::id()
    ));
    assert!(file.starts_with(&temp_root));
    std::fs::write(&file, document).unwrap();
    let mut hot = HashMap::new();
    let mut memory = HashMap::new();
    let result = parse_cues_from_file(&file, &mut hot, &mut memory);
    std::fs::remove_file(&file).unwrap();
    assert!(result.unwrap());
    assert_eq!(memory["1000:2000"].record.active_loop, Some(true));
    assert_eq!(memory["1000:2000"].record.loop_numerator, None);
    assert_eq!(memory["1000:2000"].record.loop_denominator, None);
  }
}
