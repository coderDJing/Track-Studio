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


def _ok(result: Any) -> Dict[str, Any]:
    return {"ok": True, "result": result}


def _error(code: str, message: str) -> Dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message}}


def _write_response(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _write_progress(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps({"event": "progress", "payload": payload}, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _read_request() -> Dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("empty request")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("request must be a JSON object")
    return data


def _read_request_line() -> Optional[Dict[str, Any]]:
    raw = sys.stdin.readline()
    if raw == "":
        return None
    if not raw.strip():
        return {}
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("request must be a JSON object")
    return data


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
        playlist = db.get_playlist(ID=str(playlist_id)) or db.get_playlist(ID=playlist_id)
        if playlist is None:
            raise ValueError(f"未找到播放列表: {playlist_id}")

        playlist_name = str(getattr(playlist, "Name", "") or "").strip()
        share_dir = _normalize_path(config.get("shareDir"))
        db_dir = _normalize_path(config.get("dbDir"))
        tracks = []
        deferred_grid_jobs: List[Tuple[Dict[str, Any], str]] = []

        if bool(getattr(playlist, "is_smart_playlist", False)):
            contents_query = _with_content_eager_options(db.get_playlist_contents(playlist), False)
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


def _handle_probe(_: Dict[str, Any]) -> Dict[str, Any]:
    return _build_probe_payload(open_database=True)


def _handle_probe_write(payload: Dict[str, Any]) -> Dict[str, Any]:
    config = _resolve_request_config(payload)
    return _build_write_status(config)


def _handle_load_tree(payload: Dict[str, Any]) -> Dict[str, Any]:
    config = _resolve_request_config(payload)
    if not config.get("available"):
        raise RuntimeError(str(config.get("errorMessage") or "未检测到 Rekordbox 库。"))

    db = None
    try:
        db = _open_database(config)
        return {
            "probe": config,
            "nodes": _build_tree_nodes(db),
        }
    finally:
        _close_database(db)


def _handle_load_playlist_tracks(payload: Dict[str, Any]) -> Dict[str, Any]:
    return _build_playlist_tracks_payload(payload)


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

    track_ids = _normalize_track_ids(request_payload)

    db = None
    try:
        db = _open_database(config)
        playlist = _resolve_playlist_by_id(db, playlist_id)
        _ensure_writable_playlist(playlist, playlist_id)
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


def _handle_create_playlist(payload: Dict[str, Any]) -> Dict[str, Any]:
    return _build_create_playlist_payload(payload)


def _handle_create_empty_playlist(payload: Dict[str, Any]) -> Dict[str, Any]:
    return _build_create_empty_playlist_payload(payload)


def _handle_append_playlist(payload: Dict[str, Any]) -> Dict[str, Any]:
    return _build_append_playlist_payload(payload)


def _handle_append_existing_playlist_tracks(payload: Dict[str, Any]) -> Dict[str, Any]:
    return _build_append_existing_playlist_tracks_payload(payload)


def _handle_move_playlist(payload: Dict[str, Any]) -> Dict[str, Any]:
    return _build_move_playlist_payload(payload)


def _handle_rename_playlist(payload: Dict[str, Any]) -> Dict[str, Any]:
    return _build_rename_playlist_payload(payload)


def _handle_delete_playlist(payload: Dict[str, Any]) -> Dict[str, Any]:
    return _build_delete_playlist_payload(payload)


def _handle_remove_playlist_tracks(payload: Dict[str, Any]) -> Dict[str, Any]:
    return _build_remove_playlist_tracks_payload(payload)


def _handle_reorder_playlist_tracks(payload: Dict[str, Any]) -> Dict[str, Any]:
    return _build_reorder_playlist_tracks_payload(payload)


def _handle_create_folder(payload: Dict[str, Any]) -> Dict[str, Any]:
    return _build_create_folder_payload(payload)


COMMANDS = {
    "probe": _handle_probe,
    "probe-write": _handle_probe_write,
    "load-tree": _handle_load_tree,
    "load-playlist-tracks": _handle_load_playlist_tracks,
    "create-empty-playlist": _handle_create_empty_playlist,
    "create-playlist": _handle_create_playlist,
    "append-playlist": _handle_append_playlist,
    "append-existing-playlist-tracks": _handle_append_existing_playlist_tracks,
    "move-playlist": _handle_move_playlist,
    "rename-playlist": _handle_rename_playlist,
    "delete-playlist": _handle_delete_playlist,
    "remove-playlist-tracks": _handle_remove_playlist_tracks,
    "reorder-playlist-tracks": _handle_reorder_playlist_tracks,
    "create-folder": _handle_create_folder,
}


def _execute_request(request: Dict[str, Any]) -> None:
    command = str(request.get("command") or "").strip()
    payload = request.get("payload") or {}
    if command not in COMMANDS:
        raise ValueError(f"unsupported command: {command}")
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")
    result = COMMANDS[command](payload)
    _write_response(_ok(result))


def _handle_request_failure(exc: Exception) -> None:
    if isinstance(exc, HelperCommandError):
        _write_response(_error(exc.code, exc.message))
        return
    if isinstance(exc, ValueError):
        _write_response(_error("HELPER_PROTOCOL_ERROR", str(exc)))
        return
    if isinstance(exc, RuntimeError):
        message = str(exc).strip() or "运行 Rekordbox Desktop helper 失败。"
        code = "REKORDBOX_DB_BUSY" if ("busy" in message.lower() or "lock" in message.lower()) else "HELPER_RUNTIME_ERROR"
        _write_response(_error(code, message))
        return
    _write_response(_error("HELPER_RUNTIME_ERROR", str(exc).strip() or "unknown error"))


def _run_oneshot() -> int:
    try:
        _execute_request(_read_request())
        return 0
    except Exception as exc:
        _handle_request_failure(exc)
        return 1


def _run_persistent() -> int:
    try:
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:
        pass
    while True:
        try:
            request = _read_request_line()
        except Exception as exc:
            _handle_request_failure(exc)
            continue
        if request is None:
            return 0
        if not request:
            continue
        try:
            _execute_request(request)
        except Exception as exc:
            _handle_request_failure(exc)


def main() -> int:
    if "--persistent" in sys.argv:
        return _run_persistent()
    return _run_oneshot()


if __name__ == "__main__":
    raise SystemExit(main())
