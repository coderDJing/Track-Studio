from typing import Any, Dict, List, Optional, Tuple
from sqlalchemy import literal_column

from bridge_runtime import (
    _close_database,
    _derive_file_format,
    _derive_file_name,
    _fill_grid_payloads_parallel,
    _format_duration,
    _normalize_bpm,
    _normalize_date,
    _normalize_path,
    _open_database,
    _parse_bool,
    _parse_int,
    _resolve_album_name,
    _resolve_artist_name,
    _resolve_candidate_path,
    _resolve_content_cues,
    _resolve_dat_anlz_abs_path,
    _resolve_genre_name,
    _resolve_key_name,
    _resolve_label_name,
    _resolve_request_config,
    _resolve_track_analyze_path,
    _resolve_track_grid_payload,
    _with_content_eager_options,
    tables,
)

# Must match REKORDBOX_COLLECTION_PLAYLIST_ID in src/shared/djLibraryCollection.ts.
COLLECTION_PLAYLIST_ID = 9007199254740991

def _build_tree_nodes(db: Any) -> Any:
    query = db.get_playlist().order_by(tables.DjmdPlaylist.ParentID, tables.DjmdPlaylist.Seq)
    nodes = []
    for playlist in query.all():
        identifier = _parse_int(getattr(playlist, "ID", 0))
        name = str(getattr(playlist, "Name", "") or "").strip()
        if not identifier or not name:
            continue
        nodes.append(
            {
                "id": identifier,
                "parentId": _parse_int(getattr(playlist, "ParentID", 0)),
                "name": name,
                "isFolder": bool(getattr(playlist, "is_folder", False)),
                "isSmartPlaylist": bool(getattr(playlist, "is_smart_playlist", False)),
                "order": _parse_int(getattr(playlist, "Seq", 0)),
            }
        )
    return nodes


def _build_track_record(
    db: Any,
    content: Any,
    playlist_id: int,
    playlist_name: str,
    entry_index: int,
    share_dir: str,
    db_dir: str,
    row_key: Optional[str] = None,
    parse_anlz_grid: bool = True,
) -> Dict[str, Any]:
    file_path = _normalize_path(getattr(content, "FolderPath", ""))
    file_name = _derive_file_name(file_path, getattr(content, "FileNameL", ""))
    file_format = _derive_file_format(file_name, file_path)
    track_id = _parse_int(getattr(content, "ID", 0))
    artwork_path = _resolve_candidate_path(
        getattr(content, "ImagePath", ""),
        (db_dir, share_dir),
    )
    cue_payload = _resolve_content_cues(content)
    grid_payload = _resolve_track_grid_payload(db, content, share_dir) if parse_anlz_grid else {}

    return {
        "rowKey": str(row_key or f"rekordbox-desktop:{playlist_id}:{entry_index}:{track_id}").strip(),
        "playlistId": playlist_id,
        "playlistName": playlist_name,
        "trackId": track_id,
        "entryIndex": entry_index,
        "title": str(getattr(content, "Title", "") or "").strip(),
        "artist": _resolve_artist_name(content),
        "album": _resolve_album_name(content),
        "label": _resolve_label_name(content),
        "genre": _resolve_genre_name(content),
        "filePath": file_path,
        "fileName": file_name,
        "fileFormat": file_format,
        "container": file_format,
        "duration": _format_duration(getattr(content, "Length", 0)),
        "durationSec": _parse_int(getattr(content, "Length", 0)),
        "bpm": _normalize_bpm(getattr(content, "BPM", None)),
        "key": _resolve_key_name(content) or None,
        "bitrate": _parse_int(getattr(content, "BitRate", 0)) or None,
        "sampleRate": _parse_int(getattr(content, "SampleRate", 0)) or None,
        "sampleDepth": _parse_int(getattr(content, "BitDepth", 0)) or None,
        "trackNumber": _parse_int(getattr(content, "TrackNo", 0)) or None,
        "discNumber": _parse_int(getattr(content, "DiscNo", 0)) or None,
        "year": _parse_int(getattr(content, "ReleaseYear", 0)) or None,
        "analyzePath": _resolve_track_analyze_path(db, content, share_dir) or None,
        "rekordboxGridEntries": grid_payload.get("rekordboxGridEntries"),
        "gridBpm": grid_payload.get("gridBpm"),
        "gridFirstBeatMs": grid_payload.get("gridFirstBeatMs"),
        "gridFirstBeatLabel": grid_payload.get("gridFirstBeatLabel"),
        "gridBarBeatOffset": grid_payload.get("gridBarBeatOffset"),
        "comment": str(getattr(content, "Commnt", "") or "").strip() or None,
        "dateAdded": _normalize_date(getattr(content, "StockDate", None)),
        "artworkPath": artwork_path or None,
        "coverPath": artwork_path or None,
        "hotCues": cue_payload.get("hotCues"),
        "memoryCues": cue_payload.get("memoryCues"),
    }


def _build_playlist_tracks_payload(request_payload: Dict[str, Any]) -> Dict[str, Any]:
    config = _resolve_request_config(request_payload)
    if not config.get("available"):
        raise RuntimeError(str(config.get("errorMessage") or "未检测到 Rekordbox 库。"))

    playlist_id = _parse_int(request_payload.get("playlistId"))
    if playlist_id <= 0:
        raise ValueError("playlistId 无效")
    parse_anlz_grid = _parse_bool(request_payload.get("parseAnlzGrid"), True)

    db = None
    try:
        db = _open_database(config)
        is_collection = playlist_id == COLLECTION_PLAYLIST_ID
        playlist = None if is_collection else (
            db.get_playlist(ID=str(playlist_id)) or db.get_playlist(ID=playlist_id)
        )
        if not is_collection and playlist is None:
            raise ValueError(f"未找到播放列表: {playlist_id}")

        playlist_name = "全部曲目" if is_collection else str(getattr(playlist, "Name", "") or "").strip()
        share_dir = _normalize_path(config.get("shareDir"))
        db_dir = _normalize_path(config.get("dbDir"))
        tracks = []
        deferred_grid_jobs: List[Tuple[Dict[str, Any], str]] = []

        if is_collection or bool(getattr(playlist, "is_smart_playlist", False)):
            # A collection has no playlist TrackNo. Keep its persisted database record order.
            source_query = (
                db.get_content().order_by(literal_column("djmdContent.rowid"))
                if is_collection else db.get_playlist_contents(playlist)
            )
            contents_query = _with_content_eager_options(source_query, False)
            contents = contents_query.all()
            for index, content in enumerate(contents, start=1):
                record = _build_track_record(
                    db,
                    content,
                    playlist_id,
                    playlist_name,
                    index,
                    share_dir,
                    db_dir,
                    row_key=f"rekordbox-collection:{getattr(content, 'ID', '')}" if is_collection else None,
                    parse_anlz_grid=False,
                )
                tracks.append(record)
                if parse_anlz_grid:
                    deferred_grid_jobs.append((record, _resolve_dat_anlz_abs_path(db, content, share_dir)))
        else:
            entries_query = _with_content_eager_options(
                db.get_playlist_songs(PlaylistID=getattr(playlist, "ID", playlist_id)).order_by(
                    tables.DjmdSongPlaylist.TrackNo
                ),
                True,
            )
            entries = entries_query.all()
            for index, entry in enumerate(entries, start=1):
                content = getattr(entry, "Content", None)
                if content is None:
                    continue
                entry_index = _parse_int(getattr(entry, "TrackNo", index), index)
                record = _build_track_record(
                    db,
                    content,
                    playlist_id,
                    playlist_name,
                    entry_index,
                    share_dir,
                    db_dir,
                    row_key=str(_parse_int(getattr(entry, "ID", 0), 0) or "").strip()
                    or None,
                    parse_anlz_grid=False,
                )
                tracks.append(record)
                if parse_anlz_grid:
                    deferred_grid_jobs.append((record, _resolve_dat_anlz_abs_path(db, content, share_dir)))

        if parse_anlz_grid:
            _fill_grid_payloads_parallel(deferred_grid_jobs)

        return {
            "probe": config,
            "playlistId": playlist_id,
            "playlistName": playlist_name,
            "trackTotal": len(tracks),
            "tracks": tracks,
        }
    finally:
        _close_database(db)
