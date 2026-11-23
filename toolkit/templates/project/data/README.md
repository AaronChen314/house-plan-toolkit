# 项目数据

- `model.json`：`space-model/v1` 空间数据，是三维与核查的唯一数据源。
- `designs/<方案>/`：设计版本（`design.json` 与 `design-manifest.json`）。
- `assets/`：只属于本项目的模型、材质与贴图；通用资产在 CLI 包里。

生成物不放在这里。改数据后运行 `node toolkit/checks/layout.mjs --project project.json`。
