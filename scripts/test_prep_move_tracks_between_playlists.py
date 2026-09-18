import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import prep_move_tracks_between_playlists as prep


class PrepMoveTracksWorkflowTest(unittest.TestCase):
    def test_triage_apply_uses_successful_dry_run_report_without_reanalysis(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            report_path = Path(temp_dir) / "report.json"
            report_path.write_text(
                '{"summary":{"mode":"dry-run","errorTrackCount":0}}',
                encoding="utf-8",
            )
            with mock.patch.object(prep, "_run_workflow_command", side_effect=[0, 0]) as run:
                result = prep._run_triage(
                    python_path=Path("runtime-python.exe"),
                    triage_script=Path("triage.py"),
                    triage_source="test",
                    triage_target="needReview",
                    bridge_path=Path("bridge.py"),
                    db_path="db-path",
                    sealed_batch_id="batch-1",
                    sealed_batches_root=Path("batches"),
                    dataset_registry=Path("registry.json"),
                    triage_report=report_path,
                    triage_apply=True,
                    extra_args=[
                        "--copy-only",
                        "--target-parent-id",
                        "42",
                        "--device",
                        "cuda",
                        "--only",
                        "artist",
                    ],
                    pre_review=False,
                )

        self.assertEqual(result, 0)
        self.assertEqual(run.call_count, 2)
        dry_run_label, dry_run_cmd = run.call_args_list[0].args
        apply_label, apply_cmd = run.call_args_list[1].args
        self.assertEqual(dry_run_label, "triage dry-run")
        self.assertIn("--source-playlist", dry_run_cmd)
        self.assertEqual(dry_run_cmd[dry_run_cmd.index("--output") + 1], str(report_path))
        self.assertNotIn("--apply", dry_run_cmd)
        self.assertNotIn("--from-report", dry_run_cmd)
        self.assertEqual(
            dry_run_cmd[dry_run_cmd.index("--dataset-registry") + 1], "registry.json"
        )
        self.assertEqual(apply_label, "triage report apply")
        self.assertNotIn("--source-playlist", apply_cmd)
        self.assertEqual(apply_cmd[apply_cmd.index("--from-report") + 1], str(report_path))
        self.assertIn("--apply", apply_cmd)
        self.assertIn("--copy-only", apply_cmd)
        self.assertIn("--target-parent-id", apply_cmd)
        self.assertNotIn("--device", apply_cmd)
        self.assertNotIn("--only", apply_cmd)
        self.assertEqual(apply_cmd[apply_cmd.index("--target-playlist") + 1], "needReview")
        self.assertEqual(apply_cmd[apply_cmd.index("--bridge") + 1], "bridge.py")
        self.assertEqual(apply_cmd[apply_cmd.index("--db-path") + 1], "db-path")
        self.assertEqual(
            apply_cmd[apply_cmd.index("--dataset-registry") + 1], "registry.json"
        )

    def test_triage_dry_run_failure_blocks_report_apply(self) -> None:
        with mock.patch.object(
            prep, "_run_workflow_command", return_value=17
        ) as run, contextlib.redirect_stdout(io.StringIO()):
            result = prep._run_triage(
                python_path=Path("runtime-python.exe"),
                triage_script=Path("triage.py"),
                triage_source="test",
                triage_target="needReview",
                bridge_path=Path("bridge.py"),
                db_path="",
                sealed_batch_id="batch-1",
                sealed_batches_root=Path("batches"),
                dataset_registry=Path("registry.json"),
                triage_report=Path("report.json"),
                triage_apply=True,
                extra_args=[],
                pre_review=False,
            )

        self.assertEqual(result, 17)
        self.assertEqual(run.call_count, 1)

    def test_triage_report_errors_block_report_apply(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            report_path = Path(temp_dir) / "report.json"
            report_path.write_text(
                '{"summary":{"mode":"dry-run","errorTrackCount":2}}',
                encoding="utf-8",
            )
            with mock.patch.object(
                prep, "_run_workflow_command", return_value=0
            ) as run, contextlib.redirect_stdout(io.StringIO()):
                result = prep._run_triage(
                    python_path=Path("runtime-python.exe"),
                    triage_script=Path("triage.py"),
                    triage_source="test",
                    triage_target="needReview",
                    bridge_path=Path("bridge.py"),
                    db_path="",
                    sealed_batch_id="batch-1",
                    sealed_batches_root=Path("batches"),
                    dataset_registry=Path("registry.json"),
                    triage_report=report_path,
                    triage_apply=True,
                    extra_args=[],
                    pre_review=False,
                )

        self.assertEqual(result, 1)
        self.assertEqual(run.call_count, 1)

    def test_triage_without_apply_only_generates_dry_run_report(self) -> None:
        with mock.patch.object(prep, "_run_workflow_command", return_value=0) as run:
            result = prep._run_triage(
                python_path=Path("runtime-python.exe"),
                triage_script=Path("triage.py"),
                triage_source="test",
                triage_target="needReview",
                bridge_path=Path("bridge.py"),
                db_path="",
                sealed_batch_id="batch-1",
                sealed_batches_root=Path("batches"),
                dataset_registry=Path("registry.json"),
                triage_report=Path("report.json"),
                triage_apply=False,
                extra_args=[],
                pre_review=False,
            )

        self.assertEqual(result, 0)
        run.assert_called_once()
        self.assertIn("--output", run.call_args.args[1])
        self.assertNotIn("--apply", run.call_args.args[1])

    def test_sealed_pipeline_runs_prepare_evaluate_finalize_in_order(self) -> None:
        with mock.patch.object(
            prep,
            "_run_json_workflow_command",
            return_value=(0, {"batchId": "batch-new"}),
        ) as prepare_run, mock.patch.object(
            prep, "_run_workflow_command", side_effect=[0, 0]
        ) as run:
            result = prep._run_sealed_pipeline(
                python_path=Path("runtime-python.exe"),
                sealed_script=Path("rkb_sealed_batch.py"),
                playlist="test",
                bridge_path=Path("bridge.py"),
                db_path="db-path",
                batch="latest",
                global_args=["--registry", "registry.json"],
                prepare_args=["--jobs", "3"],
            )

        self.assertEqual(result, (0, "batch-new"))
        prepare_run.assert_called_once()
        self.assertEqual(run.call_count, 2)
        labels = [call.args[0] for call in run.call_args_list]
        self.assertEqual(
            labels,
            ["sealed evaluate", "sealed finalize consume"],
        )
        commands = [prepare_run.call_args.args[1], *[call.args[1] for call in run.call_args_list]]
        self.assertEqual(commands[0][:3], ["runtime-python.exe", "rkb_sealed_batch.py", "prepare"])
        self.assertEqual(
            commands[1][:3], ["runtime-python.exe", "rkb_sealed_batch.py", "evaluate"]
        )
        self.assertEqual(
            commands[2][:3], ["runtime-python.exe", "rkb_sealed_batch.py", "finalize"]
        )
        self.assertEqual(commands[2][-2:], ["--decision", "consume"])
        self.assertEqual(commands[0][0], "runtime-python.exe")
        self.assertIn("--python", commands[0])
        self.assertIn("--registry", commands[0])
        self.assertGreater(commands[0].index("--registry"), commands[0].index("prepare"))
        self.assertGreater(commands[1].index("--registry"), commands[1].index("evaluate"))
        self.assertGreater(commands[2].index("--registry"), commands[2].index("finalize"))
        self.assertIn("--jobs", commands[0])
        self.assertEqual(commands[1][commands[1].index("--batch") + 1], "batch-new")
        self.assertEqual(commands[2][commands[2].index("--batch") + 1], "batch-new")

    def test_each_sealed_failure_stops_remaining_steps(self) -> None:
        cases = (
            ((7, {}), [], 7),
            ((0, {"batchId": "batch-new"}), [8], 8),
            ((0, {"batchId": "batch-new"}), [0, 9], 9),
        )
        for prepare_result, step_results, expected_result in cases:
            with self.subTest(prepare_result=prepare_result, step_results=step_results):
                with mock.patch.object(
                    prep, "_run_json_workflow_command", return_value=prepare_result
                ) as prepare_run, mock.patch.object(
                    prep, "_run_workflow_command", side_effect=step_results
                ) as run, contextlib.redirect_stdout(io.StringIO()):
                    result = prep._run_sealed_pipeline(
                        python_path=Path("runtime-python.exe"),
                        sealed_script=Path("rkb_sealed_batch.py"),
                        playlist="test",
                        bridge_path=Path("bridge.py"),
                        db_path="",
                        batch="latest",
                        global_args=[],
                        prepare_args=[],
                    )
                self.assertEqual(result, (expected_result, ""))
                prepare_run.assert_called_once()
                self.assertEqual(run.call_count, len(step_results))

    def test_main_runs_pre_review_triage_after_move(self) -> None:
        argv = [
            "prep_move_tracks_between_playlists.py",
            "--source",
            "Upan",
            "--target",
            "test",
            "--limit",
            "500",
            "--apply",
            "--then-triage",
        ]
        with mock.patch.object(sys, "argv", argv), mock.patch.object(
            prep, "_move_tracks", return_value={"selectedCount": 500}
        ) as move, mock.patch.object(prep, "_require_empty_playlist") as empty, mock.patch.object(
            prep, "_run_triage", return_value=0
        ) as triage, contextlib.redirect_stdout(
            io.StringIO()
        ):
            result = prep.main()

        self.assertEqual(result, 0)
        move.assert_called_once()
        self.assertEqual(empty.call_count, 2)
        triage.assert_called_once()
        self.assertTrue(triage.call_args.kwargs["pre_review"])
        self.assertEqual(triage.call_args.kwargs["sealed_batch_id"], "")

    def test_main_preserves_user_command_and_orders_internal_workflow(self) -> None:
        argv = [
            "prep_move_tracks_between_playlists.py",
            "--source",
            "Upan",
            "--target",
            "test",
            "--limit",
            "500",
            "--apply",
            "--then-triage",
            "--triage-apply",
        ]
        order: list[str] = []

        def move_tracks(*args, **kwargs):
            order.append("move")
            return {"selectedCount": 500}

        def run_triage(*args, **kwargs):
            order.append("triage")
            self.assertTrue(kwargs["triage_apply"])
            self.assertEqual(kwargs["triage_source"], "test")
            self.assertEqual(kwargs["sealed_batch_id"], "")
            self.assertTrue(kwargs["pre_review"])
            return 0

        with mock.patch.object(sys, "argv", argv), mock.patch.object(
            prep, "_move_tracks", side_effect=move_tracks
        ), mock.patch.object(
            prep, "_require_empty_playlist"
        ), mock.patch.object(
            prep, "_run_triage", side_effect=run_triage
        ), contextlib.redirect_stdout(io.StringIO()):
            result = prep.main()

        self.assertEqual(result, 0)
        self.assertEqual(order, ["move", "triage"])

    def test_main_passes_explicit_workflow_overrides(self) -> None:
        argv = [
            "prep_move_tracks_between_playlists.py",
            "--apply",
            "--then-triage",
            "--triage-python",
            "triage-python.exe",
            "--triage-script",
            "custom-triage.py",
            "--triage-report",
            "custom-report.json",
            "--sealed-batches-root",
            "batches",
            "--sealed-registry",
            "registry.json",
        ]
        with mock.patch.object(sys, "argv", argv), mock.patch.object(
            Path, "is_file", return_value=True
        ), mock.patch.object(
            prep, "_move_tracks", return_value={"selectedCount": 500}
        ), mock.patch.object(
            prep, "_require_empty_playlist"
        ), mock.patch.object(
            prep, "_run_triage", return_value=0
        ) as triage, contextlib.redirect_stdout(io.StringIO()):
            result = prep.main()

        self.assertEqual(result, 0)
        self.assertEqual(triage.call_args.kwargs["python_path"], Path("triage-python.exe"))
        self.assertEqual(triage.call_args.kwargs["triage_script"], Path("custom-triage.py"))
        self.assertEqual(triage.call_args.kwargs["triage_report"], Path("custom-report.json"))
        self.assertEqual(triage.call_args.kwargs["sealed_batch_id"], "")
        self.assertEqual(triage.call_args.kwargs["sealed_batches_root"], Path("batches"))
        self.assertEqual(triage.call_args.kwargs["dataset_registry"], Path("registry.json"))
        self.assertTrue(triage.call_args.kwargs["pre_review"])

    def test_default_workflow_python_uses_configured_demucs_root(self) -> None:
        self.assertEqual(
            prep.DEFAULT_RUNTIME_PYTHON,
            prep._resolve_demucs_root()
            / "win32-x64"
            / "runtime-cpu"
            / "python.exe",
        )
        self.assertTrue(prep.DEFAULT_RUNTIME_PYTHON.is_file())


if __name__ == "__main__":
    unittest.main()
