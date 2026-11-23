import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


CHECKER_PATH = Path(__file__).resolve().parents[1] / "src/checks/design_sync.py"
SPEC = importlib.util.spec_from_file_location("design_sync", CHECKER_PATH)
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


class DesignSyncManifestTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        (self.base / "design").mkdir()
        self.design_path = self.base / "design/model.json"
        self.design_path.write_text(json.dumps({"schema": "space-model/v1"}), encoding="utf-8")
        (self.base / "project.json").write_text(
            json.dumps({"schema": "space-project/v1", "id": "sync-test", "name": "test"}),
            encoding="utf-8",
        )
        self.digest = hashlib.sha256(self.design_path.read_bytes()).hexdigest()

    def tearDown(self):
        self.temp.cleanup()

    def write_manifest(self, **overrides):
        manifest = {
            "schema": "design-sync/v1",
            "projectId": "sync-test",
            "version": "test-a",
            "status": "pending",
            "design": {"model": "design/model.json", "sourceSha256": self.digest},
            "model3d": {"project": "project.json"},
            "changes": [],
            "render": {"cameras": [{"id": "living-01", "required": True}]},
        }
        manifest.update(overrides)
        path = self.base / "manifest.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        return path

    def test_configurable_change_passes_when_paths_and_hash_are_valid(self):
        path = self.write_manifest(
            changes=[
                {
                    "id": "chg-1",
                    "objectId": "living:sofa",
                    "kind": "movable_furniture",
                    "risk": "configurable",
                    "approved": True,
                    "evidence": "用户确认替换",
                }
            ]
        )
        report = CHECKER.check_manifest(path)
        self.assertTrue(report["passed"], report)

    def test_structural_change_requires_approval_and_evidence(self):
        path = self.write_manifest(
            changes=[
                {
                    "id": "chg-2",
                    "objectId": "wall-1",
                    "kind": "wall",
                    "risk": "structural",
                }
            ]
        )
        report = CHECKER.check_manifest(path)
        self.assertFalse(report["passed"])
        self.assertTrue(any("尚未批准" in item for item in report["blocks"]))
        self.assertTrue(any("缺少依据" in item for item in report["blocks"]))

    def test_preview_only_is_blocked(self):
        path = self.write_manifest(design={"model": None, "preview": "design/preview.html"})
        report = CHECKER.check_manifest(path)
        self.assertFalse(report["passed"])
        self.assertTrue(any("缺少设计数据" in item for item in report["blocks"]))

    def test_passed_requires_scene_and_required_render(self):
        path = self.write_manifest(status="passed")
        report = CHECKER.check_manifest(path)
        self.assertFalse(report["passed"])
        self.assertTrue(any("三维工程" in item for item in report["blocks"]))
        self.assertTrue(any("必需机位缺少输出路径" in item for item in report["blocks"]))

    def test_passed_with_scene_and_render_passes(self):
        (self.base / "scene.blend").write_text("scene")
        (self.base / "render").mkdir()
        (self.base / "render/living.png").write_text("image")
        path = self.write_manifest(
            status="passed",
            model3d={"project": "project.json", "scene": "scene.blend"},
            render={"cameras": [{"id": "living-01", "path": "render/living.png", "required": True}]},
        )
        report = CHECKER.check_manifest(path)
        self.assertTrue(report["passed"], report)

    def test_project_id_must_match(self):
        path = self.write_manifest(projectId="another-project")
        report = CHECKER.check_manifest(path)
        self.assertFalse(report["passed"])
        self.assertTrue(any("项目 ID 不一致" in item for item in report["blocks"]))

    def test_blocked_status_needs_reason(self):
        path = self.write_manifest(status="blocked")
        report = CHECKER.check_manifest(path)
        self.assertFalse(report["passed"])
        self.assertTrue(any("没有记录阻断原因" in item for item in report["blocks"]))


if __name__ == "__main__":
    unittest.main()
