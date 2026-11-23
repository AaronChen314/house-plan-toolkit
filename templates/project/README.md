# 新项目模板

复制本目录到自己的项目位置，修改 `project.json` 的 `id/name`。`id` 在不同项目间必须唯一；路径均相对配置文件。

收到资料后依次建立：

- `source/`：原始图纸与转换文件，不覆盖原件。
- `data/`：原图索引、核查后的空间模型与尺寸依据。
- `design/`：设计变更、当前有效方案及选择记录（需要设计时）。
- `output/`：生成的平面对照、白模及检查报告。

将 `model` 从 `null` 改为 `data/model.json`；从公共包的 `schemas/README.md` 读取数据约定，使用 `cli/space.mjs check/build --project <项目配置>`。

设计版本更新已有三维时，在项目内增加 `design-manifest.json`，按 [设计到三维同步清单](../../../reference/design-sync-manifest.md) 记录设计数据、变更风险、固定机位和门禁状态。先运行 `node toolkit/cli/space.mjs sync check --manifest design-manifest.json`，通过后再构建。

需要风格化彩平或效果图时，按 [设计图像出图 skill](../../../.agents/skills/design-image-render/SKILL.md) 把固定机位或正交底图与风格意向图分开登记；标准彩平优先使用设计器已有的确定性渲染。

若需要真家具，在配置中添加 `assets` 指向本地资产目录的 `catalog.json`，通过 `furnitureBindings` 显式绑定构件。没有原图时保持待导入，不用示例尺寸代替真实资料。
