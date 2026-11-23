# 户型空间工具包

把户型图纸整理成可核查的空间数据，再生成平面核对页、三维白模和交付包。仓库提供两部分：可重复执行的 CLI 工具，以及给 AI 代理使用的领域技能。

本仓库只包含工具、技能、规范文档和合成示例。**不包含任何真实项目的图纸、数据或生成物**；项目内容由使用者自己的项目仓库或本地目录管理。

## 内容

| 目录 | 内容 |
|---|---|
| `toolkit/` | CLI 实现：CAD 索引、空间数据校验、平面核对、白模、家具资产、打包 |
| `toolkit/schemas/` | `space-project/v1`、`space-model/v1`、`design-sync/v1` 数据约定 |
| `toolkit/templates/project/` | 项目骨架模板，含各目录的用途说明 |
| `toolkit/examples/two-level/` | 合成两层示例，用于回归 |
| `.agents/skills/` | 五份领域技能：读图转数据、户型设计、三维建模、设计同步、出图 |
| `reference/` | 空间工作流约定、项目目录规范、公开发布边界、出图与机电参考 |
| `publish-manifest.json` | 公开发布白名单，配套审计脚本 |

## 环境

- Node.js 20 以上
- Python 3.10 以上
- 浏览器检查需要本机 Chrome/Chromium（生成 HTML 不需要）

```sh
npm --prefix toolkit ci
python3 -m venv toolkit/.venv
toolkit/.venv/bin/python -m pip install -r toolkit/requirements.txt
```

Windows 使用 `toolkit/.venv/Scripts/python.exe`。可用 `SPACE_PYTHON` 指定 Python。

## 快速开始

```sh
# 生成一个符合目录规范的项目骨架
node toolkit/cli/init.mjs --id my-house --name "我的住宅"

# 目录与格式自检
node toolkit/checks/layout.mjs --project my-house/project.json

# 独立两层示例：校验、平面核对、白模
node toolkit/cli/space.mjs check --project toolkit/examples/two-level/project.json
node toolkit/cli/space.mjs build --project toolkit/examples/two-level/project.json --viewer drawing
node toolkit/cli/space.mjs build --project toolkit/examples/two-level/project.json
node toolkit/checks/white-model.mjs output/toolkit-two-level/白模.html
```

## 命令

| 工作 | 命令 |
|---|---|
| 生成项目骨架 | `node toolkit/cli/init.mjs --id <id>` |
| 目录与格式校验 | `node toolkit/checks/layout.mjs --project <project.json> [--strict]` |
| 空间关系校验 | `node toolkit/cli/space.mjs check --project <project.json>` |
| 平面核对 / 白模 | `build --viewer drawing` / `build` |
| 设计版本同步 | `sync check --manifest design-manifest.json` |
| DXF 索引与源图核对页 | `cad inspect` / `cad view` |
| 家具资产 | `assets list/search/add/inspect` |
| 交付打包 | `pack --project <project.json>` |
| 早期脚本 | `run <tool-name>`，清单见 `toolkit/legacy/README.md` |
| 公开发布审计 | `node toolkit/checks/public-surface.mjs --layout initial --denylist <私有词表>` |

`space` 命令与可安装包将在后续版本提供；当前统一入口是 `toolkit/cli/space.mjs`。

## 项目侧约定

项目目录、文件格式和错误码见 [reference/project-layout.md](reference/project-layout.md)。要点：

- `source/` 只增不改，每个文件在 `source/manifest.json` 登记来源与指纹。
- `data/model.json` 是唯一空间数据源；设计版本放 `data/designs/<方案>/`。
- 生成物只写 `output/`，永不作为数据源。
- `space.lock.json` 锁定工具版本；校验发现超出兼容窗口会提示升级。

## 发布边界

公开内容由 [publish-manifest.json](publish-manifest.json) 白名单控制，审计脚本检查路径、文件类型、本机绝对路径、私有词表、二进制许可与历史提交。规则见 [reference/public-surface.md](reference/public-surface.md)。

敏感词表不进入仓库：放在 `~/.config/house-plan/denylist.txt`，或通过 `SPACE_DENYLIST` 指定。

## 维护

```sh
npm --prefix toolkit test
node toolkit/checks/layout.mjs --project toolkit/examples/two-level/project.json
node toolkit/cli/space.mjs build --project toolkit/examples/two-level/project.json
node toolkit/checks/white-model.mjs output/toolkit-two-level/白模.html
toolkit/.venv/bin/python toolkit/checks/data.py output/toolkit-two-level/model.json
```

规则变更必须同时更新测试：目录规则在 `toolkit/tests/layout.test.mjs`，发布边界在 `toolkit/tests/public-surface.test.mjs`。

## 许可

MIT，见 [LICENSE](LICENSE)。家具模型为 CC0，来源与许可见 `toolkit/furniture/assets/catalog.json`。
