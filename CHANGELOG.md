# 变更记录

## 0.2.0 — 2026-11-23

首个可作为独立工具安装的版本。

### 新增

- `space` 命令：`init`、`lock`、`lint`、`doctor`、`setup`、`skills build|check|sync|list`、`verify-public`。
- 技能自包含：每份技能带 `references/`，由 `docs/` 单一源生成；`skills:check` 校验一致性与链接。
- 目录规范校验（E001–E008 / W001–W008）与项目骨架模板；`space init` 生成即合规。
- 公开发布审计（P000–P007）：白名单、禁止类型、绝对路径、私有词表、二进制许可与哈希、历史提交。
- 版本锁 `space.lock.json`：工具版本、schema、布局版本、数据指纹。

### 变更

- 目录重组为 `bin/`、`src/`、`schemas/`、`skills/`、`docs/`、`templates/`、`examples/`、`tests/`。
- 依赖分层：`three`、`esbuild` 为必需；`puppeteer-core`、`@gltf-transform/*`、`sharp` 改为可选，缺失时 `space doctor` 说明降级范围。
- 公共家具资产改名，去掉具体项目痕迹；项目专用资产不再进入公共包。
- 示例项目改为完全合规：数据放 `data/`、输出在项目内 `output/`、含 `source/manifest.json` 与版本锁。

### 移除

- 根目录兼容层 `scripts/`、`assets/`、旧 `README.md` 与 `SKILL.md`；早期脚本统一在 `src/legacy/`，通过 `space run` 调用。
- 示例截图与第三方户型截图不再随包发布。

### 兼容

- 数据格式仍为 `space-project/v1`、`space-model/v1`、`design-sync/v1`；0.1.x 的项目可直接被 0.2 读取。
- 项目配置里的 `output` 必须位于项目内 `output/`，旧配置需按 `space lint` 提示迁移。
