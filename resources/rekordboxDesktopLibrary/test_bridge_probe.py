"""Run with bundled Python: python -m unittest discover -s resources/rekordboxDesktopLibrary."""

import unittest
from unittest.mock import patch

import bridge
import bridge_runtime


class ProbeTests(unittest.TestCase):
    def test_stale_rekordbox7_config_does_not_hide_valid_rekordbox6(self):
        config7 = {"db_path": "D:/stale/master.db", "version": "7"}
        config6 = {"db_path": "E:/live/master.db", "version": "6"}
        with patch.object(bridge_runtime, "update_config"), \
             patch.object(bridge_runtime, "get_config", side_effect=[config7, config6]), \
             patch.object(bridge_runtime.os.path, "isfile", side_effect=lambda p: p == bridge_runtime._normalize_path(config6["db_path"])):
            result = bridge_runtime._resolve_rekordbox_config()
            self.assertTrue(result["available"])
            self.assertEqual(result["dbPath"], bridge_runtime._normalize_path(config6["db_path"]))

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
