# house-plan-toolkit

把户型图纸整理成可核查的空间数据（数据集 + 逐项确认），再演进为设计版本，产出拆改图、彩平图、三维白模与只读交付包。仓库提供可安装的 CLI（`space`）、本地工作台和五份领域技能，供人或 AI 代理执行同一套流程。

只包含工具、技能、规范与合成示例。**不含任何真实项目的图纸、数据或生成物**；项目内容放在使用者自己的项目目录。

## 安装

需要 Node.js 20+、Python 3.10+。**几何索引需要 Node 22.5+**（`node:sqlite`）；低版本只是没有索引，其余能力按每次解析工作，`space doctor` 会提示。

```sh
npm install -g github:AaronChen314/house-plan-toolkit#v0.7.1
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

| 阶段 | 命令 |
|---|---|
| 项目 | `init` · `lock` · `lint` · `check` · `build` · `pack` · `store` · `index` · `graph` · `sync` |
| 数据 | `dataset build\|diff\|correct` · `annotation confirm\|list` · `program check` |
| 设计 | `design create\|version\|fork\|confirm\|stale` |
| 交付 | `doc render\|check\|list` · `render colorplan` · `bundle export` · `deliver snapshot` |
| 图纸与资产 | `cad inspect\|view` · `assets` · `serve` · `model convert` |
| 技能与环境 | `skills` · `plugin` · `doctor` · `setup` · `verify-public` |
| 其他 | `cap list\|show\|run` · `capabilities` · `studio` · `tools` · `run` · `version` |

常用入口：

| 工作 | 命令 |
|---|---|
| 生成项目骨架 | `space init --id <id> [--name 名称]` |
| 目录与格式校验 | `space lint --project <project.json> [--strict] [--json]` |
| 空间关系校验 | `space check --project <project.json>` |
| 平面核对 / 白模 | `space build --project … --viewer drawing\|white-model` |
| DXF 索引与解析缓存 | `space cad inspect <input.dxf> --out 目录` / `space index rebuild` |
| 数据集与校正 | `space dataset build … --confirm` · `space dataset correct …` |
| 逐项确认 | `space annotation confirm … --basis "依据"` |
| 设计版本 | `space design create\|version\|fork\|confirm\|stale` |
| 折改/净空/动线 | `space program check --project <project.json>` |
| 施工图（折改图） | `space doc render --project … --scheme a --seq 1` |
| 彩平图 | `space render colorplan --project … --scheme a --seq 1` |
| 交付包 / 快照 | `space bundle export …` · `space deliver snapshot …` |
| 本地工作台 | `space studio --project <project.json> [--open]` |
| 能力门面 | `space cap list\|show\|run`（参数由契约生成） |
| 能力清单与契约 lint | `space capabilities [--check]` |
| 能力插件 | `SPACE_PLUGINS=1 space plugin list` |
| 跨项目摘要 | `space index global sync\|list\|stat` |
| 版本锁 | `space lock --project <project.json>` |
| 技能 | `space skills build\|check\|sync\|list` |
| 环境 | `space setup` / `space doctor` |
| 发布审计 | `space verify-public [--layout target] [--denylist <私有词表>]` |

## 架构与数据

依赖方向单向：契约 → 领域 → 存储 → 能力 → 宿主。能力只有一份实现，CLI 与工作台都调用它；视图只读；所有项目写入经过存储层。

数据采用「文件是事实源、`.space` 是派生索引」：数据集、设计版本、确认记录都是可读、可 diff、可交付的 JSON；几何索引、推导图投影、事件日志放在项目内 `.space/`，删掉可重建。设计只能引用数据集，设计之间只允许复制，不允许派生；生成物永远不能当输入。

- [docs/architecture.md](docs/architecture.md)：分层职责、三种关系、存储模型、写入纪律、决策记录
- [docs/storage.md](docs/storage.md)：契约清单、存储接口、索引与视口、推导图、施工图、渲染交付、插件与全局索引
- [docs/roadmap.md](docs/roadmap.md)：M0–M5 进度、验收数字与未完成清单

## 目录

| 路径 | 内容 |
|---|---|
| `bin/space.mjs` | CLI 入口：只做分发，命令在 `src/cli/commands/` |
| `src/contracts/` | L0 契约：错误码、schema 登记、能力字段、存储接口、推导图、文档、渲染、插件、全局索引 |
| `src/domain/` | L1 纯函数：几何、竖向、图与影响面、数据集差异、规则检查、图面渲染与投影 |
| `src/store/` | L2 唯一写入入口：原子写、基准哈希、事件日志、内容寻址、交付清单 |
| `src/indexer/` | L2 索引：SQLite schema、包围盒查询、解析缓存、验收基准、全局摘要 |
| `src/capabilities/` | L3 能力：`source` / `data` / `design` / `model` / `documents` / `render` / `bundle` + 插件加载 |
| `src/cli/` | L4 宿主：参数、命令注册表、命令实现、环境自检 |
| `src/server/`、`src/studio/` | L4 宿主：工作台服务与前端 |
| `src/viewers/` | 视图：白模、平面核对、设计器模板 |
| `src/cad/`、`src/checks/` | DXF 解析、目录/发布/浏览器/交付包检查 |
| `src/furniture/` | 家具资产 CLI 与公共 CC0 模型 |
| `src/space/` | 兼容出口：纯函数已下沉到 `src/domain/` |
| `src/legacy/` | 早期脚本与 HouseSpec 编译模板，经 `space run` 调用 |
| `schemas/` | 17 份数据 schema 的说明与 JSON Schema（见 `schemas/README.md`） |
| `skills/` | 五份技能；`references/` 由 `npm run skills:build` 从 `docs/` 生成 |
| `docs/` | 架构、存储与契约、实现计划、工作流约定、目录规范、发布边界、出图与机电参考 |
| `templates/project/` | 项目骨架模板 |
| `examples/two-level/` | 合成两层示例，用于回归 |
| `tests/` | 契约、存储、索引、能力、宿主、确定性与静态扫描 |

## 项目侧约定

项目目录与错误码见 [docs/project-layout.md](docs/project-layout.md)。要点：

- `source/` 只增不改，每个文件在 `source/manifest.json` 登记来源、版本与指纹。
- `data/datasets/<id>/` 放数据集（`dataset.json` + `model.json`）与确认记录；`data/designs/<方案>/` 放方案与版本链。
- 生成物只写 `output/`：`cad/`、`doc/`、`render/`、`bundle/`、`snapshot/`，永不作为数据源。
- `space.lock.json` 锁定工具版本与数据指纹；超出兼容窗口时 `space lint` 提示升级。
- `.space/` 放文件登记、事件日志与 `project.sqlite`；可删除、可重建，不进版本库，也不随交付包分发。
- 可选 `plugins/` 放项目级能力插件；默认不加载，`SPACE_PLUGINS=1` 才启用。

## 本地工作台

```sh
space studio --project my-house/project.json --open
```

随包发布的前端应用，所有项目共用。侧边栏按「图纸 → 数据 → 设计 → 三维 → 交付」组织能力，表单与按钮由能力契约生成：DXF 索引、源图核对、数据集、逐项确认、设计版本、空间数据校验、拆改/净空/动线检查、拆改图、彩平图、交付包与快照、外部模型预览、Blender 转 GLB。计划中的能力置灰且不可执行。

另外三个面板：**几何索引**（按视口分页取图元，首屏不传整包）、**确认清单**（逐项确认，必须写依据）、以及索引摘要/重建提示。前端由 esbuild 在启动时打包，项目只提供数据。详见 [docs/studio.md](docs/studio.md)。

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

开发环境、分层落点与红线见 [docs/contributing.md](docs/contributing.md)；发版、预发布 tag 与测试机安装见 [docs/release.md](docs/release.md)。

```sh
npm run verify                              # 快速门禁：测试 + 契约 + 目录 + 技能 + 发布边界
npm run verify:browser                      # 浏览器冒烟（需要 Chrome）
npm test                                    # 232 项：契约/存储/索引/能力/宿主/确定性
npm run bench:index                         # 索引验收数字（五万图元，未达标退出码 1）
npm run skills:check
space lint --project examples/two-level/project.json
space build --project examples/two-level/project.json
node src/checks/white-model.mjs examples/two-level/output/白模.html
node src/checks/studio.mjs <project.json>          # 工作台视口取数冒烟
node src/checks/bundle.mjs <project.json> <包名>    # 交付包离线打开冒烟
node src/checks/public-surface.mjs --layout target  # 等同 npm run verify:public
.venv/bin/python tests/design_sync_test.py
.venv/bin/python tests/cad_test.py
```

## 许可

MIT，见 [LICENSE](LICENSE)。家具模型为 CC0，来源与许可见 `src/furniture/assets/catalog.json`。
