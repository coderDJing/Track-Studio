"""前置脚本：从 Upan 取样并进行进入人工 review 前的差异分拣。

用法示例：
  # dry-run：只看会移动哪些曲目
  python scripts/prep_move_tracks_between_playlists.py --source Upan --target test --limit 500

  # 实际移动
  python scripts/prep_move_tracks_between_playlists.py `
    --source Upan --target test --limit 500 --apply

  # 用户命令不变；内部固定 test 完整分拣，再写入 needReview
  python scripts/prep_move_tracks_between_playlists.py `
    --source Upan --target test --limit 500 --apply --then-triage

  # 先生成 triage 报告，再从同一报告 apply（不重新分析）
  python scripts/prep_move_tracks_between_playlists.py `
    --source Upan --target test --limit 500 --apply --then-triage --triage-apply

分拣报告只记录完整 roster、音频身份和当前对比结果，供人工 label QA 使用。
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from capture_rekordbox_playlist_truth import (
    DEFAULT_BRIDGE,
    _bridge_payload,
    _run_bridge,
)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

REPO_ROOT = Path(__file__).resolve().parents[1]


def _read_project_env_value(name: str) -> str:
    configured = str(os.environ.get(name) or "").strip()
    if configured:
        return configured
    try:
        lines = (REPO_ROOT / ".env").read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, raw_value = line.split("=", 1)
        if key.strip() != name:
            continue
        value = raw_value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        return value
    return ""


def _resolve_demucs_root() -> Path:
    configured = _read_project_env_value("FRKB_DEMUCS_ROOT")
    if not configured:
        return REPO_ROOT / "vendor" / "demucs"
    candidate = Path(configured).expanduser()
    return candidate if candidate.is_absolute() else REPO_ROOT / candidate


DEFAULT_RUNTIME_PYTHON = (
    _resolve_demucs_root() / "win32-x64" / "runtime-cpu" / "python.exe"
)
DEFAULT_SEALED_SCRIPT = REPO_ROOT / "scripts" / "rkb_sealed_batch.py"
DEFAULT_TRIAGE_SCRIPT = REPO_ROOT / "scripts" / "move_rekordbox_playlist_grid_diffs.py"
DEFAULT_SEALED_BATCHES_ROOT = (
    REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark" / "sealed-batches"
)
DEFAULT_DATASET_REGISTRY = (
    REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark" / "rkb-dataset-registry.json"
)
DEFAULT_TRIAGE_REPORT = (
    REPO_ROOT
    / "grid-analysis-lab"
    / "rkb-rekordbox-benchmark"
    / "rekordbox-test-need-review-latest.json"
)


def _normalize_key(value: Any) -> str:
    return str(value or "").strip().casefold()


def _to_float(value: Any) -> float | None:
    try:
        return float(value)
    except Exception:
        return None


def _to_int(value: Any) -> int | None:
    num = _to_float(value)
    return int(round(num)) if num is not None else None


def _load_tree_nodes(bridge_path: Path, db_path: str) -> list[dict[str, Any]]:
    payload = _run_bridge(bridge_path, "load-tree", _bridge_payload(db_path))
    nodes = payload.get("nodes")
    if not isinstance(nodes, list):
        raise RuntimeError("Rekordbox playlist tree is invalid")
    return [item for item in nodes if isinstance(item, dict)]


def _resolve_playlist_node(
    bridge_path: Path,
    playlist_name: str,
    db_path: str,
) -> dict[str, Any]:
    expected = _normalize_key(playlist_name)
    nodes = _load_tree_nodes(bridge_path, db_path)
    matches = [
        item
        for item in nodes
        if not item.get("isFolder") and _normalize_key(item.get("name")) == expected
    ]
    if not matches:
        available = ", ".join(str(item.get("name") or "") for item in nodes if not item.get("isFolder"))
        raise RuntimeError(f"playlist not found: {playlist_name}; available: {available}")
    if len(matches) > 1:
        ids = ", ".join(str(item.get("id") or "") for item in matches)
        raise RuntimeError(f"playlist name is ambiguous: {playlist_name}; ids: {ids}")
    return matches[0]


def _playlist_id(node: dict[str, Any]) -> int:
    num = _to_float(node.get("id"))
    return int(num) if num is not None and num > 0 else 0


def _load_playlist_tracks(bridge_path: Path, playlist_id: int, db_path: str) -> list[dict[str, Any]]:
    payload = _run_bridge(
        bridge_path,
        "load-playlist-tracks",
        {**_bridge_payload(db_path), "playlistId": playlist_id},
    )
    raw_tracks = payload.get("tracks")
    if not isinstance(raw_tracks, list):
        raise RuntimeError(f"failed to load tracks from playlist {playlist_id}")
    return [t for t in raw_tracks if isinstance(t, dict)]


def _move_tracks(
    bridge_path: Path,
    db_path: str,
    *,
    source_playlist_name: str,
    target_playlist_name: str,
    limit: int,
    dry_run: bool,
) -> dict[str, Any]:
    print(f"正在解析歌单...", flush=True)
    source_node = _resolve_playlist_node(bridge_path, source_playlist_name, db_path)
    target_node = _resolve_playlist_node(bridge_path, target_playlist_name, db_path)

    source_id = _playlist_id(source_node)
    target_id = _playlist_id(target_node)
    if source_id <= 0:
        raise RuntimeError(f"source playlist id is invalid: {source_playlist_name}")
    if target_id <= 0:
        raise RuntimeError(f"target playlist id is invalid: {target_playlist_name}")
    if source_id == target_id:
        raise RuntimeError("source and target playlist are the same")

    print(f"源歌单: {source_node.get('name')} (id={source_id})", flush=True)
    print(f"目标歌单: {target_node.get('name')} (id={target_id})", flush=True)

    print(f"正在加载源歌单曲目...", flush=True)
    tracks = _load_playlist_tracks(bridge_path, source_id, db_path)
    print(f"源歌单共 {len(tracks)} 首曲目", flush=True)

    if limit > 0:
        selected = tracks[:limit]
    else:
        selected = tracks
    print(f"选取前 {len(selected)} 首曲目", flush=True)

    track_ids = []
    row_keys = []
    for t in selected:
        tid = _to_int(t.get("trackId"))
        if tid is not None and tid > 0:
            track_ids.append(tid)
        rk = str(t.get("rowKey") or "").strip()
        if rk:
            row_keys.append(rk)

    preview = []
    for i, t in enumerate(selected[:10], 1):
        preview.append(f"  {i}. {t.get('title', '')} - {t.get('artist', '')} [{t.get('fileName', '')}]")
    if len(selected) > 10:
        preview.append(f"  ... 共 {len(selected)} 首")

    result: dict[str, Any] = {
        "sourcePlaylist": source_node.get("name"),
        "sourcePlaylistId": source_id,
        "targetPlaylist": target_node.get("name"),
        "targetPlaylistId": target_id,
        "sourceTrackTotal": len(tracks),
        "selectedCount": len(selected),
        "trackIdCount": len(track_ids),
        "rowKeyCount": len(row_keys),
        "preview": preview,
    }

    if dry_run:
        print(f"\n--- dry-run 预览 ---", flush=True)
        for line in preview:
            print(line, flush=True)
        print(f"\n将追加 {len(track_ids)} 首到 '{target_playlist_name}'，从 '{source_playlist_name}' 移除 {len(row_keys)} 首", flush=True)
        print(f"（加 --apply 执行实际操作）", flush=True)
        return result

    # Step 1: append to target
    print(f"\n正在追加 {len(track_ids)} 首曲目到 '{target_playlist_name}'...", flush=True)
    append_result = _run_bridge(
        bridge_path,
        "append-existing-playlist-tracks",
        {
            **_bridge_payload(db_path),
            "playlistId": target_id,
            "trackIds": track_ids,
        },
    )
    result["appendResult"] = append_result
    added = append_result.get("addedToPlaylistCount", 0)
    skipped = append_result.get("skippedDuplicateCount", 0)
    print(f"  追加完成: 新增 {added} 首, 跳过重复 {skipped} 首", flush=True)

    # Step 2: remove from source
    print(f"正在从 '{source_playlist_name}' 移除 {len(row_keys)} 首曲目...", flush=True)
    remove_result = _run_bridge(
        bridge_path,
        "remove-playlist-tracks",
        {
            **_bridge_payload(db_path),
            "playlistId": source_id,
            "rowKeys": row_keys,
        },
    )
    result["removeResult"] = remove_result
    removed = remove_result.get("removedCount", 0)
    print(f"  移除完成: 删除 {removed} 首", flush=True)

    return result


def _require_empty_playlist(
    bridge_path: Path,
    playlist_name: str,
    db_path: str,
    *,
    required: bool,
) -> None:
    expected = _normalize_key(playlist_name)
    matches = [
        item
        for item in _load_tree_nodes(bridge_path, db_path)
        if not item.get("isFolder") and _normalize_key(item.get("name")) == expected
    ]
    if not matches:
        if required:
            raise RuntimeError(f"playlist not found: {playlist_name}")
        return
    if len(matches) != 1:
        raise RuntimeError(f"playlist name is ambiguous: {playlist_name}")
    playlist_id = _playlist_id(matches[0])
    if playlist_id <= 0:
        raise RuntimeError(f"playlist id is invalid: {playlist_name}")
    tracks = _load_playlist_tracks(bridge_path, playlist_id, db_path)
    if tracks:
        raise RuntimeError(
            f"{playlist_name} still contains {len(tracks)} tracks; finish the previous review batch first"
        )


def _triage_report_apply_args(extra_args: list[str]) -> list[str]:
    apply_args: list[str] = []
    index = 0
    while index < len(extra_args):
        token = extra_args[index]
        if token == "--copy-only" or token.startswith("--target-parent-id="):
            apply_args.append(token)
        elif token == "--target-parent-id":
            apply_args.append(token)
            if index + 1 < len(extra_args):
                index += 1
                apply_args.append(extra_args[index])
        index += 1
    return apply_args


def _triage_report_apply_block_reason(report_path: Path) -> str:
    if not report_path.is_file():
        return f"triage dry-run 报告不存在: {report_path}"
    try:
        payload = json.loads(report_path.read_text(encoding="utf-8"))
    except Exception as error:
        return f"triage dry-run 报告无法读取: {error}"
    if not isinstance(payload, dict):
        return "triage dry-run 报告根节点无效"
    summary = payload.get("summary")
    if not isinstance(summary, dict):
        return "triage dry-run 报告缺少 summary"
    if str(summary.get("mode") or "") != "dry-run":
        return "triage 报告不是 dry-run 模式"
    error_track_count = _to_int(summary.get("errorTrackCount"))
    if error_track_count is None:
        return "triage dry-run 报告缺少有效的 errorTrackCount"
    if error_track_count != 0:
        return f"triage dry-run 报告包含 {error_track_count} 首分析错误曲目"
    return ""


def _run_triage(
    *,
    python_path: Path,
    triage_script: Path,
    triage_source: str,
    triage_target: str,
    bridge_path: Path,
    db_path: str,
    sealed_batch_id: str,
    sealed_batches_root: Path,
    dataset_registry: Path,
    triage_report: Path,
    triage_apply: bool,
    extra_args: list[str],
    pre_review: bool,
) -> int:
    base = [
        str(python_path),
        str(triage_script),
        *extra_args,
    ]
    dry_run_cmd = [
        *base,
        "--source-playlist",
        triage_source,
        "--target-playlist",
        triage_target,
        "--bridge",
        str(bridge_path),
        "--sealed-batches-root",
        str(sealed_batches_root),
        "--dataset-registry",
        str(dataset_registry),
    ]
    if pre_review:
        dry_run_cmd.append("--pre-review")
    else:
        dry_run_cmd.extend(["--sealed-batch-id", sealed_batch_id])
    if db_path:
        dry_run_cmd.extend(["--db-path", db_path])
    dry_run_cmd.extend(["--output", str(triage_report)])

    dry_run_ret = _run_workflow_command("triage dry-run", dry_run_cmd)
    if dry_run_ret != 0:
        if triage_apply:
            print(
                f"\ntriage dry-run 失败，退出码: {dry_run_ret}；已阻止报告 apply。",
                flush=True,
            )
        return dry_run_ret
    if not triage_apply:
        return 0

    apply_block_reason = _triage_report_apply_block_reason(triage_report)
    if apply_block_reason:
        print(f"\n{apply_block_reason}；已阻止报告 apply。", flush=True)
        return 1

    apply_cmd = [
        str(python_path),
        str(triage_script),
        *_triage_report_apply_args(extra_args),
        "--from-report",
        str(triage_report),
        "--target-playlist",
        triage_target,
        "--bridge",
        str(bridge_path),
        "--sealed-batches-root",
        str(sealed_batches_root),
        "--dataset-registry",
        str(dataset_registry),
    ]
    if db_path:
        apply_cmd.extend(["--db-path", db_path])
    apply_cmd.append("--apply")

    return _run_workflow_command("triage report apply", apply_cmd)


def _run_workflow_command(label: str, cmd: list[str]) -> int:
    print(f"\n{'='*60}", flush=True)
    print(f"启动 {label}: {' '.join(cmd)}", flush=True)
    print(f"{'='*60}\n", flush=True)
    return subprocess.call(cmd)


def _run_json_workflow_command(
    label: str, cmd: list[str]
) -> tuple[int, dict[str, Any]]:
    print(f"\n{'='*60}", flush=True)
    print(f"启动 {label}: {' '.join(cmd)}", flush=True)
    print(f"{'='*60}\n", flush=True)
    completed = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if completed.stdout:
        print(completed.stdout, end="" if completed.stdout.endswith("\n") else "\n", flush=True)
    if completed.stderr:
        print(
            completed.stderr,
            end="" if completed.stderr.endswith("\n") else "\n",
            file=sys.stderr,
            flush=True,
        )
    if completed.returncode != 0:
        return completed.returncode, {}
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        print(f"{label} 未返回有效 JSON: {error}", file=sys.stderr, flush=True)
        return 1, {}
    if not isinstance(payload, dict):
        print(f"{label} JSON 根节点无效", file=sys.stderr, flush=True)
        return 1, {}
    return 0, payload


def _run_sealed_pipeline(
    *,
    python_path: Path,
    sealed_script: Path,
    playlist: str,
    bridge_path: Path,
    db_path: str,
    batch: str,
    global_args: list[str],
    prepare_args: list[str],
) -> tuple[int, str]:
    base = [str(python_path), str(sealed_script)]
    prepare_cmd = [
        *base,
        "prepare",
        *global_args,
        "--playlist",
        playlist,
        "--python",
        str(python_path),
        "--bridge",
        str(bridge_path),
    ]
    if db_path:
        prepare_cmd.extend(["--db-path", db_path])
    prepare_cmd.extend(prepare_args)
    prepare_ret, prepare_payload = _run_json_workflow_command("sealed prepare", prepare_cmd)
    if prepare_ret != 0:
        print(f"\nsealed prepare 失败，退出码: {prepare_ret}；已阻止 triage。", flush=True)
        return prepare_ret, ""
    prepared_batch_id = str(prepare_payload.get("batchId") or "").strip()
    if not prepared_batch_id:
        print("\nsealed prepare 未返回 batchId；已阻止 triage。", flush=True)
        return 1, ""
    requested_batch = str(batch or "latest").strip()
    if requested_batch.casefold() != "latest" and requested_batch != prepared_batch_id:
        print(
            f"\n--sealed-batch={requested_batch} 与本次 prepare 的 {prepared_batch_id} 不一致；"
            "已阻止 triage。",
            flush=True,
        )
        return 1, ""
    commands = (
        (
            "sealed evaluate",
            [*base, "evaluate", *global_args, "--batch", prepared_batch_id],
        ),
        (
            "sealed finalize consume",
            [
                *base,
                "finalize",
                *global_args,
                "--batch",
                prepared_batch_id,
                "--decision",
                "consume",
            ],
        ),
    )
    for label, cmd in commands:
        ret = _run_workflow_command(label, cmd)
        if ret != 0:
            print(f"\n{label} 失败，退出码: {ret}；已阻止 triage。", flush=True)
            return ret, ""
    return 0, prepared_batch_id


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Move tracks between Rekordbox playlists. With --then-triage, sealed prepare/evaluate/"
            "finalize consume must all succeed before triage starts."
        ),
    )
    parser.add_argument("--source", default="Upan", help="Source playlist name (default: Upan)")
    parser.add_argument("--target", default="test", help="Target playlist name (default: test)")
    parser.add_argument("--limit", type=int, default=500, help="Max tracks to move (default: 500)")
    parser.add_argument("--bridge", default=str(DEFAULT_BRIDGE))
    parser.add_argument("--db-path", default="")
    parser.add_argument("--apply", action="store_true", help="Actually move tracks. Default is dry-run.")
    parser.add_argument(
        "--then-triage",
        action="store_true",
        help=(
            "After an applied move, run the complete pre-review triage and record the "
            "batch for human label QA."
        ),
    )
    parser.add_argument(
        "--triage-apply",
        action="store_true",
        help=(
            "After triage succeeds, apply that same report "
            "without reanalyzing audio."
        ),
    )
    parser.add_argument(
        "--triage-source",
        default="",
        help="Playlist frozen and triaged after the move (default: --target).",
    )
    parser.add_argument(
        "--triage-target",
        default="needReview",
        help="Triage target playlist (default: needReview).",
    )
    parser.add_argument(
        "--triage-script",
        default=str(DEFAULT_TRIAGE_SCRIPT),
    )
    parser.add_argument(
        "--triage-report",
        default=str(DEFAULT_TRIAGE_REPORT),
        help="Dry-run report path used by optional no-reanalysis triage apply.",
    )
    parser.add_argument(
        "--workflow-python",
        default=str(DEFAULT_RUNTIME_PYTHON),
        help="Default Python executable for sealed and triage subprocesses.",
    )
    parser.add_argument(
        "--sealed-python",
        default="",
        help="Override Python executable for sealed subprocesses.",
    )
    parser.add_argument(
        "--triage-python",
        default="",
        help="Override Python executable for the triage subprocess.",
    )
    parser.add_argument("--sealed-script", default=str(DEFAULT_SEALED_SCRIPT))
    parser.add_argument(
        "--sealed-batch",
        default="latest",
        help="Batch selector for evaluate/finalize (default: latest prepared batch).",
    )
    parser.add_argument("--sealed-batches-root", default="")
    parser.add_argument("--sealed-registry", default="")
    parser.add_argument("--sealed-baseline", default="")
    parser.add_argument("--sealed-audio-intake-root", default="")
    parser.add_argument("--sealed-audio-archive-root", default="")
    parser.add_argument("--sealed-device", default="")
    parser.add_argument("--sealed-jobs", type=int, default=0)
    args, triage_extra = parser.parse_known_args()

    bridge_path = Path(args.bridge)
    if not bridge_path.exists():
        raise SystemExit(f"bridge not found: {bridge_path}")
    if args.triage_apply and not args.then_triage:
        parser.error("--triage-apply requires --then-triage")

    triage_source = str(args.triage_source or args.target).strip()
    workflow_python = Path(str(args.workflow_python))
    sealed_python = Path(str(args.sealed_python or workflow_python))
    triage_python = Path(str(args.triage_python or workflow_python))
    sealed_script = Path(str(args.sealed_script))
    triage_script = Path(str(args.triage_script))
    triage_report = Path(str(args.triage_report))
    sealed_batches_root = (
        Path(str(args.sealed_batches_root))
        if str(args.sealed_batches_root or "").strip()
        else DEFAULT_SEALED_BATCHES_ROOT
    )
    dataset_registry = (
        Path(str(args.sealed_registry))
        if str(args.sealed_registry or "").strip()
        else DEFAULT_DATASET_REGISTRY
    )
    if args.then_triage and args.apply:
        required_files = {
            "triage Python": triage_python,
            "triage script": triage_script,
        }
        missing = [
            f"{label}: {path}"
            for label, path in required_files.items()
            if not path.is_file()
        ]
        if missing:
            raise SystemExit("workflow dependency not found: " + "; ".join(missing))

    sealed_global_args: list[str] = []
    for flag, value in (
        ("--batches-root", args.sealed_batches_root),
        ("--registry", args.sealed_registry),
        ("--baseline", args.sealed_baseline),
    ):
        if str(value or "").strip():
            sealed_global_args.extend([flag, str(value)])
    sealed_prepare_args: list[str] = []
    for flag, value in (
        ("--audio-intake-root", args.sealed_audio_intake_root),
        ("--audio-archive-root", args.sealed_audio_archive_root),
        ("--device", args.sealed_device),
    ):
        if str(value or "").strip():
            sealed_prepare_args.extend([flag, str(value)])
    if int(args.sealed_jobs or 0) > 0:
        sealed_prepare_args.extend(["--jobs", str(int(args.sealed_jobs))])

    if args.then_triage and args.apply:
        _require_empty_playlist(
            bridge_path,
            str(args.target),
            str(args.db_path or ""),
            required=True,
        )
        _require_empty_playlist(
            bridge_path,
            str(args.triage_target),
            str(args.db_path or ""),
            required=False,
        )

    started_at = time.time()
    result = _move_tracks(
        bridge_path,
        str(args.db_path or ""),
        source_playlist_name=str(args.source),
        target_playlist_name=str(args.target),
        limit=int(args.limit),
        dry_run=not bool(args.apply),
    )
    elapsed = time.time() - started_at

    result["dryRun"] = not bool(args.apply)
    result["elapsedSec"] = round(elapsed, 3)

    print(f"\n--- 结果 ---", flush=True)
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)

    if args.then_triage and args.apply:
        triage_apply = bool(args.triage_apply)
        ret = _run_triage(
            python_path=triage_python,
            triage_script=triage_script,
            triage_source=triage_source,
            triage_target=str(args.triage_target),
            bridge_path=bridge_path,
            db_path=str(args.db_path or ""),
            sealed_batch_id="",
            sealed_batches_root=sealed_batches_root,
            dataset_registry=dataset_registry,
            triage_report=triage_report,
            triage_apply=triage_apply,
            extra_args=triage_extra,
            pre_review=True,
        )
        if ret != 0:
            print(f"\n分拣脚本退出码: {ret}", flush=True)
            return ret

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(1)
