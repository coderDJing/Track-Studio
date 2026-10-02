import json
import sys
from typing import Any, Dict, Optional

from bridge_runtime import (
    HelperCommandError,
    _build_probe_payload,
    _build_write_status,
    _close_database,
    _open_database,
    _resolve_request_config,
)

from bridge_reads import (
    _build_playlist_tracks_payload,
    _build_tree_nodes,
)

from bridge_playlist_writes import (
    _build_append_existing_playlist_tracks_payload,
    _build_append_playlist_payload,
    _build_create_empty_playlist_payload,
    _build_create_folder_payload,
    _build_create_playlist_payload,
    _build_delete_playlist_payload,
    _build_move_playlist_payload,
    _build_remove_playlist_tracks_payload,
    _build_rename_playlist_payload,
    _build_reorder_playlist_tracks_payload,
)

def _ok(result: Any) -> Dict[str, Any]:
    return {"ok": True, "result": result}

def _error(code: str, message: str) -> Dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message}}

def _write_response(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
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

def _handle_probe(payload: Dict[str, Any]) -> Dict[str, Any]:
    return _build_probe_payload(open_database=payload.get("openDatabase") is not False)


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
