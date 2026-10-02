import os
import re
import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from bridge_runtime import (
    HelperCommandError,
    _apply_track_cues,
    _apply_track_metadata,
    _close_database,
    _normalize_identifier,
    _normalize_path,
    _open_database,
    _parse_int,
    _resolve_request_config,
    _resolve_single_query_result,
    _rollback_database,
    _write_progress,
    tables,
)

def _ensure_request_config(request_payload: Dict[str, Any]) -> Dict[str, Any]:
    config = _resolve_request_config(request_payload)
    if not config.get("available"):
        raise HelperCommandError(
            str(config.get("errorCode") or "REKORDBOX_NOT_FOUND"),
            str(config.get("errorMessage") or "未检测到 Rekordbox 库。"),
        )
    return config


def _resolve_playlist_by_id(db: Any, playlist_id: Any) -> Any:
    safe_playlist_id = _parse_int(playlist_id, 0)
    if safe_playlist_id <= 0:
        return None
    for candidate in (str(safe_playlist_id), safe_playlist_id):
        try:
            playlist = _resolve_single_query_result(db.get_playlist(ID=candidate))
        except Exception:
            playlist = None
        if playlist is not None:
            return playlist
    return None


def _resolve_parent_playlist(db: Any, parent_id: Any) -> Any:
    safe_parent_id = _parse_int(parent_id, 0)
    if safe_parent_id <= 0:
        return None
    parent = _resolve_playlist_by_id(db, safe_parent_id)
    if parent is None:
        raise HelperCommandError("PLAYLIST_PARENT_NOT_FOUND", f"未找到目标 Rekordbox 文件夹：{safe_parent_id}")
    if not bool(getattr(parent, "is_folder", False)):
        raise HelperCommandError("PLAYLIST_PARENT_NOT_FOUND", "目标位置不是 Rekordbox 文件夹。")
    return parent


def _ensure_writable_playlist(playlist: Any, playlist_id: int) -> None:
    if playlist is None:
        raise HelperCommandError("PLAYLIST_NOT_FOUND", f"未找到目标 Rekordbox 播放列表：{playlist_id}")
    if bool(getattr(playlist, "is_folder", False)):
        raise HelperCommandError("INVALID_PLAYLIST_ID", "目标是文件夹，不能直接加入曲目。")
    if bool(getattr(playlist, "is_smart_playlist", False)):
        raise HelperCommandError("INVALID_PLAYLIST_ID", "目标是智能播放列表，不能直接加入曲目。")
    if _parse_int(getattr(playlist, "Attribute", 0), 0) != 0:
        raise HelperCommandError("INVALID_PLAYLIST_ID", "目标不是普通 Rekordbox 播放列表。")


def _ensure_mutable_tree_node(playlist: Any, playlist_id: int) -> None:
    if playlist is None:
        raise HelperCommandError("PLAYLIST_NOT_FOUND", f"未找到目标 Rekordbox 节点：{playlist_id}")
    if bool(getattr(playlist, "is_smart_playlist", False)):
        raise HelperCommandError("INVALID_PLAYLIST_ID", "目标是智能播放列表，暂不支持修改。")


def _normalize_tracks(request_payload: Dict[str, Any]) -> Any:
    raw_tracks = request_payload.get("tracks")
    if not isinstance(raw_tracks, list):
        raw_tracks = []
    tracks = [item for item in raw_tracks if isinstance(item, dict)]
    if not tracks:
        raise HelperCommandError("TRACK_IMPORT_FAILED", "没有可写入 Rekordbox 的曲目。")
    return tracks


def _normalize_track_ids(request_payload: Dict[str, Any]) -> List[int]:
    raw_track_ids = request_payload.get("trackIds")
    if not isinstance(raw_track_ids, list):
        raw_track_ids = []
    track_ids = []
    seen_ids = set()
    for raw_value in raw_track_ids:
        track_id = _parse_int(raw_value, 0)
        if track_id <= 0 or track_id in seen_ids:
            continue
        seen_ids.add(track_id)
        track_ids.append(track_id)
    if not track_ids:
        raise HelperCommandError("TRACK_IMPORT_FAILED", "没有可写入 Rekordbox 的曲目。")
    return track_ids


def _resolve_track_content(db: Any, file_path: str) -> Any:
    content = _resolve_single_query_result(db.get_content(FolderPath=file_path))
    if content is not None:
        return content, False
    try:
        return db.add_content(file_path), True
    except Exception as exc:
        raise HelperCommandError(
            "TRACK_IMPORT_FAILED",
            f"导入曲目失败：{Path(file_path).name}：{str(exc).strip() or 'unknown error'}",
        ) from exc


def _collect_playlist_content_state(db: Any, playlist: Any) -> Any:
    entries = (
        db.get_playlist_songs(PlaylistID=getattr(playlist, "ID", ""))
        .order_by(tables.DjmdSongPlaylist.TrackNo)
        .all()
    )
    content_ids = set()
    max_track_no = 0
    for entry in entries:
        content_id = _normalize_identifier(getattr(entry, "ContentID", ""))
        if not content_id:
            content = getattr(entry, "Content", None)
            content_id = _normalize_identifier(getattr(content, "ID", ""))
        if content_id:
            content_ids.add(content_id)
        max_track_no = max(max_track_no, _parse_int(getattr(entry, "TrackNo", 0), 0))
    return content_ids, max_track_no


def _write_tracks_to_playlist(db: Any, playlist: Any, tracks: Any) -> Dict[str, int]:
    existing_content_ids, max_track_no = _collect_playlist_content_state(db, playlist)
    next_track_no = max_track_no + 1
    added_to_collection_count = 0
    reused_collection_count = 0
    added_to_playlist_count = 0
    skipped_duplicate_count = 0

    for entry_index, track in enumerate(tracks, start=1):
        file_path = _normalize_path(track.get("filePath"))
        if not file_path or not os.path.exists(file_path):
            raise HelperCommandError(
                "TRACK_FILE_MISSING",
                f"源文件不存在：{file_path or '<empty>'}",
            )

        content, added_to_collection = _resolve_track_content(db, file_path)
        if added_to_collection:
            added_to_collection_count += 1
        else:
            reused_collection_count += 1

        try:
            _apply_track_metadata(db, content, track)
        except Exception as exc:
            raise HelperCommandError(
                "TRACK_IMPORT_FAILED",
                f"写入曲目元数据失败：{Path(file_path).name}：{str(exc).strip() or 'unknown error'}",
            ) from exc
        try:
            _apply_track_cues(db, content, track)
        except Exception as exc:
            raise HelperCommandError(
                "TRACK_IMPORT_FAILED",
                f"写入曲目 Cue 失败：{Path(file_path).name}：{str(exc).strip() or 'unknown error'}",
            ) from exc

        content_id = _normalize_identifier(getattr(content, "ID", ""))
        if content_id and content_id in existing_content_ids:
            skipped_duplicate_count += 1
        else:
            try:
                db.add_to_playlist(playlist, content, track_no=next_track_no)
            except Exception as exc:
                raise HelperCommandError(
                    "TRACK_IMPORT_FAILED",
                    f"加入播放列表失败：{Path(file_path).name}：{str(exc).strip() or 'unknown error'}",
                ) from exc
            added_to_playlist_count += 1
            next_track_no += 1
            if content_id:
                existing_content_ids.add(content_id)

        _write_progress(
            {
                "stage": "importing",
                "completedTracks": entry_index,
                "totalTracks": len(tracks),
            }
        )

    return {
        "addedToCollectionCount": added_to_collection_count,
        "reusedCollectionCount": reused_collection_count,
        "addedToPlaylistCount": added_to_playlist_count,
        "skippedDuplicateCount": skipped_duplicate_count,
    }


def _write_existing_track_ids_to_playlist(db: Any, playlist: Any, track_ids: List[int]) -> Dict[str, int]:
    existing_content_ids, max_track_no = _collect_playlist_content_state(db, playlist)
    next_track_no = max_track_no + 1
    added_to_playlist_count = 0
    skipped_duplicate_count = 0

    for entry_index, track_id in enumerate(track_ids, start=1):
        content = _resolve_single_query_result(db.get_content(ID=str(track_id)))
        if content is None:
            content = _resolve_single_query_result(db.get_content(ID=track_id))
        if content is None:
            raise HelperCommandError("TRACK_NOT_FOUND", f"未找到 Rekordbox 曲目：{track_id}")

        content_id = _normalize_identifier(getattr(content, "ID", ""))
        if content_id and content_id in existing_content_ids:
            skipped_duplicate_count += 1
        else:
            try:
                db.add_to_playlist(playlist, content, track_no=next_track_no)
            except Exception as exc:
                title = str(getattr(content, "Title", "") or "").strip() or str(track_id)
                raise HelperCommandError(
                    "TRACK_IMPORT_FAILED",
                    f"加入播放列表失败：{title}：{str(exc).strip() or 'unknown error'}",
                ) from exc
            added_to_playlist_count += 1
            next_track_no += 1
            if content_id:
                existing_content_ids.add(content_id)

        _write_progress(
            {
                "stage": "importing",
                "completedTracks": entry_index,
                "totalTracks": len(track_ids),
            }
        )

    return {
        "addedToCollectionCount": 0,
        "reusedCollectionCount": len(track_ids),
        "addedToPlaylistCount": added_to_playlist_count,
        "skippedDuplicateCount": skipped_duplicate_count,
    }


def _commit_database(db: Any, error_code: str) -> None:
    try:
        db.commit()
    except Exception as exc:
        message = str(exc).strip() or "写入 Rekordbox 库失败。"
        lowered = message.lower()
        if "rekordbox is running" in lowered:
            raise HelperCommandError(
                "REKORDBOX_DB_BUSY",
                "Rekordbox 正在运行，请先关闭 Rekordbox 再写入播放列表。",
            ) from exc
        raise HelperCommandError(error_code, message) from exc


def _build_create_playlist_payload(request_payload: Dict[str, Any]) -> Dict[str, Any]:
    config = _ensure_request_config(request_payload)

    playlist_name = str(request_payload.get("playlistName") or "").strip()
    if not playlist_name:
        raise HelperCommandError("INVALID_PLAYLIST_NAME", "播放列表名称不能为空。")

    tracks = _normalize_tracks(request_payload)

    db = None
    try:
        db = _open_database(config)
        parent = _resolve_parent_playlist(db, request_payload.get("parentId"))
        playlist = db.create_playlist(playlist_name, parent=parent)
        counters = _write_tracks_to_playlist(db, playlist, tracks)

        _write_progress(
            {
                "stage": "committing",
                "completedTracks": len(tracks),
                "totalTracks": len(tracks),
            }
        )
        _commit_database(db, "PLAYLIST_CREATE_FAILED")

        return {
            "probe": config,
            "playlistId": _parse_int(getattr(playlist, "ID", 0)),
            "playlistName": str(getattr(playlist, "Name", "") or "").strip() or playlist_name,
            "trackTotal": len(tracks),
            **counters,
        }
    except HelperCommandError:
        _rollback_database(db)
        raise
    except Exception as exc:
        _rollback_database(db)
        raise HelperCommandError(
            "PLAYLIST_CREATE_FAILED",
            str(exc).strip() or "创建 Rekordbox 播放列表失败。",
        ) from exc
    finally:
        _close_database(db)


def _build_create_empty_playlist_payload(request_payload: Dict[str, Any]) -> Dict[str, Any]:
    config = _ensure_request_config(request_payload)
    playlist_name = str(request_payload.get("playlistName") or "").strip()
    if not playlist_name:
        raise HelperCommandError("INVALID_PLAYLIST_NAME", "播放列表名称不能为空。")

    db = None
    try:
        db = _open_database(config)
        parent = _resolve_parent_playlist(db, request_payload.get("parentId"))
        playlist = db.create_playlist(playlist_name, parent=parent)
        _commit_database(db, "PLAYLIST_CREATE_FAILED")
        return {
            "probe": config,
            "playlistId": _parse_int(getattr(playlist, "ID", 0)),
            "playlistName": str(getattr(playlist, "Name", "") or "").strip() or playlist_name,
            "parentId": _parse_int(getattr(playlist, "ParentID", 0)),
        }
    except HelperCommandError:
        _rollback_database(db)
        raise
    except Exception as exc:
        _rollback_database(db)
        raise HelperCommandError(
            "PLAYLIST_CREATE_FAILED",
            str(exc).strip() or "创建空 Rekordbox 播放列表失败。",
        ) from exc
    finally:
        _close_database(db)


def _build_append_playlist_payload(request_payload: Dict[str, Any]) -> Dict[str, Any]:
    config = _ensure_request_config(request_payload)
    playlist_id = _parse_int(request_payload.get("playlistId"), 0)
    if playlist_id <= 0:
        raise HelperCommandError("INVALID_PLAYLIST_ID", "目标 Rekordbox 播放列表无效。")

    tracks = _normalize_tracks(request_payload)

    db = None
    try:
        db = _open_database(config)
        playlist = _resolve_playlist_by_id(db, playlist_id)
        _ensure_writable_playlist(playlist, playlist_id)
        counters = _write_tracks_to_playlist(db, playlist, tracks)

        _write_progress(
            {
                "stage": "committing",
                "completedTracks": len(tracks),
                "totalTracks": len(tracks),
            }
        )
        _commit_database(db, "PLAYLIST_APPEND_FAILED")

        return {
            "probe": config,
            "playlistId": _parse_int(getattr(playlist, "ID", 0)),
            "playlistName": str(getattr(playlist, "Name", "") or "").strip(),
            "trackTotal": len(tracks),
            **counters,
        }
    except HelperCommandError:
        _rollback_database(db)
        raise
    except Exception as exc:
        _rollback_database(db)
        raise HelperCommandError(
            "PLAYLIST_APPEND_FAILED",
            str(exc).strip() or "追加曲目到 Rekordbox 播放列表失败。",
        ) from exc
    finally:
        _close_database(db)


def _build_append_existing_playlist_tracks_payload(request_payload: Dict[str, Any]) -> Dict[str, Any]:
    config = _ensure_request_config(request_payload)
    playlist_id = _parse_int(request_payload.get("playlistId"), 0)
    if playlist_id <= 0:
        raise HelperCommandError("INVALID_PLAYLIST_ID", "目标 Rekordbox 播放列表无效。")

    track_ids = [] if "sourcePlaylistId" in request_payload else _normalize_track_ids(request_payload)

    db = None
    try:
        db = _open_database(config)
        playlist = _resolve_playlist_by_id(db, playlist_id)
        _ensure_writable_playlist(playlist, playlist_id)
        if "sourcePlaylistId" in request_payload:
            source_id = _parse_int(request_payload.get("sourcePlaylistId"), 0)
            row_keys = _normalize_playlist_row_keys(request_payload.get("rowKeys"))
            if not row_keys:
                raise HelperCommandError("INVALID_SOURCE", "没有可加入歌单的曲目。")
            if source_id == 9007199254740991:
                if any(not re.fullmatch(r"rekordbox-collection:[1-9]\d*", key) for key in row_keys):
                    raise HelperCommandError("INVALID_SOURCE", "全部曲目的拖拽来源无效。")
                track_ids = list(dict.fromkeys(int(key.split(":")[1]) for key in row_keys))
            else:
                source_playlist = _resolve_playlist_by_id(db, source_id)
                if source_playlist is None:
                    raise HelperCommandError("INVALID_SOURCE", "来源歌单已不存在。")
                entries = db.get_playlist_songs(PlaylistID=getattr(source_playlist, "ID", source_id)).all()
                selected = _resolve_playlist_entries_by_row_keys(entries, row_keys, source_id)
                if len(selected) != len(row_keys):
                    raise HelperCommandError("INVALID_SOURCE", "来源歌单的曲目已变化，请刷新后重试。")
                track_ids = list(dict.fromkeys(_parse_int(getattr(entry, "ContentID", 0), 0) for entry in selected))
        counters = _write_existing_track_ids_to_playlist(db, playlist, track_ids)

        _write_progress(
            {
                "stage": "committing",
                "completedTracks": len(track_ids),
                "totalTracks": len(track_ids),
            }
        )
        _commit_database(db, "PLAYLIST_APPEND_FAILED")

        return {
            "probe": config,
            "playlistId": _parse_int(getattr(playlist, "ID", 0)),
            "playlistName": str(getattr(playlist, "Name", "") or "").strip(),
            "trackTotal": len(track_ids),
            **counters,
        }
    except HelperCommandError:
        _rollback_database(db)
        raise
    except Exception as exc:
        _rollback_database(db)
        raise HelperCommandError(
            "PLAYLIST_APPEND_FAILED",
            str(exc).strip() or "追加曲目到 Rekordbox 播放列表失败。",
        ) from exc
    finally:
        _close_database(db)


def _build_move_playlist_payload(request_payload: Dict[str, Any]) -> Dict[str, Any]:
    config = _ensure_request_config(request_payload)
    playlist_id = _parse_int(request_payload.get("playlistId"), 0)
    seq = _parse_int(request_payload.get("seq"), 0)
    if playlist_id <= 0:
        raise HelperCommandError("INVALID_PLAYLIST_ID", "目标 Rekordbox 播放列表无效。")
    if seq <= 0:
        raise HelperCommandError("PLAYLIST_MOVE_FAILED", "目标排序序号无效。")

    db = None
    try:
        db = _open_database(config)
        playlist = _resolve_playlist_by_id(db, playlist_id)
        if playlist is None:
            raise HelperCommandError("PLAYLIST_NOT_FOUND", f"未找到目标 Rekordbox 节点：{playlist_id}")
        parent = _resolve_parent_playlist(db, request_payload.get("parentId"))
        if parent is None:
            # None means "keep the current parent" in pyrekordbox. The root
            # has no database row, so pass its native folder descriptor explicitly.
            parent = tables.DjmdPlaylist(ID="root", Attribute=1)
        db.move_playlist(playlist, parent=parent, seq=seq)
        _commit_database(db, "PLAYLIST_MOVE_FAILED")
        return {
            "probe": config,
            "playlistId": _parse_int(getattr(playlist, "ID", 0)),
            "parentId": _parse_int(getattr(playlist, "ParentID", 0)),
            "seq": _parse_int(getattr(playlist, "Seq", 0)),
        }
    except HelperCommandError:
        _rollback_database(db)
        raise
    except Exception as exc:
        _rollback_database(db)
        raise HelperCommandError(
            "PLAYLIST_MOVE_FAILED",
            str(exc).strip() or "移动 Rekordbox 播放列表失败。",
        ) from exc
    finally:
        _close_database(db)


def _build_rename_playlist_payload(request_payload: Dict[str, Any]) -> Dict[str, Any]:
    config = _ensure_request_config(request_payload)
    playlist_id = _parse_int(request_payload.get("playlistId"), 0)
    playlist_name = str(request_payload.get("name") or "").strip()
    if playlist_id <= 0:
        raise HelperCommandError("INVALID_PLAYLIST_ID", "目标 Rekordbox 节点无效。")
    if not playlist_name:
        raise HelperCommandError("INVALID_PLAYLIST_NAME", "名称不能为空。")

    db = None
    try:
        db = _open_database(config)
        playlist = _resolve_playlist_by_id(db, playlist_id)
        _ensure_mutable_tree_node(playlist, playlist_id)
        db.rename_playlist(playlist, playlist_name)
        _commit_database(db, "PLAYLIST_RENAME_FAILED")
        return {
            "probe": config,
            "playlistId": _parse_int(getattr(playlist, "ID", 0)),
            "playlistName": str(getattr(playlist, "Name", "") or "").strip() or playlist_name,
            "parentId": _parse_int(getattr(playlist, "ParentID", 0)),
            "isFolder": bool(getattr(playlist, "is_folder", False)),
        }
    except HelperCommandError:
        _rollback_database(db)
        raise
    except Exception as exc:
        _rollback_database(db)
        raise HelperCommandError(
            "PLAYLIST_RENAME_FAILED",
            str(exc).strip() or "重命名 Rekordbox 节点失败。",
        ) from exc
    finally:
        _close_database(db)


def _build_delete_playlist_payload(request_payload: Dict[str, Any]) -> Dict[str, Any]:
    config = _ensure_request_config(request_payload)
    playlist_id = _parse_int(request_payload.get("playlistId"), 0)
    if playlist_id <= 0:
        raise HelperCommandError("INVALID_PLAYLIST_ID", "目标 Rekordbox 节点无效。")

    db = None
    try:
        db = _open_database(config)
        playlist = _resolve_playlist_by_id(db, playlist_id)
        _ensure_mutable_tree_node(playlist, playlist_id)
        parent_id = _parse_int(getattr(playlist, "ParentID", 0), 0)
        playlist_name = str(getattr(playlist, "Name", "") or "").strip()
        is_folder = bool(getattr(playlist, "is_folder", False))
        db.delete_playlist(playlist)
        _commit_database(db, "PLAYLIST_DELETE_FAILED")
        return {
            "probe": config,
            "playlistId": playlist_id,
            "parentId": parent_id,
            "playlistName": playlist_name,
            "isFolder": is_folder,
        }
    except HelperCommandError:
        _rollback_database(db)
        raise
    except Exception as exc:
        _rollback_database(db)
        raise HelperCommandError(
            "PLAYLIST_DELETE_FAILED",
            str(exc).strip() or "删除 Rekordbox 节点失败。",
        ) from exc
    finally:
        _close_database(db)


def _parse_playlist_entry_key(value: Any) -> Dict[str, int]:
    raw = str(value or "").strip()
    if not raw:
        return {"entryId": 0, "entryKey": "", "playlistId": 0, "trackNo": 0, "trackId": 0}
    direct_entry_id = _parse_int(raw, 0)
    if direct_entry_id > 0:
        return {
            "entryId": direct_entry_id,
            "entryKey": raw,
            "playlistId": 0,
            "trackNo": 0,
            "trackId": 0,
        }
    matched = re.match(r"^rekordbox-desktop:(\d+):(\d+):(\d+)$", raw)
    if not matched:
        return {"entryId": 0, "entryKey": raw, "playlistId": 0, "trackNo": 0, "trackId": 0}
    return {
        "entryId": 0,
        "entryKey": "",
        "playlistId": _parse_int(matched.group(1), 0),
        "trackNo": _parse_int(matched.group(2), 0),
        "trackId": _parse_int(matched.group(3), 0),
    }


def _normalize_playlist_row_keys(raw_row_keys: Any) -> Any:
    if not isinstance(raw_row_keys, list):
        raw_row_keys = []
    normalized_row_keys = []
    seen_row_keys = set()
    for item in raw_row_keys:
        normalized = str(item or "").strip()
        if not normalized or normalized in seen_row_keys:
            continue
        seen_row_keys.add(normalized)
        normalized_row_keys.append(normalized)
    return normalized_row_keys


def _resolve_playlist_entries_by_row_keys(entries: Any, row_keys: Any, playlist_id: int) -> Any:
    entry_hints = [_parse_playlist_entry_key(item) for item in row_keys]
    entries_by_id = {}
    entries_by_track_hint = {}
    for entry in entries:
        entry_key = str(getattr(entry, "ID", "") or "").strip()
        if entry_key:
            entries_by_id[entry_key] = entry
        track_no = _parse_int(getattr(entry, "TrackNo", 0), 0)
        content_id = _parse_int(getattr(entry, "ContentID", 0), 0)
        if content_id <= 0:
            content = getattr(entry, "Content", None)
            content_id = _parse_int(getattr(content, "ID", 0), 0)
        if track_no > 0 and content_id > 0:
            entries_by_track_hint[(track_no, content_id)] = entry

    entries_by_content_id: dict[int, Any] = {}
    for entry in entries:
        content_id = _parse_int(getattr(entry, "ContentID", 0), 0)
        if content_id <= 0:
            content = getattr(entry, "Content", None)
            content_id = _parse_int(getattr(content, "ID", 0), 0)
        if content_id > 0 and content_id not in entries_by_content_id:
            entries_by_content_id[content_id] = entry

    resolved_entries = []
    resolved_entry_ids = set()
    for hint in entry_hints:
        hinted_playlist_id = hint.get("playlistId", 0)
        if hinted_playlist_id > 0 and hinted_playlist_id != playlist_id:
            continue
        entry = None
        hinted_entry_key = str(hint.get("entryKey", "") or "").strip()
        if hinted_entry_key:
            entry = entries_by_id.get(hinted_entry_key)
        else:
            hinted_track_no = hint.get("trackNo", 0)
            hinted_track_id = hint.get("trackId", 0)
            if hinted_track_no > 0 and hinted_track_id > 0:
                entry = entries_by_track_hint.get((hinted_track_no, hinted_track_id))
            if entry is None and hinted_track_id > 0:
                entry = entries_by_content_id.get(hinted_track_id)
        if entry is None:
            continue
        entry_id = str(getattr(entry, "ID", "") or "").strip()
        if not entry_id or entry_id in resolved_entry_ids:
            continue
        resolved_entry_ids.add(entry_id)
        resolved_entries.append(entry)
    return resolved_entries


def _build_remove_playlist_tracks_payload(request_payload: Dict[str, Any]) -> Dict[str, Any]:
    config = _ensure_request_config(request_payload)
    playlist_id = _parse_int(request_payload.get("playlistId"), 0)
    if playlist_id <= 0:
        raise HelperCommandError("INVALID_PLAYLIST_ID", "目标 Rekordbox 播放列表无效。")

    normalized_row_keys = _normalize_playlist_row_keys(request_payload.get("rowKeys"))
    if not normalized_row_keys:
        raise HelperCommandError("PLAYLIST_TRACK_REMOVE_FAILED", "没有可移除的播放列表曲目。")

    db = None
    try:
        db = _open_database(config)
        playlist = _resolve_playlist_by_id(db, playlist_id)
        _ensure_writable_playlist(playlist, playlist_id)
        entries = (
            db.get_playlist_songs(PlaylistID=getattr(playlist, "ID", playlist_id))
            .order_by(tables.DjmdSongPlaylist.TrackNo)
            .all()
        )
        removable_entries = _resolve_playlist_entries_by_row_keys(
            entries,
            normalized_row_keys,
            playlist_id,
        )
        if not removable_entries:
            raise HelperCommandError("PLAYLIST_TRACK_REMOVE_FAILED", "未找到可移除的播放列表曲目。")

        removed_entry_ids = {
            str(getattr(entry, "ID", "") or "").strip()
            for entry in removable_entries
        }
        now = datetime.datetime.now()
        for entry in removable_entries:
            db.delete(entry)

        moved = []
        next_track_no = 1
        with db.registry.disabled():
            for entry in entries:
                entry_id = str(getattr(entry, "ID", "") or "").strip()
                if entry_id in removed_entry_ids:
                    continue
                current_track_no = _parse_int(getattr(entry, "TrackNo", 0), 0)
                if current_track_no != next_track_no:
                    entry.TrackNo = next_track_no
                    entry.updated_at = now
                    moved.append(entry)
                next_track_no += 1

        if moved:
            db.registry.on_move(moved)

        _commit_database(db, "PLAYLIST_TRACK_REMOVE_FAILED")
        removed_count = len(removable_entries)
        requested_count = len(normalized_row_keys)
        return {
            "probe": config,
            "playlistId": playlist_id,
            "requestedCount": requested_count,
            "removedCount": removed_count,
            "skippedCount": max(0, requested_count - removed_count),
        }
    except HelperCommandError:
        _rollback_database(db)
        raise
    except Exception as exc:
        _rollback_database(db)
        raise HelperCommandError(
            "PLAYLIST_TRACK_REMOVE_FAILED",
            str(exc).strip() or "从 Rekordbox 播放列表移除曲目失败。",
        ) from exc
    finally:
        _close_database(db)


def _build_reorder_playlist_tracks_payload(request_payload: Dict[str, Any]) -> Dict[str, Any]:
    config = _ensure_request_config(request_payload)
    playlist_id = _parse_int(request_payload.get("playlistId"), 0)
    if playlist_id <= 0:
        raise HelperCommandError("INVALID_PLAYLIST_ID", "目标 Rekordbox 播放列表无效。")

    normalized_row_keys = _normalize_playlist_row_keys(request_payload.get("rowKeys"))
    if not normalized_row_keys:
        raise HelperCommandError("PLAYLIST_TRACK_REORDER_FAILED", "没有可排序的播放列表曲目。")

    target_index = _parse_int(request_payload.get("targetIndex"), -1)
    if target_index < 0:
        raise HelperCommandError("PLAYLIST_TRACK_REORDER_FAILED", "目标排序位置无效。")

    db = None
    try:
        db = _open_database(config)
        playlist = _resolve_playlist_by_id(db, playlist_id)
        _ensure_writable_playlist(playlist, playlist_id)
        entries = (
            db.get_playlist_songs(PlaylistID=getattr(playlist, "ID", playlist_id))
            .order_by(tables.DjmdSongPlaylist.TrackNo)
            .all()
        )
        selected_entries = _resolve_playlist_entries_by_row_keys(
            entries,
            normalized_row_keys,
            playlist_id,
        )
        if not selected_entries:
            raise HelperCommandError("PLAYLIST_TRACK_REORDER_FAILED", "未找到可排序的播放列表曲目。")

        selected_entry_ids = {
            str(getattr(entry, "ID", "") or "").strip()
            for entry in selected_entries
        }
        target_index = max(0, min(target_index, len(entries)))
        selected_before_target = 0
        for entry in entries[:target_index]:
            entry_id = str(getattr(entry, "ID", "") or "").strip()
            if entry_id in selected_entry_ids:
                selected_before_target += 1

        remaining_entries = [
            entry
            for entry in entries
            if str(getattr(entry, "ID", "") or "").strip() not in selected_entry_ids
        ]
        selected_entries_in_order = selected_entries
        insert_index = max(0, min(len(remaining_entries), target_index - selected_before_target))
        next_entries = (
            remaining_entries[:insert_index]
            + selected_entries_in_order
            + remaining_entries[insert_index:]
        )

        now = datetime.datetime.now()
        moved = []
        with db.registry.disabled():
            for track_no, entry in enumerate(next_entries, start=1):
                current_track_no = _parse_int(getattr(entry, "TrackNo", 0), 0)
                if current_track_no == track_no:
                    continue
                entry.TrackNo = track_no
                entry.updated_at = now
                moved.append(entry)

        if moved:
            db.registry.on_move(moved)

        _commit_database(db, "PLAYLIST_TRACK_REORDER_FAILED")
        return {
            "probe": config,
            "playlistId": playlist_id,
            "requestedCount": len(normalized_row_keys),
            "movedCount": len(selected_entries_in_order),
            "targetIndex": target_index,
        }
    except HelperCommandError:
        _rollback_database(db)
        raise
    except Exception as exc:
        _rollback_database(db)
        raise HelperCommandError(
            "PLAYLIST_TRACK_REORDER_FAILED",
            str(exc).strip() or "调整 Rekordbox 播放列表曲目顺序失败。",
        ) from exc
    finally:
        _close_database(db)


def _build_create_folder_payload(request_payload: Dict[str, Any]) -> Dict[str, Any]:
    config = _ensure_request_config(request_payload)
    folder_name = str(request_payload.get("folderName") or "").strip()
    if not folder_name:
        raise HelperCommandError("INVALID_PLAYLIST_FOLDER_NAME", "文件夹名称不能为空。")

    db = None
    try:
        db = _open_database(config)
        parent = _resolve_parent_playlist(db, request_payload.get("parentId"))
        folder = db.create_playlist_folder(folder_name, parent=parent)
        _commit_database(db, "PLAYLIST_FOLDER_CREATE_FAILED")
        return {
            "probe": config,
            "folderId": _parse_int(getattr(folder, "ID", 0)),
            "folderName": str(getattr(folder, "Name", "") or "").strip() or folder_name,
            "parentId": _parse_int(getattr(folder, "ParentID", 0)),
        }
    except HelperCommandError:
        _rollback_database(db)
        raise
    except Exception as exc:
        _rollback_database(db)
        raise HelperCommandError(
            "PLAYLIST_FOLDER_CREATE_FAILED",
            str(exc).strip() or "创建 Rekordbox 文件夹失败。",
        ) from exc
    finally:
        _close_database(db)
