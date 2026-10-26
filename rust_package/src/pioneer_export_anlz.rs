use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::result::Result as StdResult;

use super::{
  PioneerBeatGridDump, PioneerBeatGridEntry, PioneerDetailWaveformColumn,
  PioneerDetailWaveformDump, PioneerPreviewWaveformColumn, PioneerPreviewWaveformDump,
};
use crate::pioneer_anlz_raw;
fn build_pioneer_preview_waveform_candidates(input_path: &Path) -> Vec<PathBuf> {
  let mut candidates = Vec::new();
  let mut seen = HashSet::new();
  let mut push_unique = |path: PathBuf| {
    let key = crate::file_path_comparison::file_path_key(&path.to_string_lossy());
    if seen.insert(key) {
      candidates.push(path);
    }
  };

  let normalized = input_path.to_path_buf();
  let ext = normalized
    .extension()
    .and_then(|value| value.to_str())
    .map(|value| value.to_ascii_lowercase())
    .unwrap_or_default();

  if ext == "dat" || ext == "ext" || ext == "2ex" {
    push_unique(normalized.with_extension("EXT"));
    push_unique(normalized.with_extension("DAT"));
    push_unique(normalized.with_extension("2EX"));
  }
  push_unique(normalized);

  candidates
}

fn build_pioneer_blue_waveform_column(height: u8, intense: bool) -> PioneerPreviewWaveformColumn {
  let (r, g, b) = if intense {
    (116u8, 246u8, 244u8)
  } else {
    (43u8, 89u8, 255u8)
  };

  PioneerPreviewWaveformColumn {
    back_height: height,
    front_height: height,
    back_color_r: r,
    back_color_g: g,
    back_color_b: b,
    front_color_r: r,
    front_color_g: g,
    front_color_b: b,
  }
}

fn build_pioneer_rgb_waveform_column(
  red_source: u8,
  green_source: u8,
  blue_source: u8,
) -> PioneerPreviewWaveformColumn {
  let front_height = blue_source;
  let back_height = front_height.max(red_source.max(green_source));

  if back_height == 0 {
    return PioneerPreviewWaveformColumn {
      back_height: 0,
      front_height: 0,
      back_color_r: 0,
      back_color_g: 0,
      back_color_b: 0,
      front_color_r: 0,
      front_color_g: 0,
      front_color_b: 0,
    };
  }

  let back_height_u16 = u16::from(back_height);
  let scale_color = |value: u8, max_level: u16| -> u8 {
    ((u16::from(value) * max_level) / back_height_u16).min(255) as u8
  };

  PioneerPreviewWaveformColumn {
    back_height,
    front_height,
    back_color_r: scale_color(red_source, 191),
    back_color_g: scale_color(green_source, 191),
    back_color_b: scale_color(blue_source, 191),
    front_color_r: scale_color(red_source, 255),
    front_color_g: scale_color(green_source, 255),
    front_color_b: scale_color(blue_source, 255),
  }
}

fn read_pioneer_preview_waveform_from_file(
  preview_path: &Path,
) -> StdResult<(String, Vec<PioneerPreviewWaveformColumn>, u32), String> {
  let sections = pioneer_anlz_raw::read_pioneer_anlz_sections(preview_path)
    .map_err(|error| format!("parse preview file failed: {error}"))?;
  let mut blue_columns: Option<Vec<PioneerPreviewWaveformColumn>> = None;

  for section in sections {
    if pioneer_anlz_raw::section_kind_eq(&section, b"PWV4") {
      if section.header_data.len() < 12 {
        continue;
      }
      let entry_size = pioneer_anlz_raw::read_be_u32(&section.header_data[0..4])?;
      let len_entries = pioneer_anlz_raw::read_be_u32(&section.header_data[4..8])?;
      if entry_size != 6 {
        continue;
      }
      let required_size = usize::try_from(entry_size.saturating_mul(len_entries))
        .map_err(|_| "preview waveform size overflow".to_string())?;
      if section.content.len() < required_size {
        continue;
      }
      let mut columns = Vec::with_capacity(len_entries as usize);
      let mut max_height = 0u32;
      for chunk in section.content[..required_size].chunks_exact(6) {
        let column = build_pioneer_rgb_waveform_column(chunk[3], chunk[4], chunk[5]);
        max_height = max_height.max(u32::from(column.back_height));
        columns.push(column);
      }
      return Ok(("rgb".to_string(), columns, max_height));
    }
    if pioneer_anlz_raw::section_kind_eq(&section, b"PWAV") {
      if section.header_data.len() < 4 {
        continue;
      }
      let len_preview = pioneer_anlz_raw::read_be_u32(&section.header_data[0..4])?;
      let preview_len =
        usize::try_from(len_preview).map_err(|_| "preview waveform length overflow".to_string())?;
      if section.content.len() < preview_len {
        continue;
      }
      if blue_columns.is_none() {
        let mut columns = Vec::with_capacity(preview_len);
        for entry in &section.content[..preview_len] {
          columns.push(build_pioneer_blue_waveform_column(
            entry >> 3,
            (entry & 0x07) >= 5,
          ));
        }
        blue_columns = Some(columns);
      }
      continue;
    }
    if pioneer_anlz_raw::section_kind_eq(&section, b"PWV2") {
      if section.header_data.len() < 4 {
        continue;
      }
      let len_preview = pioneer_anlz_raw::read_be_u32(&section.header_data[0..4])?;
      let preview_len =
        usize::try_from(len_preview).map_err(|_| "tiny preview length overflow".to_string())?;
      if section.content.len() < preview_len {
        continue;
      }
      if blue_columns.is_none() {
        let mut columns = Vec::with_capacity(preview_len);
        for entry in &section.content[..preview_len] {
          columns.push(build_pioneer_blue_waveform_column(
            (entry & 0x0F).saturating_mul(2),
            false,
          ));
        }
        blue_columns = Some(columns);
      }
      continue;
    }
  }

  if let Some(columns) = blue_columns {
    let max_height = columns
      .iter()
      .map(|column| u32::from(column.back_height))
      .max()
      .unwrap_or(0);
    return Ok(("blue".to_string(), columns, max_height));
  }

  Err("missing preview waveform section".to_string())
}

#[napi]
pub fn read_pioneer_preview_waveform(analyze_file_path: String) -> PioneerPreviewWaveformDump {
  fn build_empty(
    analyze_file_path: String,
    error: impl Into<String>,
  ) -> PioneerPreviewWaveformDump {
    PioneerPreviewWaveformDump {
      analyze_file_path,
      preview_file_path: String::new(),
      style: String::new(),
      column_count: 0,
      max_height: 0,
      columns: Vec::new(),
      error: Some(error.into()),
    }
  }

  let normalized_path = analyze_file_path.trim().to_string();
  if normalized_path.is_empty() {
    return build_empty(analyze_file_path, "analyze_file_path is empty");
  }

  let input_path = Path::new(&normalized_path);
  let candidates = build_pioneer_preview_waveform_candidates(input_path);
  let mut last_error: Option<String> = None;

  for candidate in candidates {
    if !candidate.exists() {
      continue;
    }

    match read_pioneer_preview_waveform_from_file(&candidate) {
      Ok((style, columns, max_height)) => {
        return PioneerPreviewWaveformDump {
          analyze_file_path: normalized_path,
          preview_file_path: candidate.to_string_lossy().to_string(),
          style,
          column_count: columns.len() as u32,
          max_height,
          columns,
          error: None,
        }
      }
      Err(error) => {
        last_error = Some(format!("{}: {error}", candidate.to_string_lossy()));
      }
    }
  }

  build_empty(
    normalized_path,
    last_error.unwrap_or_else(|| "preview waveform file not found".to_string()),
  )
}

fn build_pioneer_beat_grid_candidates(input_path: &Path) -> Vec<PathBuf> {
  let mut candidates = Vec::new();
  let mut seen = HashSet::new();
  let mut push_unique = |path: PathBuf| {
    let key = crate::file_path_comparison::file_path_key(&path.to_string_lossy());
    if seen.insert(key) {
      candidates.push(path);
    }
  };

  let normalized = input_path.to_path_buf();
  push_unique(normalized.with_extension("DAT"));
  push_unique(normalized);
  candidates
}

fn read_pioneer_beat_grid_from_file(
  grid_path: &Path,
) -> StdResult<Vec<PioneerBeatGridEntry>, String> {
  let sections = pioneer_anlz_raw::read_pioneer_anlz_sections(grid_path)
    .map_err(|error| format!("parse beat grid file failed: {error}"))?;
  let section = sections
    .iter()
    .find(|section| pioneer_anlz_raw::section_kind_eq(section, b"PQTZ"))
    .ok_or_else(|| "missing PQTZ section".to_string())?;
  parse_pioneer_pqtz_section(section)
}

fn parse_pioneer_pqtz_section(
  section: &pioneer_anlz_raw::RawAnlzSection,
) -> StdResult<Vec<PioneerBeatGridEntry>, String> {
  if section.header_data.len() < 12 {
    return Err("PQTZ header is too short".to_string());
  }
  let entry_count = pioneer_anlz_raw::read_be_u32(&section.header_data[8..12])?;
  let required_size = usize::try_from(entry_count)
    .ok()
    .and_then(|count| count.checked_mul(8))
    .ok_or_else(|| "PQTZ entry size overflow".to_string())?;
  if section.content.len() < required_size {
    return Err(format!(
      "PQTZ content is too short: expected {required_size}, got {}",
      section.content.len()
    ));
  }

  let mut previous_time_ms: Option<u32> = None;
  let mut entries = Vec::with_capacity(entry_count as usize);
  for chunk in section.content[..required_size].chunks_exact(8) {
    let beat_number = u16::from_be_bytes([chunk[0], chunk[1]]);
    let tempo = u16::from_be_bytes([chunk[2], chunk[3]]);
    let time_ms = u32::from_be_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]);
    if !(1..=4).contains(&beat_number) {
      return Err(format!("invalid PQTZ beat number: {beat_number}"));
    }
    if tempo == 0 {
      return Err("invalid PQTZ tempo: 0".to_string());
    }
    if previous_time_ms.is_some_and(|previous| time_ms <= previous) {
      return Err("PQTZ times are not strictly increasing".to_string());
    }
    previous_time_ms = Some(time_ms);
    entries.push(PioneerBeatGridEntry {
      beat_number: beat_number as u8,
      bpm: f64::from(tempo) / 100.0,
      time_ms: f64::from(time_ms),
    });
  }
  if entries.is_empty() {
    return Err("PQTZ has no entries".to_string());
  }
  Ok(entries)
}

#[cfg(test)]
mod pioneer_beat_grid_tests {
  use super::{parse_pioneer_detail_waveform_sections, parse_pioneer_pqtz_section};
  use crate::pioneer_anlz_raw::RawAnlzSection;

  #[test]
  fn parses_full_pqtz_entries_in_timeline_milliseconds() {
    let section = RawAnlzSection {
      kind: *b"PQTZ",
      header_data: [0u8, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 2].to_vec(),
      content: [
        0, 1, 0x25, 0x80, 0, 0, 0, 111, // 96.00 BPM, downbeat at 111 ms
        0, 2, 0x25, 0x80, 0, 0, 2, 99,
      ]
      .to_vec(),
    };

    let entries = parse_pioneer_pqtz_section(&section).expect("PQTZ should parse");
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].beat_number, 1);
    assert_eq!(entries[0].bpm, 96.0);
    assert_eq!(entries[0].time_ms, 111.0);
    assert_eq!(entries[1].beat_number, 2);
    assert_eq!(entries[1].time_ms, 611.0);
  }

  #[test]
  fn parses_pwv5_rgb_detail_waveform_columns() {
    let value = (7u16 << 13) | (4u16 << 10) | (1u16 << 7) | (31u16 << 2);
    let sections = [RawAnlzSection {
      kind: *b"PWV5",
      header_data: [0u8, 0, 0, 2, 0, 0, 0, 1, 0, 150, 3, 5].to_vec(),
      content: value.to_be_bytes().to_vec(),
    }];

    let parsed = parse_pioneer_detail_waveform_sections(&sections).expect("PWV5 should parse");
    assert_eq!(parsed.style, "rgb");
    assert_eq!(parsed.detail_rate, Some(150.0));
    assert_eq!(parsed.columns.len(), 1);
    assert_eq!(parsed.columns[0].height, 255);
    assert_eq!(parsed.columns[0].color_r, 255);
    assert_eq!(parsed.columns[0].color_g, 145);
    assert_eq!(parsed.columns[0].color_b, 36);
  }

  #[test]
  fn parses_pwv3_blue_detail_waveform_columns() {
    let sections = [RawAnlzSection {
      kind: *b"PWV3",
      header_data: [0u8, 0, 0, 1, 0, 0, 0, 1, 0, 150, 0, 0].to_vec(),
      content: vec![0x1f],
    }];

    let parsed = parse_pioneer_detail_waveform_sections(&sections).expect("PWV3 should parse");
    assert_eq!(parsed.style, "blue");
    assert_eq!(parsed.detail_rate, Some(150.0));
    assert_eq!(parsed.columns.len(), 1);
    assert_eq!(parsed.columns[0].height, 255);
    assert_eq!(parsed.columns[0].color_r, 93);
    assert_eq!(parsed.columns[0].color_g, 149);
    assert_eq!(parsed.columns[0].color_b, 255);
  }

  #[test]
  fn parses_pwv7_native_frequency_bands_without_reanalysis() {
    let sections = [RawAnlzSection {
      kind: *b"PWV7",
      header_data: [0u8, 0, 0, 3, 0, 0, 0, 1, 0, 150, 0, 0].to_vec(),
      content: vec![11, 73, 127],
    }];

    let parsed = parse_pioneer_detail_waveform_sections(&sections).expect("PWV7 should parse");
    assert_eq!(parsed.style, "triband-detail");
    assert_eq!(parsed.detail_rate, Some(150.0));
    assert_eq!(parsed.columns.len(), 1);
    assert_eq!(parsed.columns[0].height, 127);
    assert_eq!(parsed.columns[0].band_low, Some(127));
    assert_eq!(parsed.columns[0].band_mid, Some(11));
    assert_eq!(parsed.columns[0].band_high, Some(73));
  }

  #[test]
  fn parses_pwv6_when_no_higher_resolution_detail_waveform_exists() {
    let sections = [RawAnlzSection {
      kind: *b"PWV6",
      header_data: [0u8, 0, 0, 3, 0, 0, 0, 1].to_vec(),
      content: vec![8, 4, 2],
    }];

    let parsed = parse_pioneer_detail_waveform_sections(&sections).expect("PWV6 should parse");
    assert_eq!(parsed.style, "triband-preview");
    assert_eq!(parsed.detail_rate, None);
    assert_eq!(parsed.columns.len(), 1);
    assert_eq!(parsed.columns[0].height, 8);
    assert_eq!(parsed.columns[0].band_low, Some(2));
    assert_eq!(parsed.columns[0].band_mid, Some(8));
    assert_eq!(parsed.columns[0].band_high, Some(4));
  }
}

#[napi]
pub fn read_pioneer_beat_grid(analyze_file_path: String) -> PioneerBeatGridDump {
  fn build_empty(analyze_file_path: String, error: impl Into<String>) -> PioneerBeatGridDump {
    PioneerBeatGridDump {
      analyze_file_path,
      grid_file_path: String::new(),
      entries: Vec::new(),
      error: Some(error.into()),
    }
  }

  let normalized_path = analyze_file_path.trim().to_string();
  if normalized_path.is_empty() {
    return build_empty(analyze_file_path, "analyze_file_path is empty");
  }

  let input_path = Path::new(&normalized_path);
  let candidates = build_pioneer_beat_grid_candidates(input_path);
  let mut last_error: Option<String> = None;
  for candidate in candidates {
    if !candidate.exists() {
      continue;
    }
    match read_pioneer_beat_grid_from_file(&candidate) {
      Ok(entries) => {
        return PioneerBeatGridDump {
          analyze_file_path: normalized_path,
          grid_file_path: candidate.to_string_lossy().to_string(),
          entries,
          error: None,
        }
      }
      Err(error) => last_error = Some(format!("{}: {error}", candidate.to_string_lossy())),
    }
  }

  build_empty(
    normalized_path,
    last_error.unwrap_or_else(|| "PQTZ grid file not found".to_string()),
  )
}

fn build_pioneer_detail_waveform_candidates(input_path: &Path) -> Vec<PathBuf> {
  let mut candidates = Vec::new();
  let mut seen = HashSet::new();
  let mut push_unique = |path: PathBuf| {
    let key = crate::file_path_comparison::file_path_key(&path.to_string_lossy());
    if seen.insert(key) {
      candidates.push(path);
    }
  };
  let normalized = input_path.to_path_buf();
  push_unique(normalized.with_extension("EXT"));
  // PWV5 RGB 位于 EXT 时优先使用，PWV7 三频仅作为 RGB 缺失时的细节波形来源。
  push_unique(normalized.with_extension("2EX"));
  push_unique(normalized);
  candidates
}

fn scale_pioneer_waveform_level(value: u8, max_value: u8) -> u8 {
  if max_value == 0 {
    0
  } else {
    ((u16::from(value) * 255) / u16::from(max_value)).min(255) as u8
  }
}

struct ParsedPioneerDetailWaveform {
  style: String,
  detail_rate: Option<f64>,
  columns: Vec<PioneerDetailWaveformColumn>,
}

fn read_pioneer_detail_rate(section: &pioneer_anlz_raw::RawAnlzSection) -> Option<f64> {
  // PWV3/PWV5/PWV7 的第三个 u32 高 16 位是列频率；官方文件为 0x00960000
  // （150Hz），PWV5 低 16 位还带有格式标志，不能把整个 u32 当作频率。
  let value = pioneer_anlz_raw::read_be_u32(section.header_data.get(8..12)?).ok()?;
  let rate = value >> 16;
  (rate > 0).then_some(f64::from(rate))
}

fn parse_pioneer_detail_waveform_sections(
  sections: &[pioneer_anlz_raw::RawAnlzSection],
) -> StdResult<ParsedPioneerDetailWaveform, String> {
  for section in sections {
    if !pioneer_anlz_raw::section_kind_eq(section, b"PWV7")
      && !pioneer_anlz_raw::section_kind_eq(section, b"PWV6")
    {
      continue;
    }
    if section.header_data.len() < 8 {
      continue;
    }
    let entry_size = pioneer_anlz_raw::read_be_u32(&section.header_data[0..4])?;
    let entry_count = pioneer_anlz_raw::read_be_u32(&section.header_data[4..8])?;
    if entry_size != 3 {
      continue;
    }
    let required_size = usize::try_from(entry_count)
      .ok()
      .and_then(|count| count.checked_mul(3))
      .ok_or_else(|| "PWV6/PWV7 entry size overflow".to_string())?;
    if section.content.len() < required_size {
      continue;
    }
    let columns = section.content[..required_size]
      .chunks_exact(3)
      .map(|chunk| {
        // PWV6/PWV7 的字节顺序是 mid, high, low，不是 RGB。
        let mid = chunk[0];
        let high = chunk[1];
        let low = chunk[2];
        PioneerDetailWaveformColumn {
          height: low.max(mid).max(high),
          color_r: 0,
          color_g: 0,
          color_b: 0,
          band_low: Some(low),
          band_mid: Some(mid),
          band_high: Some(high),
        }
      })
      .collect();
    let is_detail = pioneer_anlz_raw::section_kind_eq(section, b"PWV7");
    let style = if is_detail {
      "triband-detail"
    } else {
      "triband-preview"
    };
    return Ok(ParsedPioneerDetailWaveform {
      style: style.to_string(),
      // PWV6 是固定 1200 列的全曲概览，不带与时间直接对应的列频率；PWV7 则有。
      detail_rate: is_detail
        .then(|| read_pioneer_detail_rate(section))
        .flatten(),
      columns,
    });
  }

  for section in sections {
    if pioneer_anlz_raw::section_kind_eq(section, b"PWV5") {
      if section.header_data.len() < 8 {
        continue;
      }
      let entry_size = pioneer_anlz_raw::read_be_u32(&section.header_data[0..4])?;
      let entry_count = pioneer_anlz_raw::read_be_u32(&section.header_data[4..8])?;
      if entry_size != 2 {
        continue;
      }
      let required_size = usize::try_from(entry_count)
        .ok()
        .and_then(|count| count.checked_mul(2))
        .ok_or_else(|| "PWV5 entry size overflow".to_string())?;
      if section.content.len() < required_size {
        continue;
      }
      let columns = section.content[..required_size]
        .chunks_exact(2)
        .map(|chunk| {
          let value = u16::from_be_bytes([chunk[0], chunk[1]]);
          let red = ((value >> 13) & 0x07) as u8;
          let green = ((value >> 10) & 0x07) as u8;
          let blue = ((value >> 7) & 0x07) as u8;
          let height = ((value >> 2) & 0x1f) as u8;
          PioneerDetailWaveformColumn {
            height: scale_pioneer_waveform_level(height, 31),
            color_r: scale_pioneer_waveform_level(red, 7),
            color_g: scale_pioneer_waveform_level(green, 7),
            color_b: scale_pioneer_waveform_level(blue, 7),
            band_low: None,
            band_mid: None,
            band_high: None,
          }
        })
        .collect();
      return Ok(ParsedPioneerDetailWaveform {
        style: "rgb".to_string(),
        detail_rate: read_pioneer_detail_rate(section),
        columns,
      });
    }
  }

  for section in sections {
    if pioneer_anlz_raw::section_kind_eq(section, b"PWV3") {
      if section.header_data.len() < 8 {
        continue;
      }
      let entry_size = pioneer_anlz_raw::read_be_u32(&section.header_data[0..4])?;
      let entry_count = pioneer_anlz_raw::read_be_u32(&section.header_data[4..8])?;
      if entry_size != 1 {
        continue;
      }
      let required_size =
        usize::try_from(entry_count).map_err(|_| "PWV3 entry size overflow".to_string())?;
      if section.content.len() < required_size {
        continue;
      }
      let columns = section.content[..required_size]
        .iter()
        .map(|value| PioneerDetailWaveformColumn {
          height: scale_pioneer_waveform_level(value & 0x1f, 31),
          color_r: 93,
          color_g: 149,
          color_b: 255,
          band_low: None,
          band_mid: None,
          band_high: None,
        })
        .collect();
      return Ok(ParsedPioneerDetailWaveform {
        style: "blue".to_string(),
        detail_rate: read_pioneer_detail_rate(section),
        columns,
      });
    }
  }

  Err("missing supported PWV3/PWV5/PWV6/PWV7 detail waveform section".to_string())
}

fn read_pioneer_detail_waveform_from_file(
  detail_path: &Path,
) -> StdResult<ParsedPioneerDetailWaveform, String> {
  let sections = pioneer_anlz_raw::read_pioneer_anlz_sections(detail_path)
    .map_err(|error| format!("parse detail waveform file failed: {error}"))?;
  parse_pioneer_detail_waveform_sections(&sections)
}

#[napi]
pub fn read_pioneer_detail_waveform(analyze_file_path: String) -> PioneerDetailWaveformDump {
  fn build_empty(analyze_file_path: String, error: impl Into<String>) -> PioneerDetailWaveformDump {
    PioneerDetailWaveformDump {
      analyze_file_path,
      detail_file_path: String::new(),
      style: String::new(),
      detail_rate: None,
      column_count: 0,
      columns: Vec::new(),
      error: Some(error.into()),
    }
  }

  let normalized_path = analyze_file_path.trim().to_string();
  if normalized_path.is_empty() {
    return build_empty(analyze_file_path, "analyze_file_path is empty");
  }
  let candidates = build_pioneer_detail_waveform_candidates(Path::new(&normalized_path));
  let mut last_error = None;
  for candidate in candidates {
    if !candidate.exists() {
      continue;
    }
    match read_pioneer_detail_waveform_from_file(&candidate) {
      Ok(parsed) => {
        return PioneerDetailWaveformDump {
          analyze_file_path: normalized_path,
          detail_file_path: candidate.to_string_lossy().to_string(),
          style: parsed.style,
          detail_rate: parsed.detail_rate,
          column_count: parsed.columns.len() as u32,
          columns: parsed.columns,
          error: None,
        }
      }
      Err(error) => last_error = Some(format!("{}: {error}", candidate.to_string_lossy())),
    }
  }
  build_empty(
    normalized_path,
    last_error.unwrap_or_else(|| "detail waveform file not found".to_string()),
  )
}
