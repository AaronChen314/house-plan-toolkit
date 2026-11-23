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
├─ data/                 数据源
│  ├─ model.json         space-model/v1 权威空间数据
│  ├─ designs/<A|B>/     设计版本与 design-manifest.json
│  └─ assets/            本项目专用模型、材质、贴图
├─ scripts/              只属于本项目的脚本
├─ checks/               项目专用核查
├─ docs/                 方案说明、比较、交接
└─ output/               生成物唯一出口，不入库
```

```sh
node toolkit/cli/init.mjs --id my-house --name "我的住宅"   # 生成合规骨架
node toolkit/checks/layout.mjs --project projects/my-house/project.json
node toolkit/checks/layout.mjs --project … --strict         # 警告也算失败
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
| W005 | warn | 未写或超出兼容窗口的 `space.lock.json` | 运行锁版本命令 |
| W006 | warn | 项目内有 `.venv`/`venv` | 统一放 `.space/venv` |
| W007 | warn | 缺少 `source/` | 补建并登记资料 |
| W008 | warn | 图片不在 `source/`、`docs/`、`data/assets/`、`output/` | 归位 |

退出码：有 error 为 1；`--strict` 时 warning 也返回 1。`--json` 输出 `layout-report/v1`。

## 写入边界

工具只写以下位置，其余路径需要显式确认：

| 位置 | 用途 |
|---|---|
| `output/` | 生成物 |
| `space.lock.json` | 版本锁 |
| `.agents/skills/`、`.claude/skills/` | 技能同步 |
| `.space/` | venv、缓存、临时文件 |

`check`/`build` 不修改 `data/` 与 `source/`。这条由测试断言保证，不靠口头约定。

## 规则自身的测试

`toolkit/tests/layout.test.mjs`：一个合规骨架必须零错误零警告，每个错误码有独立反例。规则变更必须同时改测试，避免检查器静默失效。
