"""Run: bundled python -m unittest discover -s resources/rekordboxDesktopLibrary."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import bridge_playlist_writes as writes
from bridge_runtime import HelperCommandError


class Query:
    def __init__(self, rows):
        self.rows = rows

    def order_by(self, _column):
        return self

    def all(self):
        return self.rows


class Database:
    def __init__(self):
        self.playlists = {"1": SimpleNamespace(ID="1", Name="Source", Attribute=0),
                          "2": SimpleNamespace(ID="2", Name="Target", Attribute=0)}
        self.contents = {"10": SimpleNamespace(ID="10", Title="A", native_grid="grid-a", native_cues="cue-a"),
                         "20": SimpleNamespace(ID="20", Title="B", native_grid="grid-b", native_cues="cue-b")}
        self.rows = {"1": [SimpleNamespace(ID="101", ContentID="10", TrackNo=1),
                           SimpleNamespace(ID="102", ContentID="20", TrackNo=2)],
                     "2": [SimpleNamespace(ID="201", ContentID="10", TrackNo=3)]}
        self.commits = 0

    def get_playlist(self, ID):
        return self.playlists.get(str(ID))

    def get_playlist_songs(self, PlaylistID):
        return Query(self.rows[str(PlaylistID)])

    def get_content(self, ID):
        return self.contents.get(str(ID))

    def add_to_playlist(self, playlist, content, track_no):
        self.rows[playlist.ID].append(SimpleNamespace(ID="new", ContentID=content.ID, TrackNo=track_no))

    def commit(self):
        self.commits += 1

    def close(self):
        pass


class SongDropTests(unittest.TestCase):
    def run_drop(self, source_id, row_keys):
        with patch.object(writes, "_ensure_request_config", return_value={}), \
             patch.object(writes, "_open_database", return_value=self.db), \
             patch.object(writes, "_write_progress"):
            return writes._build_append_existing_playlist_tracks_payload({
                "playlistId": 2, "sourcePlaylistId": source_id, "rowKeys": row_keys})

    def setUp(self):
        self.db = Database()

    def test_native_entries_reused_in_order_without_touching_source_or_cues(self):
        result = self.run_drop(1, ["101", "102"])
        self.assertEqual(result["addedToPlaylistCount"], 1)
        self.assertEqual(result["skippedDuplicateCount"], 1)
        self.assertEqual([row.ContentID for row in self.db.rows["1"]], ["10", "20"])
        self.assertEqual([row.ContentID for row in self.db.rows["2"]], ["10", "20"])
        self.assertEqual(self.db.rows["2"][-1].TrackNo, 4)
        self.assertEqual(self.db.contents["20"].native_grid, "grid-b")
        self.assertEqual(self.db.contents["20"].native_cues, "cue-b")
        self.assertEqual(self.db.commits, 1)

    def test_all_tracks_rows_can_be_dragged(self):
        result = self.run_drop(9007199254740991, ["rekordbox-collection:20", "rekordbox-collection:10"])
        self.assertEqual(result["addedToPlaylistCount"], 1)
        self.assertEqual(result["skippedDuplicateCount"], 1)

    def test_stale_or_wrong_source_entries_fail_before_writing(self):
        for source_id, keys in [(1, ["101", "stale"]), (9007199254740991, ["101"]), (99, ["101"])]:
            with self.assertRaises(HelperCommandError):
                self.run_drop(source_id, keys)
        self.assertEqual(len(self.db.rows["2"]), 1)
        self.assertEqual(self.db.commits, 0)


if __name__ == "__main__":
    unittest.main()
