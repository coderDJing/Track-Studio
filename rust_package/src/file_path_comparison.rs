// Comparison identity only. Keep the original spelling for all filesystem calls.
fn compare_paths(left: &str, right: &str, case_insensitive: bool) -> bool {
  let left = left.trim();
  let right = right.trim();
  if left == right {
    return true;
  }
  let slash = |ch| if ch == '\\' { '/' } else { ch };
  if case_insensitive {
    left
      .chars()
      .flat_map(char::to_lowercase)
      .map(slash)
      .eq(right.chars().flat_map(char::to_lowercase).map(slash))
  } else {
    left.chars().map(slash).eq(right.chars().map(slash))
  }
}

pub(crate) fn same_file_path(left: &str, right: &str) -> bool {
  compare_paths(left, right, cfg!(target_os = "windows"))
}

pub(crate) fn file_path_key(value: &str) -> String {
  let key = value.trim().replace('\\', "/");
  if cfg!(target_os = "windows") {
    key.to_lowercase()
  } else {
    key
  }
}

#[cfg(test)]
mod tests {
  use super::compare_paths;

  #[test]
  fn windows_matches_slashes_and_unicode_case() {
    assert!(compare_paths(
      "G:\\音乐\\Ä Track.mp3",
      "g:/音乐/ä track.mp3",
      true
    ));
    assert!(!compare_paths("G:/one.mp3", "G:/two.mp3", true));
  }

  #[test]
  fn mac_preserves_case_sensitive_identity() {
    assert!(compare_paths(
      "/Volumes/音乐/Track.mp3",
      "/Volumes/音乐/Track.mp3",
      false
    ));
    assert!(!compare_paths(
      "/Volumes/音乐/Track.mp3",
      "/Volumes/音乐/track.mp3",
      false
    ));
  }
}
