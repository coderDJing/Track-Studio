"""Run with bundled Python: python -m unittest discover -s resources/rekordboxDesktopLibrary."""

import unittest
from unittest.mock import patch

import bridge
import bridge_runtime


class ProbeTests(unittest.TestCase):
    def test_source_path_probe_does_not_open_database(self):
        config = {"available": True, "dbPath": "D:/PIONEER/Master/master.db"}
        with patch.object(bridge_runtime, "_resolve_rekordbox_config", return_value=config), \
             patch.object(bridge_runtime, "_build_write_status", return_value={}), \
             patch.object(bridge_runtime, "_open_database") as open_database:
            result = bridge._handle_probe({"openDatabase": False})
            self.assertTrue(result["available"])
            self.assertEqual(result["dbPath"], config["dbPath"])
            open_database.assert_not_called()

    def test_default_probe_still_checks_database_and_keeps_busy_error(self):
        config = {"available": True, "dbPath": "D:/PIONEER/Master/master.db"}
        with patch.object(bridge_runtime, "_resolve_rekordbox_config", return_value=config), \
             patch.object(bridge_runtime, "_build_write_status", return_value={}), \
             patch.object(bridge_runtime, "_open_database", side_effect=RuntimeError("database is locked")):
            result = bridge._handle_probe({})
            self.assertFalse(result["available"])
            self.assertEqual(result["errorCode"], "REKORDBOX_DB_BUSY")
            self.assertEqual(result["errorMessage"], "database is locked")


if __name__ == "__main__":
    unittest.main()
