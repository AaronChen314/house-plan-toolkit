# house-plan-toolkit

把户型图纸整理成可核查的空间数据，再生成平面核对页、三维白模与交付包。仓库提供可安装的 CLI（`space`）和五份领域技能，供人或 AI 代理执行同一套流程。

只包含工具、技能、规范与合成示例。**不含任何真实项目的图纸、数据或生成物**；项目内容放在使用者自己的项目目录。

## 安装

需要 Node.js 20+、Python 3.10+。

```sh
npm install -g github:AaronChen314/house-plan-toolkit#v0.2.0
space setup          # 建 Python 虚拟环境并装依赖（装到包内 .venv）
space doctor         # 自检 Node / Python / 依赖 / 浏览器 / 技能包
```

本地开发用 `npm ci && npm link`。Windows 下 `space setup` 会使用 `.venv/Scripts/python.exe`；也可用 `SPACE_PYTHON` 指定解释器。

## 快速开始

```sh
space init --id my-house --name "我的住宅"      # 生成合规项目骨架
space lint --project my-house/project.json      # 目录与格式自检
space skills sync --project my-house            # 把五份技能装到 my-house/.agents/skills

space build --project examples/two-level/project.json --viewer drawing
space build --project examples/two-level/project.json
space serve examples/two-level/output/白模.html
```

## 命令

| 工作 | 命令 |
|---|---|
| 生成项目骨架 | `space init --id <id> [--name 名称]` |
| 目录与格式校验 | `space lint --project <project.json> [--strict] [--json]` |
| 空间关系校验 | `space check --project <project.json>` |
| 平面核对 / 白模 / 设计器 | `space build --project … --viewer drawing\|white-model\|designer` |
| 设计版本同步门禁 | `space sync check --manifest design-manifest.json` |
| DXF 索引与源图核对页 | `space cad inspect <input.dxf> --out 目录` / `space cad view <source.json> --out 目录` |
| 家具资产 | `space assets list\|search\|add\|inspect` |
| 交付打包 | `space pack --project <project.json>` |
| 版本锁 | `space lock --project <project.json>` |
| 技能 | `space skills build\|check\|sync\|list` |
| 环境 | `space setup` / `space doctor` |
| 发布审计 | `space verify-public [--layout target] [--denylist <私有词表>]` |
| 早期脚本 | `space run <tool-name>`，清单见 `space tools` |

## 目录

| 路径 | 内容 |
|---|---|
| `bin/space.mjs` | CLI 入口 |
| `src/cli/` | 项目加载、构建、预览、初始化、版本锁、技能包、环境自检 |
| `src/space/` | 空间关系、尺寸与覆盖值校验 |
| `src/cad/`、`src/checks/` | DXF 索引、数据/目录/发布边界/浏览器检查 |
| `src/viewers/` | 白模、平面核对、设计器模板与渲染源码 |
| `src/furniture/` | 资产 CLI、GLB 归一与公共 CC0 模型 |
| `src/legacy/` | 早期脚本与 HouseSpec 编译模板，经 `space run` 调用 |
| `schemas/` | `space-project/v1`、`space-model/v1`、`design-sync/v1` |
| `skills/` | 五份技能；`references/` 由 `npm run skills:build` 从 `docs/` 生成 |
| `docs/` | 工作流约定、项目目录规范、发布边界、出图与机电参考 |
| `templates/project/` | 项目骨架模板 |
| `examples/two-level/` | 合成两层示例，用于回归 |
| `tests/` | 目录规则、发布边界、技能包、CLI、空间关系测试 |

## 项目侧约定

项目目录与错误码见 [docs/project-layout.md](docs/project-layout.md)。要点：

- `source/` 只增不改，每个文件在 `source/manifest.json` 登记来源、版本与指纹。
- `data/model.json` 是唯一空间数据源；设计版本放 `data/designs/<方案>/`。
- 生成物只写 `output/`，永不作为数据源。
- `space.lock.json` 锁定工具版本与数据指纹；超出兼容窗口时 `space lint` 提示升级。

## 技能

五份技能各自带 `references/`，复制或安装到任何位置都能独立使用，不依赖本仓库的目录结构：

```sh
space skills check                       # 校验 references 与 docs 一致、链接可解析
space skills build                       # 改过 docs 之后重新生成
space skills sync --project my-house     # 安装到 my-house/.agents/skills
```

`space skills sync` 会在目标目录写 `.skills-version`，便于核对项目用的是哪一版。

## 发布边界

公开内容由 [publish-manifest.json](publish-manifest.json) 白名单控制，`space verify-public` 检查路径、文件类型、本机绝对路径、私有词表、二进制许可与哈希、资产字段和历史提交。规则见 [docs/public-surface.md](docs/public-surface.md)。

敏感词表不进入仓库：放在 `~/.config/house-plan/denylist.txt`，或通过 `SPACE_DENYLIST` 指定。

## 版本

语义化版本：MAJOR 为 CLI 参数或数据契约不兼容，MINOR 为新增能力，PATCH 为修复。兼容窗口为同一 major 下相邻 minor。变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 维护

```sh
npm test                                  # 33 个测试
npm run skills:check
space lint --project examples/two-level/project.json
space build --project examples/two-level/project.json
node src/checks/white-model.mjs examples/two-level/output/白模.html
.venv/bin/python tests/design_sync_test.py
.venv/bin/python tests/cad_test.py
```

## 许可

MIT，见 [LICENSE](LICENSE)。家具模型为 CC0，来源与许可见 `src/furniture/assets/catalog.json`。
