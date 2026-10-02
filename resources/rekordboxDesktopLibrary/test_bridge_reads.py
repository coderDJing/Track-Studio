"""Run with the bundled Python: python -m unittest discover -s resources/rekordboxDesktopLibrary."""

import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

import bridge
import bridge_reads
from bridge_runtime import tables


class LibraryDatabase:
    def __init__(self):
        self.engine = create_engine("sqlite:///:memory:")
        tables.Base.metadata.create_all(self.engine)
        self.session = Session(self.engine)
        required_values = {
            column.key: 0 if column.type.python_type in (int, float) else ""
            for column in tables.DjmdContent.__table__.columns
            if not column.nullable and (column.default is None or column.default.arg is None)
        }
        # IDs, titles and dates deliberately disagree with insertion order.
        for track_id, title, date in [(800, "Zebra", "2026-10-01"), (5, "Alpha", "2025-01-01"), (300, "Middle", "2026-01-01")]:
            values = {**required_values, "ID": str(track_id), "Title": title,
                      "FolderPath": f"C:/Music/{title}.mp3", "StockDate": date}
            self.session.add(tables.DjmdContent(**values))
            self.session.flush()
        self.session.commit()

    def get_content(self):
        return self.session.query(tables.DjmdContent)

    def get_playlist(self, **kwargs):
        return self.session.query(tables.DjmdPlaylist).filter_by(**kwargs).first()

    def close(self):
        self.session.close()
        self.engine.dispose()


class CollectionReadTests(unittest.TestCase):
    def setUp(self):
        self.db = LibraryDatabase()
        self.addCleanup(self.db.close)

    def read_collection(self):
        with patch.object(bridge_reads, "_resolve_request_config", return_value={"available": True}), \
             patch.object(bridge_reads, "_open_database", return_value=self.db), \
             patch.object(bridge_reads, "_close_database"):
            return bridge._handle_load_playlist_tracks({
                "playlistId": bridge_reads.COLLECTION_PLAYLIST_ID, "parseAnlzGrid": False,
            })

    def test_collection_preserves_database_record_order_and_uses_display_numbers(self):
        result = self.read_collection()
        self.assertEqual(result["playlistName"], "全部曲目")
        self.assertEqual(result["trackTotal"], 3)
        self.assertEqual([row["trackId"] for row in result["tracks"]], [800, 5, 300])
        self.assertEqual([row["entryIndex"] for row in result["tracks"]], [1, 2, 3])

    def test_collection_row_identity_survives_a_preceding_track_removal(self):
        before = self.read_collection()["tracks"]
        self.db.session.delete(self.db.session.get(tables.DjmdContent, "800"))
        self.db.session.commit()
        after = self.read_collection()["tracks"]
        self.assertEqual([row["rowKey"] for row in after], [row["rowKey"] for row in before[1:]])
        self.assertEqual([row["entryIndex"] for row in after], [1, 2])

    def test_collection_cannot_be_resolved_as_a_writable_playlist(self):
        from bridge_playlist_writes import _resolve_playlist_by_id, _ensure_writable_playlist
        from bridge_runtime import HelperCommandError
        playlist = _resolve_playlist_by_id(self.db, bridge_reads.COLLECTION_PLAYLIST_ID)
        with self.assertRaises(HelperCommandError):
            _ensure_writable_playlist(playlist, bridge_reads.COLLECTION_PLAYLIST_ID)


if __name__ == "__main__":
    unittest.main()
