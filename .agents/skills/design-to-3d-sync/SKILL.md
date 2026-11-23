---
name: design-to-3d-sync
description: 编排已确认的平面设计版本同步到三维模型，适用于设计预览、材质、家具、柜体或灯光更新后需要重建三维场景并固定机位复核的任务。
---

# 设计版本到三维同步

这是一个交接和验证入口。它把“已经确认的设计版本”送到三维流程，负责版本锁定、变更分类、阻断检查、构建、固定机位渲染和差异记录。空间设计判断仍由 `floor-plan-design` 完成，建模细节仍由 `plan-to-3d` 完成。

需要彩平图或氛围效果图时，固定机位和空间数据先通过本入口检查，再交给出图入口 [design-image-render](../design-image-render/SKILL.md)。标准彩平优先用设计器已有的确定性渲染；需要风格意向或生图模型时再走该入口。出图只改变表现，不改变几何。

开始前读取[共享数据约定](../../../reference/space-workflow-contract.md)和[同步清单格式](../../../reference/design-sync-manifest.md)；需要出图时再读[图像出图模板](../../../reference/design-image-prompts.md)。

## 输入与边界

- 设计数据是唯一变更来源。预览图、效果图和截图用于验收或风格参考，不能单独驱动模型覆盖。
- 先读取 `design-manifest.json`，确认 `projectId`、版本、设计数据、三维工程和上一次交付版本。
- 没有设计数据、只有图纸或效果图时，交给 `plan-to-3d` 的效果图复现分支；先记录推定尺寸和待确认项，再决定是否允许更新现有模型。
- 这是已有设计版本的同步任务。首次布局设计交给 `floor-plan-design`，没有三维场景时交给 `plan-to-3d`。

## 流程

1. **锁定当前版本。** 记录设计模型、项目配置、三维工程、材质与资产路径。核对设计模型哈希；确认浏览器尺寸覆盖、手工模型修改和外部资产修改已经导出或保存到可追溯文件。
2. **读取变更。** 按稳定构件 ID 读取新增、删除、移动、尺寸、材质和用途变化。保留修改前后值、依据、批准状态和受影响关系。不能用房间名称重新匹配构件。
3. **分类风险。** 将变更分为表现、可配置、结构和设备四类。表现类可自动继续，可配置类在净空与资产检查通过后继续。结构和设备类必须有明确批准记录，否则停在检查阶段。
4. **执行门禁。** 运行 `sync check`，再运行现有 `check`。检查墙体、门窗、梁柱、板、楼梯和标高的变更依据，检查柜顶、吊顶、梁底、门扇、柜门和家具使用空间，检查模型资产的单位、朝向、尺寸、许可和实际文件名。
5. **重建三维。** 门禁通过后，按 `plan-to-3d` 更新当前工程。优先局部更新受影响构件和资产；结构或空间变化影响范围较大时再重建受影响楼层。保留旧工程和旧交付，不覆盖上一版。
6. **固定机位出图。** 用 manifest 中的同一组机位、视平线、焦距和构图渲染。每个机位都要有稳定的 ID 和输出路径。需要新增机位时写入 manifest，不按当前操作随手换角度。
7. **生成表现图。** 需要风格化彩平、室内效果图或鸟瞰图时，调用 [design-image-render](../design-image-render/SKILL.md)。标准彩平可由现有确定性渲染直接导出。基础图使用本次固定机位或正交底图，风格图只负责材质、配色和光线；输出登记到 render-manifest.json，不替代固定机位和三维工程。
8. **对照并交付。** 生成平面叠图、三维鸟瞰、关键室内视角及差异报告。区分已通过、存在冲突和未检查的项目。只有全部必需门禁通过、必需机位实际生成，才把状态写成 `passed`。

## 自动前进规则

| 变更类别 | 例子 | 允许自动继续 |
|---|---|---|
| `presentation` | 墙面、地面、面料、软装、灯光色温 | 数据校验通过后 |
| `configurable` | 活动家具替换、柜门样式、开放格、非结构柜体 | 净空、尺寸和资产检查通过后 |
| `structural` | 墙、门窗洞、梁、柱、板、楼梯、标高 | 有批准记录且结构检查通过后 |
| `services` | 给排水、电气、暖通、设备位置 | 有批准记录且路由与检修检查通过后 |
| `mixed` / `unknown` | 同时包含多类或无法归类 | 拆分或补充依据后 |

任一门禁失败时停止在当前版本，报告具体对象和缺失依据。不得通过删除对象、降低细节或静默缩放让检查通过。

## 输出

在项目的 `output/<project>/design-sync/<version>/` 下保存：

- `manifest.json`：实际使用的输入、变更、门禁结果和输出版本。
- `平面核对.html`、白模或原生三维工程：本次实际构建的文件。
- `render/<camera-id>.png`：manifest 列出的固定机位。
- `visuals/<visual-id>.png` 和 `visuals/render-manifest.json`：可选的彩平图、效果图及其 prompt、参考图角色和验收记录。
- `diff/report.json`、`diff/overlay-*.png`：与上一版的差异和叠图。
- `README.md` 或简短交付说明：通过项、阻断项、未检查项和需要用户确认的事项。

旧版本保留在相邻版本目录。重新运行同一版本时，先确认输入哈希没有变化，再在历史目录保存旧输出。

## 命令

```sh
node toolkit/cli/space.mjs sync check --manifest projects/<id>/design-manifest.json
node toolkit/cli/space.mjs check --project projects/<id>/project.json
node toolkit/cli/space.mjs build --project projects/<id>/project.json --viewer drawing
node toolkit/cli/space.mjs build --project projects/<id>/project.json
```

`sync check` 只验证版本、变更分类和路径，不替代真实构建、浏览器打开或三维工程核查。具体工具不可用时说明缺口，不报告为已完成。
