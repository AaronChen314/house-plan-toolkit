# 项目目录与文件格式规范

`layoutVersion: 1`。适用于所有使用本工具的项目。规则不是文档建议，而是 `layout` 检查的实际行为：违反 error 即阻断。

## 目录

```
<project-id>/
├─ project.json          唯一配置入口（schema/id/name/model/output/assets）
├─ space.lock.json       工具版本与数据 schema 锁
├─ README.md             需求、有效资料、当前方案、已废弃方案
├─ AGENTS.md             项目内 AI 工作入口
├─ source/               原始资料，只增不改
│  ├─ drawings/          图纸原件与转换件，YYYYMMDD-用途
│  ├─ survey/            实测、拍照、确认记录
│  └─ manifest.json      每个源文件的用途/版本/来源/指纹
├─ data/                 权威数据
│  ├─ datasets/<id>/     数据集：dataset.json（来源/确认记录/假设）+ model.json
│  ├─ designs/<方案>/    design.json + versions/<seq>.json（版本链、状态、uses）
│  ├─ model.json         兼容：单数据集项目的空间模型
│  └─ assets/            本项目专用模型、材质、贴图
├─ plugins/              可选：项目级能力插件（默认不加载，SPACE_PLUGINS=1 开启）
├─ scripts/              只属于本项目的脚本
├─ checks/               项目专用核查
├─ docs/                 方案说明、比较、交接
├─ output/               生成物唯一出口，不入库
│  ├─ cad/               cad-source/v1 解析产物
│  ├─ doc/               施工图与交付清单 manifest.json
│  ├─ render/            彩平等渲染产物与渲染记录
│  ├─ bundle/            只读交付包（含 index.html 与哈希清单）
│  └─ snapshot/          单文件只读快照
└─ .space/               派生：files.json / events.jsonl / project.sqlite（不入库，可删）
```

数据集的确认记录（`confirmations`）与设计版本的状态是**权威数据**；`.space/` 里的索引与推导图投影只是派生，删掉能重建。

```sh
space init --id my-house --name "我的住宅"   # 生成合规骨架
space lint --project projects/my-house/project.json
space lint --project … --strict         # 警告也算失败
```

## 错误码

| 码 | 级别 | 含义 | 修复 |
|---|---|---|---|
| E001 | error | `project.json` 无法解析、schema 不符或缺 `id` | 按 `space-project/v1` 补齐 |
| E002 | error | `id` 与目录名不一致 | 改目录名或改 `id` |
| E003 | error | `model` 缺失、不在 `data/` 或文件不存在 | 放进 `data/` 并更新配置；无资料写 `null` |
| E004 | error | `output` 不是项目内 `output/` 子路径 | 改为 `output` 或 `output/<子目录>` |
| E005 | error | 项目里出现工具实现（`src/`、`bin/`、`schemas/`、`viewers/`、`package.json`） | 工具代码属于 CLI 仓库 |
| E006 | error | `source/` 文件未登记在 `source/manifest.json` | 登记来源、版本、指纹、用途 |
| E007 | error | 生成物出现在 `output/`（或 `data/assets/`）之外 | 移动，或作为项目资产放入 `data/assets/` |
| E008 | error | 同一项目内出现第二个 `project.json` | 一个目录一个项目 |
| W001 | warn | `source/drawings/` 文件名缺少 `YYYYMMDD-` 前缀 | 便于追溯收到日期 |
| W002 | warn | 使用旧的 `design/` 目录 | 迁入 `data/designs/` |
| W003 | warn | 缺少项目 `README.md` | 记录需求与有效资料 |
| W004 | warn | `output/` 未被忽略 | 加入 `.gitignore` |
| W005 | warn | 未写或超出兼容窗口的 `space.lock.json` | `space lock --project …` 刷新版本锁 |
| W006 | warn | 项目内有 `.venv`/`venv` | 统一放 `.space/venv` |
| W007 | warn | 缺少 `source/` | 补建并登记资料 |
| W008 | warn | 图片不在 `source/`、`docs/`、`data/assets/`、`output/` | 归位 |

退出码：有 error 为 1；`--strict` 时 warning 也返回 1。`--json` 输出 `layout-report/v1`。

## 写入边界

工具只写以下位置，其余路径需要显式确认：

| 位置 | 用途 | 谁写 |
|---|---|---|
| `output/cad/`、`output/doc/`、`output/render/`、`output/bundle/`、`output/snapshot/` | 生成物 | 能力（经存储层） |
| `data/datasets/`、`data/designs/` | 数据集、确认记录、设计版本 | 能力（带 `baseHash` + `confirm`） |
| `space.lock.json` | 版本锁 | `space lock` |
| `.agents/skills/`、`.claude/skills/` | 技能同步 | `space skills sync` |
| `.space/` | 文件登记、事件日志、索引与缓存、venv、临时文件 | 存储层与索引层 |

- `check` / `build` 不修改 `data/` 与 `source/`；渲染与交付过程不改权威数据，这条由测试断言。
- `plugins/` 是只读来源：工具加载但不写回；`~/.cache/house-plan/index.sqlite`（全局摘要）与 `~/.config/house-plan/plugins/`（用户级插件）都在项目之外，不随交付包分发。
- 任何 `output/` 下的产物都不能作为能力的输入（`assertSourceNotGenerated`）。

## 规则自身的测试

`tests/layout.test.mjs`：一个合规骨架必须零错误零警告，每个错误码有独立反例。规则变更必须同时改测试，避免检查器静默失效。
