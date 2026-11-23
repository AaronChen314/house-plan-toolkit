# 设计到三维同步清单 v1

`design-manifest.json` 记录一张已确认平面设计如何同步到三维工程。JSON Schema 位于 [design-sync.schema.json](design-sync.schema.json)，校验命令为 `space sync check --manifest <文件>`。

路径均相对 manifest 所在目录。设计数据、项目配置和三维工程分开记录；预览图不是设计数据的替代品。

## 最小结构

```json
{
  "schema": "design-sync/v1",
  "projectId": "example-house",
  "version": "2026-11-19-a",
  "status": "pending",
  "design": {
    "model": "design/model.json",
    "preview": "design/preview.html",
    "sourceSha256": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "model3d": {
    "project": "project.json",
    "scene": "model/scene.blend",
    "currentVersion": "2026-11-18-a"
  },
  "changes": [
    {
      "id": "chg-001",
      "objectId": "living-room:sofa",
      "kind": "movable_furniture",
      "risk": "configurable",
      "approved": true,
      "evidence": "用户确认替换，尺寸按现有占地核对"
    }
  ],
  "render": {
    "profile": "interior-default",
    "cameras": [
      {"id": "living-room-01", "path": "render/living-room-01.png", "required": true}
    ]
  },
  "assumptions": [],
  "blockers": []
}
```

示例中的哈希是占位值，实际使用前替换为设计模型文件的 SHA-256。

## 字段

| 字段 | 规则 |
|---|---|
| `schema` | 固定为 `design-sync/v1` |
| `projectId` | 必须与 `model3d.project` 中的项目 ID 一致 |
| `version` | 版本标识，字母、数字、点、下划线或短横线 |
| `status` | `pending`、`passed` 或 `blocked` |
| `design.model` | 已确认的设计数据；可为 `null`，此时不能自动构建三维 |
| `design.preview` | 平面预览或对照页，仅作验收视图 |
| `design.sourceSha256` | 设计模型哈希；`passed` 状态必须提供 |
| `model3d.project` | 公共项目配置 `space-project/v1` |
| `model3d.scene` | 当前可编辑三维工程；首次构建可为空 |
| `changes[]` | 本次变更，含稳定对象 ID、类别、风险、批准和依据 |
| `render.cameras[]` | 固定机位 ID、输出路径和是否必需；ID 不得重复 |
| `assumptions[]` | 本次允许的预览推定，不改写原始事实 |
| `blockers[]` | 尚未解决、导致不能自动前进的问题 |

## 风险与批准

`risk` 使用 `presentation`、`configurable`、`structural`、`services`、`mixed` 或 `unknown`。结构和设备变更必须 `approved: true`，并写入依据。`mixed` 和 `unknown` 先拆分或补依据，不自动继续。

`passed` 还要求：没有未解决 blocker，设计模型哈希存在且匹配，三维工程和所有必需机位已经生成。状态不能因为网页能打开或一张预览图存在而写成 `passed`。

## 覆盖与版本

- 旧三维工程、旧渲染和旧 manifest 保留在相邻版本目录。
- 同一版本重跑前保存旧输出到历史目录；输入哈希变化时提升版本。
- 浏览器修改、手工模型修改和外部资产替换先导出或归档，再作为新版本输入。
- 预览图可以重新生成，不能反向覆盖设计模型、构件 ID 或用户确认值。
