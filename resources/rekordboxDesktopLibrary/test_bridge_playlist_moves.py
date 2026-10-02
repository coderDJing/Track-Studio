"""Run with bundled Python -m unittest discover -s resources/rekordboxDesktopLibrary."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import bridge_playlist_writes as writes


class Database:
    def __init__(self):
        self.playlist = SimpleNamespace(ID="10", ParentID="20", Seq=1)
        self.folder = SimpleNamespace(ID="20", Attribute=1, is_folder=True)
        self.moves = []

    def get_playlist(self, ID):
        return {"10": self.playlist, "20": self.folder}.get(str(ID))

    def move_playlist(self, playlist, parent, seq):
        self.moves.append((parent.ID, parent.Attribute, seq))
        playlist.ParentID = parent.ID
        playlist.Seq = seq

    def commit(self):
        pass

    def close(self):
        pass


class PlaylistMoveTests(unittest.TestCase):
    def test_root_is_explicit_and_never_means_keep_current_parent(self):
        db = Database()
        with patch.object(writes, "_ensure_request_config", return_value={}), \
             patch.object(writes, "_open_database", return_value=db):
            result = writes._build_move_playlist_payload({"playlistId": 10, "parentId": 0, "seq": 4})
        self.assertEqual(db.moves, [("root", 1, 4)])
        self.assertEqual(result["parentId"], 0)
        self.assertEqual(result["seq"], 4)

    def test_actual_folder_uses_native_parent_and_sequence(self):
        db = Database()
        with patch.object(writes, "_ensure_request_config", return_value={}), \
             patch.object(writes, "_open_database", return_value=db):
            result = writes._build_move_playlist_payload({"playlistId": 10, "parentId": 20, "seq": 1})
        self.assertEqual(db.moves, [("20", 1, 1)])
        self.assertEqual(result["parentId"], 20)


if __name__ == "__main__":
    unittest.main()
