import json
import os
import re
import sys
import time
import datetime
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from uuid import uuid4

PYREKORDBOX_IMPORT_ERROR: Optional[str] = None
SELECTINLOAD = None

try:
    from pyrekordbox import Rekordbox6Database, get_config, update_config
    from pyrekordbox.anlz import AnlzFile
    from pyrekordbox.config import get_pioneer_app_dir, read_rekordbox6_options
    from pyrekordbox.db6 import tables
    from pyrekordbox.utils import get_rekordbox_pid
except Exception as exc:  # pragma: no cover
    PYREKORDBOX_IMPORT_ERROR = str(exc)
    Rekordbox6Database = None  # type: ignore[assignment]
    AnlzFile = None  # type: ignore[assignment]
    get_config = None  # type: ignore[assignment]
    update_config = None  # type: ignore[assignment]
    get_pioneer_app_dir = None  # type: ignore[assignment]
    read_rekordbox6_options = None  # type: ignore[assignment]
    tables = None  # type: ignore[assignment]
    get_rekordbox_pid = None  # type: ignore[assignment]

try:
    from sqlalchemy.orm import selectinload as SELECTINLOAD
except Exception:
    SELECTINLOAD = None

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

try:
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


class HelperCommandError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = str(code or "").strip() or "HELPER_RUNTIME_ERROR"
        self.message = str(message or "").strip() or "unknown error"








def _write_progress(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps({"event": "progress", "payload": payload}, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()






def _normalize_path(path_value: Any) -> str:
    value = str(path_value or "").strip()
    if not value:
        return ""
    return os.path.normpath(value)


def _normalize_rel_path(path_value: Any) -> str:
    value = str(path_value or "").strip().replace("\\", "/")
    return value.lstrip("/")


def _parse_int(value: Any, default: int = 0) -> int:
    try:
        return int(str(value).strip())
    except Exception:
        return default


def _parse_float(value: Any) -> Optional[float]:
    try:
        num = float(value)
    except Exception:
        return None
    if not (num == num):
        return None
    return num


def _parse_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value or "").strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off"):
        return False
    return default


def _normalize_text(value: Any) -> str:
    return str(value or "").strip()


def _normalize_optional_text(value: Any) -> Optional[str]:
    text = _normalize_text(value)
    return text or None


HOT_CUE_SLOT_COUNT = 8
CUE_FRAME_RATE = 150.0


def _normalize_cue_sec(value: Any) -> Optional[float]:
    num = _parse_float(value)
    if num is None or num < 0:
        return None
    return round(num, 3)


def _normalize_cue_color_index(value: Any) -> Optional[int]:
    num = _parse_int(value, -1)
    return num if num >= 0 else None


def _normalize_hot_cue_payload(track: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw_items = track.get("hotCues")
    if not isinstance(raw_items, list):
        return []

    normalized: List[Dict[str, Any]] = []
    used_slots = set()
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            continue
        slot = _parse_int(raw_item.get("slot"), -1)
        if slot < 0 or slot >= HOT_CUE_SLOT_COUNT or slot in used_slots:
            continue
        sec = _normalize_cue_sec(raw_item.get("sec"))
        if sec is None:
            continue
        loop_end_sec = _normalize_cue_sec(raw_item.get("loopEndSec"))
        is_loop = bool(
            _parse_bool(raw_item.get("isLoop"), False)
            and loop_end_sec is not None
            and loop_end_sec > sec
        )
        normalized.append(
            {
                "slot": slot,
                "sec": sec,
                "label": _normalize_optional_text(raw_item.get("label")),
                "comment": _normalize_optional_text(raw_item.get("comment")),
                "colorIndex": _normalize_cue_color_index(raw_item.get("colorIndex")),
                "isLoop": is_loop,
                "loopEndSec": loop_end_sec if is_loop else None,
            }
        )
        used_slots.add(slot)
    normalized.sort(key=lambda item: int(item.get("slot", 0)))
    return normalized


def _normalize_memory_cue_payload(track: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw_items = track.get("memoryCues")
    if not isinstance(raw_items, list):
        return []

    normalized: List[Dict[str, Any]] = []
    seen_keys = set()
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            continue
        sec = _normalize_cue_sec(raw_item.get("sec"))
        if sec is None:
            continue
        loop_end_sec = _normalize_cue_sec(raw_item.get("loopEndSec"))
        is_loop = bool(
            _parse_bool(raw_item.get("isLoop"), False)
            and loop_end_sec is not None
            and loop_end_sec > sec
        )
        dedupe_key = (sec, loop_end_sec if is_loop else None)
        if dedupe_key in seen_keys:
            continue
        normalized.append(
            {
                "sec": sec,
                "order": _parse_int(raw_item.get("order"), -1),
                "comment": _normalize_optional_text(raw_item.get("comment")),
                "colorIndex": _normalize_cue_color_index(raw_item.get("colorIndex")),
                "isLoop": is_loop,
                "loopEndSec": loop_end_sec if is_loop else None,
            }
        )
        seen_keys.add(dedupe_key)
    normalized.sort(
        key=lambda item: (
            int(item.get("order", -1)) if int(item.get("order", -1)) >= 0 else 999999,
            float(item.get("sec", 0.0)),
        )
    )
    return normalized


def _resolve_hot_cue_comment(slot: int, label: Optional[str], comment: Optional[str]) -> Optional[str]:
    if comment:
        return comment
    default_label = chr(ord("A") + slot) if 0 <= slot < 26 else ""
    if label and label != default_label:
        return label
    return None


def _resolve_content_cues(content: Any) -> Dict[str, Any]:
    raw_cues = getattr(content, "Cues", None)
    if raw_cues is None:
        return {"hotCues": None, "memoryCues": None}

    try:
        cue_rows = list(raw_cues)
    except Exception:
        cue_rows = []

    ordered_rows = sorted(
        cue_rows,
        key=lambda item: (
            _parse_int(getattr(item, "Kind", 0), 0),
            _parse_int(getattr(item, "InMsec", 0), 0),
            _normalize_identifier(getattr(item, "ID", "")),
        ),
    )

    hot_cues: List[Dict[str, Any]] = []
    memory_cues: List[Dict[str, Any]] = []
    used_hot_slots = set()
    for row in ordered_rows:
        kind = _parse_int(getattr(row, "Kind", 0), 0)
        in_msec = _parse_int(getattr(row, "InMsec", 0), 0)
        out_msec = _parse_int(getattr(row, "OutMsec", -1), -1)
        start_sec = _normalize_cue_sec(in_msec / 1000.0)
        if start_sec is None:
            continue
        is_loop = out_msec > in_msec
        loop_end_sec = _normalize_cue_sec(out_msec / 1000.0) if is_loop else None
        comment = _normalize_optional_text(getattr(row, "Comment", None))
        color_index = _normalize_cue_color_index(getattr(row, "ColorTableIndex", None))
        if kind <= 0:
            memory_cues.append(
                {
                    "sec": start_sec,
                    "order": len(memory_cues),
                    "comment": comment,
                    "colorIndex": color_index,
                    "isLoop": is_loop,
                    "loopEndSec": loop_end_sec if is_loop else None,
                    "source": "rekordbox",
                }
            )
            continue

        slot = kind - 1
        if slot < 0 or slot >= HOT_CUE_SLOT_COUNT or slot in used_hot_slots:
            continue
        hot_cues.append(
            {
                "slot": slot,
                "sec": start_sec,
                "label": chr(ord("A") + slot),
                "comment": comment,
                "colorIndex": color_index,
                "isLoop": is_loop,
                "loopEndSec": loop_end_sec if is_loop else None,
                "source": "rekordbox",
            }
        )
        used_hot_slots.add(slot)

    return {
        "hotCues": hot_cues or None,
        "memoryCues": memory_cues or None,
    }


def _content_has_cues(content: Any) -> bool:
    raw_cues = getattr(content, "Cues", None)
    if raw_cues is None:
        return False
    try:
        return len(raw_cues) > 0
    except Exception:
        try:
            return any(True for _ in raw_cues)
        except Exception:
            return False


def _build_cue_row(
    content: Any,
    kind: int,
    start_sec: float,
    loop_end_sec: Optional[float],
    comment: Optional[str],
    color_index: Optional[int],
) -> Any:
    now = datetime.datetime.now()
    in_msec = int(round(start_sec * 1000))
    out_msec = -1
    out_frame = -1
    if loop_end_sec is not None and loop_end_sec > start_sec:
        out_msec = int(round(loop_end_sec * 1000))
        out_frame = int(round(loop_end_sec * CUE_FRAME_RATE))
    return tables.DjmdCue.create(
        ID=str(uuid4()),
        UUID=str(uuid4()),
        ContentID=_normalize_identifier(getattr(content, "ID", "")),
        ContentUUID=_normalize_identifier(getattr(content, "UUID", "")),
        InMsec=in_msec,
        InFrame=int(round(start_sec * CUE_FRAME_RATE)),
        InMpegFrame=0,
        InMpegAbs=0,
        OutMsec=out_msec,
        OutFrame=out_frame,
        OutMpegFrame=-1 if out_msec < 0 else 0,
        OutMpegAbs=-1 if out_msec < 0 else 0,
        Kind=kind,
        Color=-1,
        ColorTableIndex=color_index,
        ActiveLoop=0,
        Comment=comment,
        BeatLoopSize=0,
        CueMicrosec=int(round(start_sec * 1_000_000)),
        InPointSeekInfo=None,
        OutPointSeekInfo=None,
        created_at=now,
        updated_at=now,
    )


def _apply_track_cues(db: Any, content: Any, track: Dict[str, Any]) -> None:
    hot_cues = _normalize_hot_cue_payload(track)
    memory_cues = _normalize_memory_cue_payload(track)
    if not hot_cues and not memory_cues:
        return
    if _content_has_cues(content):
        return

    for cue in memory_cues:
        db.add(
            _build_cue_row(
                content=content,
                kind=0,
                start_sec=float(cue.get("sec") or 0.0),
                loop_end_sec=cue.get("loopEndSec"),
                comment=_normalize_optional_text(cue.get("comment")),
                color_index=_normalize_cue_color_index(cue.get("colorIndex")),
            )
        )

    for cue in hot_cues:
        slot = _parse_int(cue.get("slot"), -1)
        if slot < 0 or slot >= HOT_CUE_SLOT_COUNT:
            continue
        db.add(
            _build_cue_row(
                content=content,
                kind=slot + 1,
                start_sec=float(cue.get("sec") or 0.0),
                loop_end_sec=cue.get("loopEndSec"),
                comment=_resolve_hot_cue_comment(
                    slot,
                    _normalize_optional_text(cue.get("label")),
                    _normalize_optional_text(cue.get("comment")),
                ),
                color_index=_normalize_cue_color_index(cue.get("colorIndex")),
            )
        )


def _normalize_identifier(value: Any) -> str:
    return str(value or "").strip()


def _resolve_single_query_result(value: Any) -> Any:
    if hasattr(value, "one_or_none"):
        try:
            return value.one_or_none()
        except Exception:
            pass
    if hasattr(value, "first"):
        try:
            return value.first()
        except Exception:
            pass
    return value


def _extract_release_year(value: Any) -> Optional[int]:
    text = _normalize_text(value)
    if not text:
        return None
    matched = re.search(r"(\d{4})", text)
    if not matched:
        return None
    return _parse_int(matched.group(1), 0) or None


def _extract_release_date(value: Any) -> Optional[str]:
    text = _normalize_text(value)
    if not text:
        return None
    matched = re.search(r"\d{4}[-/.]\d{1,2}[-/.]\d{1,2}", text)
    if matched:
        return matched.group(0)
    return None


def _build_search_string(parts: Iterable[Any]) -> Optional[str]:
    normalized = [_normalize_text(part) for part in parts]
    filtered = [part for part in normalized if part]
    if not filtered:
        return None
    return " ".join(filtered)


def _normalize_bpm(value: Any) -> Optional[float]:
    num = _parse_float(value)
    if num is None or num <= 0:
        return None
    return num / 100.0 if num > 1000 else num


def _format_duration(seconds: Any) -> str:
    total = max(0, _parse_int(seconds, 0))
    minutes = total // 60
    remainder = total % 60
    return f"{minutes:02d}:{remainder:02d}"


def _derive_file_name(file_path: str, fallback: Any = "") -> str:
    normalized = _normalize_path(file_path)
    if normalized:
        return Path(normalized).name
    return str(fallback or "").strip()


def _derive_file_format(file_name: str, file_path: str) -> str:
    source = file_name or file_path
    suffix = Path(str(source or "")).suffix
    return suffix[1:].upper() if suffix.startswith(".") else ""


def _normalize_date(value: Any) -> Optional[str]:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        try:
            return str(value.isoformat())
        except Exception:
            return str(value)
    text = str(value).strip()
    return text or None


def _resolve_candidate_path(raw_path: Any, candidates: Iterable[str]) -> str:
    normalized_raw = str(raw_path or "").strip()
    if not normalized_raw:
        return ""
    path_value = Path(normalized_raw)
    if path_value.is_absolute():
        return _normalize_path(path_value)

    stripped = normalized_raw.lstrip("/\\")
    normalized_candidates = [Path(candidate) for candidate in candidates if str(candidate).strip()]
    for base in normalized_candidates:
        candidate = base / stripped
        if candidate.exists():
            return _normalize_path(candidate)
    if normalized_candidates:
        return _normalize_path(normalized_candidates[0] / stripped)
    return _normalize_path(path_value)


def _resolve_track_analyze_path(db: Any, content: Any, share_dir: str) -> str:
    if db is None or content is None:
        return ""
    for file_type in ("DAT", "EXT", "EX2"):
        try:
            analyze_path = db.get_anlz_path(content, file_type)
        except Exception:
            analyze_path = None
        if analyze_path:
            try:
                relative = Path(analyze_path).relative_to(Path(share_dir))
                return _normalize_rel_path(relative)
            except Exception:
                return _normalize_rel_path(analyze_path)
    return ""


def _resolve_dat_anlz_abs_path(db: Any, content: Any, share_dir: str) -> str:
    if db is None or content is None:
        return ""
    analyze_path = None
    try:
        analyze_path = db.get_anlz_path(content, "DAT")
    except Exception:
        analyze_path = None
    return _resolve_candidate_path(analyze_path, (share_dir,))


def _parse_anlz_grid_file(resolved_path: str) -> Dict[str, Any]:
    if not resolved_path or not os.path.exists(resolved_path) or AnlzFile is None:
        return {}

    try:
        anlz = AnlzFile.parse_file(resolved_path)
        beat_grid = anlz.get_tag("beat_grid")
        beats = getattr(beat_grid, "beats", None)
        bpms = getattr(beat_grid, "bpms", None)
        times = getattr(beat_grid, "times", None)
        if beats is None or bpms is None or times is None:
            return {}
        if len(beats) == 0 or len(bpms) == 0 or len(times) == 0:
            return {}

        first_label = _parse_int(beats[0], 1)
        if first_label < 1 or first_label > 4:
            first_label = 1
        first_bpm = _parse_float(bpms[0])
        first_time_sec = _parse_float(times[0])
        if first_bpm is None or first_bpm <= 0 or first_time_sec is None or first_time_sec < 0:
            return {}

        entries = []
        for beat, bpm, time_sec in zip(beats, bpms, times):
            entry_bpm = _parse_float(bpm)
            entry_time_sec = _parse_float(time_sec)
            entry_beat = _parse_int(beat, 1)
            if entry_bpm is None or entry_bpm <= 0 or entry_time_sec is None or entry_time_sec < 0:
                return {}
            if entry_beat < 1 or entry_beat > 4:
                return {}
            entries.append({
                "timeMs": round(float(entry_time_sec) * 1000.0, 3),
                "bpm": round(float(entry_bpm), 6),
                "beatNumber": entry_beat,
            })

        return {
            "gridBpm": round(float(first_bpm), 6),
            "gridFirstBeatMs": round(float(first_time_sec) * 1000.0, 3),
            "gridFirstBeatLabel": first_label,
            "gridBarBeatOffset": (5 - first_label) % 4,
            "rekordboxGridEntries": entries,
        }
    except Exception:
        return {}


def _resolve_track_grid_payload(db: Any, content: Any, share_dir: str) -> Dict[str, Any]:
    return _parse_anlz_grid_file(_resolve_dat_anlz_abs_path(db, content, share_dir))


def _apply_grid_payload(record: Dict[str, Any], grid_payload: Dict[str, Any]) -> None:
    record["rekordboxGridEntries"] = grid_payload.get("rekordboxGridEntries")
    record["gridBpm"] = grid_payload.get("gridBpm")
    record["gridFirstBeatMs"] = grid_payload.get("gridFirstBeatMs")
    record["gridFirstBeatLabel"] = grid_payload.get("gridFirstBeatLabel")
    record["gridBarBeatOffset"] = grid_payload.get("gridBarBeatOffset")


def _fill_grid_payloads_parallel(jobs: List[Tuple[Dict[str, Any], str]]) -> None:
    pending = [(record, path) for record, path in jobs if path]
    if not pending:
        return

    def parse_one(item: Tuple[Dict[str, Any], str]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        record, path = item
        return record, _parse_anlz_grid_file(path)

    workers = min(8, len(pending))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for record, payload in pool.map(parse_one, pending):
            _apply_grid_payload(record, payload)


def _with_content_eager_options(query: Any, from_playlist_song: bool) -> Any:
    if SELECTINLOAD is None or tables is None or query is None:
        return query
    try:
        if from_playlist_song:
            return query.options(
                SELECTINLOAD(tables.DjmdSongPlaylist.Content).selectinload(tables.DjmdContent.Artist),
                SELECTINLOAD(tables.DjmdSongPlaylist.Content).selectinload(tables.DjmdContent.Album),
                SELECTINLOAD(tables.DjmdSongPlaylist.Content).selectinload(tables.DjmdContent.Genre),
                SELECTINLOAD(tables.DjmdSongPlaylist.Content).selectinload(tables.DjmdContent.Label),
                SELECTINLOAD(tables.DjmdSongPlaylist.Content).selectinload(tables.DjmdContent.Key),
                SELECTINLOAD(tables.DjmdSongPlaylist.Content).selectinload(tables.DjmdContent.Cues),
            )
        return query.options(
            SELECTINLOAD(tables.DjmdContent.Artist),
            SELECTINLOAD(tables.DjmdContent.Album),
            SELECTINLOAD(tables.DjmdContent.Genre),
            SELECTINLOAD(tables.DjmdContent.Label),
            SELECTINLOAD(tables.DjmdContent.Key),
            SELECTINLOAD(tables.DjmdContent.Cues),
        )
    except Exception:
        return query


def _resolve_artist_name(content: Any) -> str:
    artist = getattr(content, "ArtistName", None)
    if artist:
        return str(artist).strip()
    relation = getattr(content, "Artist", None)
    if relation is not None:
        name = getattr(relation, "Name", None)
        if name:
            return str(name).strip()
    return ""


def _resolve_album_name(content: Any) -> str:
    album = getattr(content, "AlbumName", None)
    if album:
        return str(album).strip()
    relation = getattr(content, "Album", None)
    if relation is not None:
        name = getattr(relation, "Name", None)
        if name:
            return str(name).strip()
    return ""


def _resolve_genre_name(content: Any) -> str:
    genre = getattr(content, "GenreName", None)
    if genre:
        return str(genre).strip()
    relation = getattr(content, "Genre", None)
    if relation is not None:
        name = getattr(relation, "Name", None)
        if name:
            return str(name).strip()
    return ""


def _resolve_label_name(content: Any) -> str:
    relation = getattr(content, "Label", None)
    if relation is not None:
        name = getattr(relation, "Name", None)
        if name:
            return str(name).strip()
    return ""


def _resolve_key_name(content: Any) -> str:
    relation = getattr(content, "Key", None)
    if relation is not None:
        name = getattr(relation, "ScaleName", None)
        if name:
            return str(name).strip()
    return ""


def _resolve_rekordbox_config() -> Dict[str, Any]:
    if PYREKORDBOX_IMPORT_ERROR:
        return {
            "available": False,
            "supported": sys.platform in ("win32", "darwin"),
            "errorCode": "PYREKORDBOX_UNAVAILABLE",
            "errorMessage": f"pyrekordbox 不可用: {PYREKORDBOX_IMPORT_ERROR}",
        }

    if sys.platform not in ("win32", "darwin"):
        return {
            "available": False,
            "supported": False,
            "errorCode": "UNSUPPORTED_PLATFORM",
            "errorMessage": "当前平台暂不支持 Rekordbox 库。",
        }

    update_config()
    config = {}
    for key in ("rekordbox7", "rekordbox6"):
        current = get_config(key) or {}
        if current.get("db_path"):
            config = current
            break

    if not config:
        try:
            pioneer_app_dir = get_pioneer_app_dir()
            options = read_rekordbox6_options(pioneer_app_dir)
            db_path = _normalize_path(options.get("db-path"))
            db_dir = os.path.dirname(db_path) if db_path else ""
            if db_path and os.path.exists(db_path):
                config = {
                    "version": "",
                    "db_path": db_path,
                    "db_dir": db_dir,
                }
        except Exception:
            config = {}

    db_path = _normalize_path(config.get("db_path"))
    db_dir = _normalize_path(config.get("db_dir") or os.path.dirname(db_path))
    share_dir = _normalize_path(os.path.join(db_dir, "share")) if db_dir else ""
    if not db_path or not os.path.exists(db_path):
        return {
            "available": False,
            "supported": True,
            "errorCode": "REKORDBOX_NOT_FOUND",
            "errorMessage": "未检测到 Rekordbox master.db。",
        }

    return {
        "available": True,
        "supported": True,
        "sourceKey": f"rekordbox-desktop:{db_path}",
        "sourceName": "Rekordbox 库",
        "sourceRootPath": share_dir,
        "dbPath": db_path,
        "dbDir": db_dir,
        "shareDir": share_dir,
        "appVersion": str(config.get("version") or "").strip(),
    }


def _detect_rekordbox_pid() -> int:
    if get_rekordbox_pid is None:
        return 0
    try:
        return _parse_int(get_rekordbox_pid(), 0)
    except Exception:
        return 0


def _build_write_status(config: Dict[str, Any]) -> Dict[str, Any]:
    checked_at = int(time.time() * 1000)
    if not config.get("available"):
        return {
            "writable": False,
            "status": "unavailable",
            "errorCode": str(config.get("errorCode") or "REKORDBOX_NOT_FOUND"),
            "errorMessage": str(config.get("errorMessage") or "未检测到可写入的 Rekordbox 库。"),
            "rekordboxPid": 0,
            "checkedAt": checked_at,
        }

    pid = _detect_rekordbox_pid()
    if pid > 0:
        return {
            "writable": False,
            "status": "busy",
            "errorCode": "REKORDBOX_DB_BUSY",
            "errorMessage": "检测到 Rekordbox 正在运行，当前提交写入会失败。",
            "rekordboxPid": pid,
            "checkedAt": checked_at,
        }

    return {
        "writable": True,
        "status": "available",
        "errorCode": "",
        "errorMessage": "",
        "rekordboxPid": 0,
        "checkedAt": checked_at,
    }


def _open_database(config: Dict[str, Any]) -> Any:
    db_path = _normalize_path(config.get("dbPath"))
    db_dir = _normalize_path(config.get("dbDir"))
    return Rekordbox6Database(path=db_path, db_dir=db_dir)


def _close_database(db: Any) -> None:
    if db is None:
        return
    close_method = getattr(db, "close", None)
    if callable(close_method):
        try:
            close_method()
        except Exception:
            pass


def _rollback_database(db: Any) -> None:
    if db is None:
        return
    session = getattr(db, "session", None)
    if session is None:
        return
    rollback_method = getattr(session, "rollback", None)
    if callable(rollback_method):
        try:
            rollback_method()
        except Exception:
            pass


def _ensure_artist(db: Any, name: Any) -> Any:
    normalized_name = _normalize_text(name)
    if not normalized_name:
        return None
    artist = _resolve_single_query_result(db.get_artist(Name=normalized_name))
    if artist is not None:
        return artist
    return db.add_artist(name=normalized_name, search_str=normalized_name)


def _ensure_genre(db: Any, name: Any) -> Any:
    normalized_name = _normalize_text(name)
    if not normalized_name:
        return None
    genre = _resolve_single_query_result(db.get_genre(Name=normalized_name))
    if genre is not None:
        return genre
    return db.add_genre(name=normalized_name)


def _ensure_label(db: Any, name: Any) -> Any:
    normalized_name = _normalize_text(name)
    if not normalized_name:
        return None
    label = _resolve_single_query_result(db.get_label(Name=normalized_name))
    if label is not None:
        return label
    return db.add_label(name=normalized_name)


def _ensure_album(db: Any, name: Any, album_artist_name: Any) -> Any:
    normalized_name = _normalize_text(name)
    if not normalized_name:
        return None
    album = _resolve_single_query_result(db.get_album(Name=normalized_name))
    if album is not None:
        album_artist = _ensure_artist(db, album_artist_name)
        if album_artist is not None and not getattr(album, "AlbumArtistID", None):
            try:
                album.AlbumArtistID = getattr(album_artist, "ID", None)
            except Exception:
                pass
        return album
    album_artist = _ensure_artist(db, album_artist_name)
    return db.add_album(name=normalized_name, artist=album_artist)


def _assign_scalar_if_present(content: Any, attr: str, value: Any, overwrite: bool = False) -> None:
    if value is None:
        return
    current = getattr(content, attr, None)
    if current not in (None, "", 0) and not overwrite:
        return
    setattr(content, attr, value)


def _assign_foreign_key_if_present(content: Any, attr: str, relation: Any, overwrite: bool = False) -> None:
    relation_id = getattr(relation, "ID", None) if relation is not None else None
    if relation_id in (None, ""):
        return
    current = getattr(content, attr, None)
    if current not in (None, "", 0) and not overwrite:
        return
    setattr(content, attr, relation_id)


def _apply_track_metadata(db: Any, content: Any, track: Dict[str, Any]) -> None:
    title = _normalize_optional_text(track.get("title"))
    artist_name = _normalize_optional_text(track.get("artist"))
    album_name = _normalize_optional_text(track.get("album"))
    album_artist_name = _normalize_optional_text(track.get("albumArtist"))
    genre_name = _normalize_optional_text(track.get("genre"))
    composer_name = _normalize_optional_text(track.get("composer"))
    lyricist_name = _normalize_optional_text(track.get("lyricist"))
    label_name = _normalize_optional_text(track.get("label"))
    isrc = _normalize_optional_text(track.get("isrc"))
    comment = _normalize_optional_text(track.get("comment"))
    year_text = _normalize_optional_text(track.get("year"))
    track_number = _parse_int(track.get("trackNumber"), 0) or None
    disc_number = _parse_int(track.get("discNumber"), 0) or None
    duration_seconds = _parse_int(track.get("durationSeconds"), 0) or None
    bitrate = _parse_int(track.get("bitrate"), 0) or None
    release_year = _extract_release_year(year_text)
    release_date = _extract_release_date(year_text)

    artist = _ensure_artist(db, artist_name)
    album = _ensure_album(db, album_name, album_artist_name)
    genre = _ensure_genre(db, genre_name)
    composer = _ensure_artist(db, composer_name)
    lyricist = _ensure_artist(db, lyricist_name)
    label = _ensure_label(db, label_name)

    _assign_scalar_if_present(content, "Title", title)
    _assign_foreign_key_if_present(content, "ArtistID", artist)
    _assign_foreign_key_if_present(content, "AlbumID", album)
    _assign_foreign_key_if_present(content, "GenreID", genre)
    _assign_scalar_if_present(content, "TrackNo", track_number)
    _assign_scalar_if_present(content, "Commnt", comment)
    _assign_scalar_if_present(content, "ReleaseYear", release_year)
    _assign_foreign_key_if_present(content, "LabelID", label)
    _assign_scalar_if_present(content, "DiscNo", disc_number)
    _assign_foreign_key_if_present(content, "ComposerID", composer)
    _assign_scalar_if_present(content, "Length", duration_seconds)
    _assign_scalar_if_present(content, "BitRate", bitrate)
    _assign_scalar_if_present(content, "ReleaseDate", release_date)
    _assign_foreign_key_if_present(content, "Lyricist", lyricist)
    _assign_scalar_if_present(content, "ISRC", isrc)
    _assign_scalar_if_present(
        content,
        "SearchStr",
        _build_search_string((title, artist_name, album_name, genre_name, label_name, composer_name)),
    )


def _build_probe_payload(open_database: bool = True) -> Dict[str, Any]:
    config = _resolve_rekordbox_config()
    config["writeStatus"] = _build_write_status(config)
    if not config.get("available"):
        return config
    if not open_database:
        return config

    db = None
    try:
        db = _open_database(config)
        config["playlistTotal"] = db.get_playlist().count()
        config["folderTotal"] = db.get_playlist(Attribute=1).count()
        config["trackTotal"] = db.get_content().count()
        return config
    except Exception as exc:
        message = str(exc).strip() or "打开 Rekordbox 库失败。"
        lowered = message.lower()
        config["available"] = False
        config["errorCode"] = "REKORDBOX_DB_BUSY" if ("busy" in lowered or "lock" in lowered) else "REKORDBOX_DB_OPEN_FAILED"
        config["errorMessage"] = message
        config["writeStatus"] = _build_write_status(config)
        return config
    finally:
        _close_database(db)


def _resolve_request_config(request_payload: Dict[str, Any]) -> Dict[str, Any]:
    config = _build_probe_payload(open_database=False)
    db_path = _normalize_path(request_payload.get("dbPath")) or _normalize_path(config.get("dbPath"))
    db_dir = _normalize_path(request_payload.get("dbDir")) or _normalize_path(config.get("dbDir"))
    share_dir = _normalize_path(request_payload.get("shareDir")) or _normalize_path(config.get("shareDir"))
    return {
        **config,
        "available": bool(db_path and os.path.exists(db_path)),
        "dbPath": db_path,
        "dbDir": db_dir or os.path.dirname(db_path),
        "shareDir": share_dir or _normalize_path(os.path.join(db_dir or os.path.dirname(db_path), "share")),
        "sourceRootPath": share_dir or _normalize_path(os.path.join(db_dir or os.path.dirname(db_path), "share")),
    }
