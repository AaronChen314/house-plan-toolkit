#!/usr/bin/env python3
"""Validate a design-to-3D sync manifest and report blocking conditions."""

import argparse
import hashlib
import json
from pathlib import Path
import sys

from jsonschema import Draft202012Validator


SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schemas/design-sync.schema.json"
GATED_RISKS = {"structural", "services", "mixed", "unknown"}


def read_json(path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve(base, value):
    if not value:
        return None
    path = Path(value)
    return path if path.is_absolute() else base / path


def check_manifest(manifest_path):
    manifest_path = Path(manifest_path).resolve()
    report = {"passed": False, "manifest": str(manifest_path), "blocks": [], "warnings": []}

    try:
        manifest = read_json(manifest_path)
        schema = read_json(SCHEMA_PATH)
    except (OSError, json.JSONDecodeError) as error:
        report["blocks"].append(f"无法读取清单或 Schema：{error}")
        return report

    errors = sorted(Draft202012Validator(schema).iter_errors(manifest), key=lambda item: list(item.path))
    for error in errors:
        path = ".".join(str(part) for part in error.absolute_path) or "manifest"
        report["blocks"].append(f"{path}: {error.message}")
    if errors:
        return report

    base = manifest_path.parent
    design_model = resolve(base, manifest["design"]["model"])
    project_path = resolve(base, manifest["model3d"]["project"])

    if design_model is None:
        report["blocks"].append("缺少设计数据；只有预览图或效果图时不能自动更新三维")
    elif not design_model.is_file():
        report["blocks"].append(f"设计数据不存在：{design_model}")

    if not project_path.is_file():
        report["blocks"].append(f"三维项目配置不存在：{project_path}")
    else:
        try:
            project = read_json(project_path)
        except json.JSONDecodeError as error:
            report["blocks"].append(f"三维项目配置不是有效 JSON：{error}")
        else:
            if project.get("schema") != "space-project/v1":
                report["blocks"].append("三维项目配置不是 space-project/v1")
            if project.get("id") != manifest["projectId"]:
                report["blocks"].append(
                    f"项目 ID 不一致：manifest={manifest['projectId']} project={project.get('id')}"
                )

    expected_digest = manifest["design"].get("sourceSha256")
    if design_model and design_model.is_file():
        if expected_digest:
            actual_digest = sha256(design_model)
            if actual_digest.lower() != expected_digest.lower():
                report["blocks"].append("设计数据哈希与清单不一致")
        elif manifest["status"] == "passed":
            report["blocks"].append("passed 状态必须记录设计数据哈希")
        else:
            report["warnings"].append("尚未记录设计数据哈希，交付前补齐")

    change_ids = set()
    for change in manifest["changes"]:
        change_id = change["id"]
        if change_id in change_ids:
            report["blocks"].append(f"变更 ID 重复：{change_id}")
        change_ids.add(change_id)
        if change["risk"] in GATED_RISKS:
            if not change.get("approved"):
                report["blocks"].append(f"{change_id} 属于 {change['risk']} 变更，尚未批准")
            if not change.get("evidence", "").strip():
                report["blocks"].append(f"{change_id} 属于 {change['risk']} 变更，缺少依据")

    camera_ids = set()
    for camera in manifest["render"]["cameras"]:
        camera_id = camera["id"]
        if camera_id in camera_ids:
            report["blocks"].append(f"机位 ID 重复：{camera_id}")
        camera_ids.add(camera_id)

    if manifest.get("blockers"):
        report["blocks"].extend(manifest["blockers"])
    elif manifest["status"] == "blocked":
        report["blocks"].append("status 为 blocked，但没有记录阻断原因")

    if manifest["status"] == "passed":
        scene_value = manifest["model3d"].get("scene")
        scene = resolve(base, scene_value)
        if not scene:
            report["blocks"].append("passed 状态必须记录三维工程")
        elif not scene.is_file():
            report["blocks"].append(f"已标记 passed，但三维工程不存在：{scene}")
        for camera in manifest["render"]["cameras"]:
            if camera.get("required", False) and camera.get("path"):
                render = resolve(base, camera["path"])
                if not render.is_file():
                    report["blocks"].append(f"已标记 passed，但必需机位未生成：{camera['id']}")
            elif camera.get("required", False):
                report["blocks"].append(f"必需机位缺少输出路径：{camera['id']}")

    if manifest["status"] == "passed" and not manifest["render"]["cameras"]:
        report["blocks"].append("passed 状态至少需要一个固定机位")

    report["status"] = manifest["status"]
    report["next"] = "修复上述阻断项后重试" if report["blocks"] else "可以进入三维构建"
    report["passed"] = not report["blocks"] and manifest["status"] != "blocked"
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest")
    args = parser.parse_args()
    report = check_manifest(args.manifest)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
