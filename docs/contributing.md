# 开发与调试

面向在这个仓库里改代码的人或 agent。开工前先读本页，再按 [AGENTS.md](../AGENTS.md) 找具体任务的入口文档。

## 环境

| 需要 | 说明 |
|---|---|
| Node.js **22.5+** | 几何索引依赖 `node:sqlite`；20–22.4 能跑但索引降级（`space doctor` 会提示） |
| Python 3.10+ | DXF 解析、几何校验、打包；依赖见 `requirements.txt` |
| Chrome / Chromium | 只有浏览器冒烟检查需要（`src/checks/*.mjs`） |
| 私有词表（可选） | `~/.config/house-plan/denylist.txt` 或 `SPACE_DENYLIST`；没有时 `verify:public` 只做结构检查 |

```sh
npm ci
space setup --project .        # 在仓库内建 .space/venv 并装 Python 依赖
space doctor                   # 逐项确认：Node / Python / 依赖 / 浏览器 / 索引 / 技能包
```

`space doctor` 的「阻塞项」通常只有两类：Python 依赖缺、或 Node 版本不够跑索引。

## 分层与改动落点

依赖单向：契约 → 领域 → 存储 → 能力 → 宿主。改之前先判断落在哪一层。

| 要改什么 | 放哪里 |
|---|---|
| 错误码、schema 登记、能力字段、接口签名 | `src/contracts/` |
| 几何、竖向、规则、差异、图面渲染 | `src/domain/`（纯函数，禁 IO） |
| 读写文件、事件、原子写 | `src/store/`、`src/indexer/` |
| 一个新操作 | `src/capabilities/<域>.mjs` |
| 命令、参数、输出 | `src/cli/commands/` + `src/cli/registry.mjs` |
| 界面 | `src/studio/app/`、`src/server/` |

## 加一个能力

1. 在对应的域文件里追加一个对象（`source` / `model` / `data` / `design` / `program` / `documents` / `render` / `bundle`）。
2. 补齐契约字段：`id`（`域.动词`）、`version`、`stage`、`title`、`description`、`params`、`inputs`、`outputs`、`sideEffects`、`requires`、`idempotent`、`errors`（只能引用 `src/contracts/errors.mjs` 已登记的码）。
3. 在 `src/capabilities/index.mjs` 的数组里加一行展开。
4. 写测试：直接 `import` 该文件的 `capabilities`，用 `createContext` + `store.scope(id)` 调用 `run`。
5. 跑 `space capabilities --check` 和 `npm test`。CLI（`space cap run`）与工作台会自动出现，不需要另写界面。

只有契约、还没实现的，登记到 `PLANNED_CAPABILITIES`（`src/contracts/capability.mjs`）：**不能带 `run`**，必须有 `blockedBy`；两端会置灰并拒绝执行。

## 加一条命令

新建或追加 `src/cli/commands/<域>.mjs`，导出 `{name, group, usage, summary, run(args, {print, error, root})}`，在 `src/cli/registry.mjs` 加 import 与展开项。帮助文本自动生成；`--project` 之类的参数用 `args.take()`，未识别的参数要让调用方看见（默认会报错，透传命令标 `forward: true`）。

## 加一份契约

`src/contracts/<域>.mjs` 导出：schema id、构造函数、校验器（返回问题数组，不抛）、必要常量；在 `schemas.mjs` 登记 schema id。契约测试放 `tests/contracts.test.mjs` 或同域测试文件。

## 验证

```sh
npm run verify        # 快速门禁：232 项测试 + 能力契约 + 目录规范 + 技能包 + 发布边界（约 10 秒）
npm run verify:browser  # 浏览器冒烟：白模 + 工作台（需要 Chrome）
npm run bench:index     # 索引验收数字（五万图元），未达标退出码 1
```

单项：

```sh
npm test                                   # 全量测试
node --test tests/store.test.mjs           # 只跑一个文件（调试时最快）
space lint --project examples/two-level/project.json
space capabilities --check
node src/checks/bundle.mjs <project.json> <包名>   # 交付包离线打开（需要该项目有数据集与设计版本）
```

## 红线（会被测试拦下来）

1. **项目写入只经 `ctx.store`**。`src`、`bin` 里出现 `writeFileSync` / `appendFileSync` / `createWriteStream` 会被 `tests/store.test.mjs` 的静态扫描判红（豁免只有 `src/store/atomic.mjs` 与两个浏览器冒烟脚本）。
2. **领域层无 IO**。`src/domain/**` 不许 `import 'node:…'`、`fs`、`process`。
3. **外部进程只写临时目录**。Python / Blender 写到 `.space/tmp/` 或系统临时目录，产物由 `store.ingest` 搬进项目。
4. **权威数据要带基准哈希**。`writeData(rel, content, {baseHash, confirm: true})`；新建传 `baseHash: null`，冲突即 `E_STORE_CONFLICT`，不静默覆盖。
5. **产物必须确定**。渲染、施工图、快照里不要写时间戳、随机数或本机路径，否则确定性测试会红。
6. **生成物不能当输入**。`output/` 下的东西不能被任何能力读作数据源（`assertSourceNotGenerated`）。
7. **计划项不能带实现**，id 不得与已实现能力重名。
8. **`verify:public` 只扫 git 跟踪的文件**。新增文件先 `git add` 才进检查——曾因此漏掉测试里的本机绝对路径。
9. **测试用 `os.tmpdir()` 临时项目**，不要读写 `examples/`（并发用例会互相污染）。
10. **性能断言分两处**：单测里宽松（只防退化成全表扫描），真实指标由 `npm run bench:index` 独占进程卡。
11. **`skills/*/references/` 是生成物**。改 `docs/` 里被 `skills/skills.json` 引用的文件后跑 `npm run skills:build`，不要手改 references。

## 提交前

```sh
npm run verify && npm run bench:index   # 全绿再提交
```

打版本、预发布 tag 与测试机安装见 [发版与测试流程](release.md)。

`git config core.hooksPath .githooks` 可启用仓库自带的 pre-commit（只跑 `npm test`，约 6 秒）。
