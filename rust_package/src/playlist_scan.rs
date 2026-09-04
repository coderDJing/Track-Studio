//! 歌单目录「枚举 + stat」一次过的原生实现。
//!
//! 存在的唯一理由：JS 侧 `collectFilesWithExtensions` 先枚举一遍，`statPlaylistAudioFiles`
//! 再逐个 stat 一遍，两轮都要过 libuv 线程池并跨一次 JS 边界。Windows 上 `FindFirstFileW`
//! 返回的 find-data 本身就带 size 和时间戳，`DirEntry::metadata()` 直接读这份缓存、不额外
//! 发系统调用，所以枚举结束时 stat 其实已经拿到了。
//!
//! 三条红线（改这个文件之前必须先读）：
//!  1. **输出顺序必须与 `src/main/nodeTaskUtils.ts` 的 `collectFilesWithExtensions` 逐字一致。**
//!     歌单序号初始化、封面扫描都依赖这个顺序。所以：绝不排序；子目录并发展开，但严格按
//!     目录项下标回填。
//!  2. **`mtime_ms` 必须和 Node `fs.stat().mtimeMs` 是同一个 double。** Node 算的是
//!     `tv_sec * 1000 + tv_nsec / 1e6`，这里照抄同样的两步浮点运算，不做任何取整。
//!  3. **条目分类必须与 libuv `uv__fs_scandir` 一致**：先判 DIRECTORY，再判 REPARSE_POINT。
//!     目录联接（junction / 目录符号链接）算目录、要递归进去；文件型重解析点（含 OneDrive
//!     按需下载占位文件）算 link、要跳过——因为 JS 侧 `entry.isFile()` 对它们同样是 false。
//!
//! 已知且故意保留的偏差（都记在这里，别当 bug 修）：
//!  - 文件名不是合法 UTF-8 时跳过并计入 `skipped`。JS 侧会拿到一个有损名字、随后 stat 失败
//!    被静默丢弃，最终效果一致：列表不完整 ⇒ 身份摘要不可用。
//!  - 1970 年以前的 mtime 这里饱和到 0，libuv 是无符号回绕成一个巨大值。
//!  - 递归深度上限 `MAX_WALK_DEPTH`，超限计入 `skipped`（JS 是无限递归，遇到目录环会直接把
//!    进程拖死）。

use std::collections::HashSet;
use std::fs::{self, DirEntry, Metadata};
use std::path::{Path, PathBuf};

use rayon::prelude::*;

/// 递归深度上限。真实音乐库不会有这么深的目录，纯防御性上限（目录环）。
const MAX_WALK_DEPTH: u32 = 64;

#[napi(object)]
pub struct NativeAudioFileStat {
  pub file: String,
  pub size: f64,
  pub mtime_ms: f64,
}

#[napi(object)]
pub struct NativeAudioFileScanResult {
  pub files: Vec<NativeAudioFileStat>,
  /// 枚举到了却没能产出完整记录的条目数（拿不到 stat、名字不是 UTF-8、深度超限）。
  /// 只要 > 0，这份列表就是不完整的，调用方不许拿它算身份摘要。
  pub skipped: u32,
}

#[derive(Default)]
struct WalkOutcome {
  files: Vec<NativeAudioFileStat>,
  skipped: u32,
}

/// 目录项占位：先按目录项顺序排好，再把 `Dir` 展开成子目录结果，顺序就不会乱。
enum WalkSlot {
  File(NativeAudioFileStat),
  Dir(PathBuf),
}

enum EntryKind {
  Dir,
  File,
  /// link / 字符设备等：libuv 也不算 file，JS 侧同样跳过，不计入 skipped。
  Ignored,
  /// 连类型都判不出来，可能整棵子树丢了，必须计入 skipped。
  Unknown,
}

#[cfg(windows)]
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
#[cfg(windows)]
const FILE_ATTRIBUTE_DEVICE: u32 = 0x0000_0040;
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

/// Windows：分类只看 find-data 里的属性位，判断顺序与 libuv 保持一致。
#[cfg(windows)]
fn classify_entry(entry: &DirEntry) -> EntryKind {
  use std::os::windows::fs::MetadataExt;
  let Ok(metadata) = entry.metadata() else {
    return EntryKind::Unknown;
  };
  let attributes = metadata.file_attributes();
  if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
    return EntryKind::Dir;
  }
  if attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DEVICE) != 0 {
    return EntryKind::Ignored;
  }
  EntryKind::File
}

/// 非 Windows：`file_type()` 用 d_type，DT_UNKNOWN 时 std 会自己补一次 lstat，
/// 与 Node `readdir({ withFileTypes: true })` 的行为一致。
#[cfg(not(windows))]
fn classify_entry(entry: &DirEntry) -> EntryKind {
  let Ok(file_type) = entry.file_type() else {
    return EntryKind::Unknown;
  };
  if file_type.is_dir() {
    return EntryKind::Dir;
  }
  if file_type.is_file() {
    return EntryKind::File;
  }
  EntryKind::Ignored
}

/// Windows FILETIME 是 100ns 刻度、1601 起算；换成 libuv 那对 tv_sec / tv_nsec 再合成毫秒。
#[cfg(windows)]
fn metadata_mtime_ms(metadata: &Metadata) -> f64 {
  use std::os::windows::fs::MetadataExt;
  const WINDOWS_EPOCH_OFFSET_100NS: u64 = 116_444_736_000_000_000;
  let ticks = metadata
    .last_write_time()
    .saturating_sub(WINDOWS_EPOCH_OFFSET_100NS);
  let secs = ticks / 10_000_000;
  let nanos = (ticks - secs * 10_000_000) * 100;
  (secs as f64) * 1000.0 + (nanos as f64) / 1_000_000.0
}

#[cfg(not(windows))]
fn metadata_mtime_ms(metadata: &Metadata) -> f64 {
  use std::os::unix::fs::MetadataExt;
  (metadata.mtime() as f64) * 1000.0 + (metadata.mtime_nsec() as f64) / 1_000_000.0
}

/// 复刻 Node `path.extname`：取最后一个 '.' 起的后缀；'.' 在首位（`.bashrc`）视为没有后缀。
fn matches_ext(name: &str, allowed_exts: &HashSet<String>) -> bool {
  let Some(dot) = name.rfind('.') else {
    return false;
  };
  if dot == 0 {
    return false;
  }
  allowed_exts.contains(&name[dot..].to_lowercase())
}

fn walk_dir(dir: &Path, allowed_exts: &HashSet<String>, depth: u32) -> WalkOutcome {
  let mut outcome = WalkOutcome::default();
  if depth >= MAX_WALK_DEPTH {
    outcome.skipped = 1;
    return outcome;
  }
  // JS 侧 walk 读不到目录就返回空数组（不报错、不计数），这里保持一致。
  let Ok(entries) = fs::read_dir(dir) else {
    return outcome;
  };

  let mut slots: Vec<WalkSlot> = Vec::new();
  for entry in entries {
    let Ok(entry) = entry else {
      outcome.skipped = outcome.skipped.saturating_add(1);
      continue;
    };
    let raw_name = entry.file_name();
    let Some(name) = raw_name.to_str() else {
      outcome.skipped = outcome.skipped.saturating_add(1);
      continue;
    };
    match classify_entry(&entry) {
      EntryKind::Dir => slots.push(WalkSlot::Dir(dir.join(name))),
      EntryKind::File => {
        // 先过后缀再取 metadata：非 Windows 上 metadata 是一次真实 lstat。
        if !matches_ext(name, allowed_exts) {
          continue;
        }
        let joined = dir.join(name);
        let Some(file) = joined.to_str() else {
          outcome.skipped = outcome.skipped.saturating_add(1);
          continue;
        };
        let Ok(metadata) = entry.metadata() else {
          outcome.skipped = outcome.skipped.saturating_add(1);
          continue;
        };
        slots.push(WalkSlot::File(NativeAudioFileStat {
          file: file.to_owned(),
          size: metadata.len() as f64,
          mtime_ms: metadata_mtime_ms(&metadata),
        }));
      }
      EntryKind::Ignored => {}
      EntryKind::Unknown => outcome.skipped = outcome.skipped.saturating_add(1),
    }
  }

  // 子目录并发展开；`par_iter().collect()` 保序，收回来的顺序与 slots 里的目录顺序一致。
  let expanded: Vec<WalkOutcome> = {
    let child_dirs: Vec<&PathBuf> = slots
      .iter()
      .filter_map(|slot| match slot {
        WalkSlot::Dir(child) => Some(child),
        WalkSlot::File(_) => None,
      })
      .collect();
    child_dirs
      .par_iter()
      .map(|child| walk_dir(child.as_path(), allowed_exts, depth + 1))
      .collect()
  };

  let mut expanded_iter = expanded.into_iter();
  for slot in slots {
    match slot {
      WalkSlot::File(stat) => outcome.files.push(stat),
      WalkSlot::Dir(_) => {
        if let Some(mut child) = expanded_iter.next() {
          outcome.files.append(&mut child.files);
          outcome.skipped = outcome.skipped.saturating_add(child.skipped);
        }
      }
    }
  }
  outcome
}

/// 递归枚举 `dir` 下命中后缀的文件，并顺手带回 size / mtimeMs。
///
/// `dir` 必须是调用方已经 `path.normalize` 过的路径：这里用 `Path::join` 拼接，
/// 只有分隔符已经规整时才和 Node `path.join` 逐字一致。
/// `audio_exts` 传空数组直接返回空结果（与 JS 侧空 `Set` 行为一致）。
#[napi]
pub async fn list_audio_files_with_stat(
  dir: String,
  audio_exts: Vec<String>,
) -> napi::Result<NativeAudioFileScanResult> {
  let outcome = napi::tokio::task::spawn_blocking(move || {
    let allowed_exts: HashSet<String> = audio_exts
      .iter()
      .map(|ext| ext.to_lowercase())
      .filter(|ext| !ext.is_empty())
      .collect();
    if allowed_exts.is_empty() {
      return WalkOutcome::default();
    }
    walk_dir(Path::new(&dir), &allowed_exts, 0)
  })
  .await
  .map_err(|error| {
    napi::Error::new(
      napi::Status::GenericFailure,
      format!("list_audio_files_with_stat join failed: {error}"),
    )
  })?;
  Ok(NativeAudioFileScanResult {
    files: outcome.files,
    skipped: outcome.skipped,
  })
}
