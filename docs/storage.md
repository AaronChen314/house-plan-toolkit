# 契约与存储（M0 已落地）

这份文档描述 `src/contracts/`、`src/domain/`、`src/store/` 三层现在实际是什么样、怎么用，以及写入纪律的检查方式。分层理由见 [架构设计](architecture.md)，演进计划见 [实现计划](roadmap.md)。

## 现在代码分四层

| 层 | 目录 | 约束 |
|---|---|---|
| L0 契约 | `src/contracts/` | 只有声明与校验，不读文件、不写文件 |
| L1 领域 | `src/domain/` | 纯函数；禁止引入 `fs`、`http`、`child_process`（测试静态卡住） |
| L2 存储 | `src/store/` | 唯一写入入口；原子写、乐观锁、事件日志、内容寻址 |
| L3 能力 | `src/capabilities/` | 只声明契约字段并编排；写入只经 `ctx.store` |
| L6 宿主 | `bin/`、`src/server/` | 参数解析与界面；不含业务规则 |

`src/space/model.mjs` 与 `src/space/dimensions.mjs` 保留为兼容出口，函数体已下沉到 `src/domain/`。视图（`src/viewers/`）继续从原路径引用，构建产物不变。

## 契约层

- `errors.mjs`：四类前缀的错误码表（`E_DATA_` 数据与规则、`E_EXEC_` 执行与依赖、`E_STORE_` 存储与并发、`E_PUBLISH_` 发布边界）。`fail(code, message)` 拒绝表外代码。
- `schemas.mjs`：数据 schema 登记表（`space-project/v1`、`space-model/v1`、`cad-source/v1`、`space-lock/v1`、`space-files/v1`、`space-events/v1`、`space-index/v1`）与兼容窗口判断。
- `capability.mjs`：能力契约的固定字段。`inputs`/`outputs` 只能用已登记 schema、`path:<ext>` 或 `artifact:<kind>`，`errors` 只能引用表内代码。
- `store.mjs`：存储接口签名、不变量、写入模式、权威目录清单、派生物目录清单。
- `transport.mjs`：CLI 退出码、结果外壳、作业帧与 worker 帧。

## 存储层

一个项目一个存储实例，状态都在项目内：

```
<project>/.space/
  files.json     文件登记：路径 → 哈希、大小、模式（data/artifact）、时间
  events.jsonl   事件日志，只追加：每次写入与每次操作各一条
  objects/<h>    内容寻址的解析产物与导出包
  tmp/           外部进程的暂存目录，随用随删
  project.sqlite 几何索引（派生存储，M1）
  cache/         解析缓存（派生存储，M1）
```

接口（`src/contracts/store.mjs` 定义签名，`src/store/index.mjs` 实现）：

- 读：`readText`、`readJson`、`readBuffer`、`hashOf`、`exists`
- 写派生物：`writeArtifact(rel, content, {kind})`
- 写权威数据：`writeData(rel, content, {baseHash, confirm})`
- 外部进程产物：`staging()` 拿暂存目录，产物用 `ingest()` 搬进项目
- 缓存：`putObject(buffer)` / `getObject(sha256)`
- 校验与重建：`verify()`、`rebuild()`
- 操作留痕：`operation({op, status, ms})`；`scope(op)` 把一批写入标上同一个操作名
- 派生存储：`derived('index' | 'cache')` → `{path, exists(), stat(), reset(), commit({op, summary})}`

写入规则：

1. 路径必须在项目内；`.space/` 内部目录不通过公开接口修改。
2. `source/`、`data/`、`docs/`、`checks/` 与项目根上的 `project.json`、`space.lock.json` 属于权威位置，只能 `writeData`。
3. `writeData` 必须传 `baseHash`（新建传 `null`）并显式 `confirm: true`；哈希不一致直接拒绝，不静默覆盖。
4. 每次写入都追加一条 `write` 事件；内容未变的写入也会留痕（`status: "unchanged"`），但不重写文件。
5. 一旦写失败，目标文件保持原样，只留下可清理的临时文件；`rebuild` 会清掉它们。
6. 事件日志只追加；`rebuild` 只重建文件登记，不改历史。
7. 派生存储（索引、解析缓存）自己管文件（SQLite 要 WAL），存储层只给位置、项目锁和**一条汇总事件**；它们不进文件登记，不参与逐文件哈希——删掉 `.space/` 必须能原样重建。

## 命令

```sh
space store verify --project <project.json> [--strict] [--json]
space store rebuild --project <project.json>
space store events --project <project.json> [--limit N] [--json]
space store stat --project <project.json>
space capabilities --check
```

- `verify`：逐文件核对登记哈希与磁盘内容，报告缺失、变更、未登记、残留临时文件。`--strict` 把未登记文件也算失败。
- `rebuild`：删掉的 `.space/` 或外部改动之后，从磁盘重建登记；不重跑解析、不改事件历史。
- `events`：一条命令导出事件日志，可接 `jq` 做审计。

## 几何索引（M1）

`.space/project.sqlite` 是派生存储，删掉能重建。schema 与 [架构设计](architecture.md) 的示意一致：`node`、`edge`、`node_version`、`fork`、`entity`、`entity_rtree`、`event`、`meta`。唯一差异是 `entity` 多了整数主键 `id`——rtree 虚表要整数 rowid，业务标识仍是 `(dataset, handle)`。

```sh
space index rebuild --project <project.json> [--source 路径] [--force]
space index stat    --project <project.json>
space index query   --project <project.json> [--box x1,y1,x2,y2] [--layer L] [--type T] [--limit N] [--offset N] [--count]
space index layers  --project <project.json>
```

- **来源**：`--source` 指向 `cad-source/v1` 索引文件（如 `output/cad/source.json`）时直接建库，不解析；指向 `.dxf` 时先查解析缓存，未命中才调 `src/cad/read.py`。不带 `--source` 时优先用 `output/cad/source.json`，否则取 `source/drawings/` 下的第一份 DXF。
- **缓存键**：源文件哈希 + 解析器标识与版本 + 参数（`src/indexer/parse-cache.mjs`）。缓存文件在 `.space/cache/<key>.json`。
- **分页**：默认不数总数，靠多取一行判断是否还有下一页（`nextOffset`/`hasMore`）。要「共 N 条」时加 `--count`——全量 COUNT 是查询里最贵的一步。
- **重建代价**：整表 drop + 重建，比逐行删除快一个数量级（rtree 逐行删除在五万图元上要 200ms+）。索引里已有别的数据集时才按数据集删。

### 降级

索引需要 `node:sqlite`（Node 22.5+）。不可用时：

- `space doctor` 报 `! 几何索引` 并给出升级提示；
- `space index stat/query` 返回 `available: false` 而不是抛错；
- 其余能力照常工作，只是退回「每次解析」。

### 验收

```sh
npm run bench:index
```

在独占进程里跑五万合成图元，输出并卡住 roadmap 的数字（不达标退出码 1）：

| 指标 | 门槛 | 本机实测 |
|---|---|---|
| 解析缓存命中（五万图元） | < 50ms | 15ms |
| 包围盒查询 5000 条 | p50 < 5ms | 3.99ms（p95 4.43ms） |
| 删索引后重建 | 不重新解析 | 命中缓存，解析调用 1 次 |
| 首次建索引（五万图元） | 参考值 | ~295ms（解析 + 建库） |

单元测试只守住「不会退化成全表扫描」（中位 < 50ms），避免与其他用例抢 CPU 时误报；指标本身由上面的基准命令验收。

## 推导图与失效传播（M2 契约）

契约在 `src/contracts/graph.mjs`，算法在 `src/domain/graph.mjs`，都是纯函数。

### 三种关系，三种存法

| 关系 | 含义 | 存在哪 |
|---|---|---|
| 派生 `derived` | 下游的输入是上游，上游变化让下游失效 | `edge(src, dst, role='derived')` |
| 版本 `version` | 同一实体的第 N 次修改，属同一条链 | `node_version(node, seq, parent_seq)` |
| 复制 `fork` | 抄一份，之后互不影响，只记录来源 | `fork(node, copied_from)`，同时留一条 `edge(role='fork')` |

版本**不是边**：`canEdge(..., 'version')` 直接返回拒绝，避免有人把两个不同实体连成「版本」。

### 派生矩阵（反向依赖一律禁止）

| 来源 | 允许派生到 |
|---|---|
| `source` | `dataset` |
| `dataset` | `dataset`（校正产生新数据集）、`design` |
| `design` | `model`、`render`、`document`、`bundle` |
| `model` | `render`、`document`、`bundle` |
| `render` / `document` | `bundle` |
| `bundle` | — |

复制只允许 `design → design`。数据集不能复制（只能从原件解析或校正），模型不能成为设计的输入。

### 状态与写入位置

状态机：`draft → confirmed → stale → confirmed …`，任何状态可 `→ superseded`，`superseded` 是终点。

**`markStale` 写文件，不写索引。** 这条是硬规矩：

- 权威：`data/datasets/<id>/dataset.json`、`data/designs/<方案>/versions/<seq>.json` 里的 `status`
- 索引里的 `node.status` 只是投影，`space index rebuild` 会从文件重建它
- 如果反过来把状态只写进 `.space/project.sqlite`，删掉索引就会把「待复核」结论抹掉——而那是要交给客户的结论

路径只能由 `datasetFile()` / `designFile()` / `designVersionFile()` 给出，任何 lane 不许自己拼目录。

### 失效传播

```js
staleAfterChange({changed, nodes, edges})
// → {affected, stale, skipped, truncated}
```

规则与验收：

- 只沿 `derived` 走，`fork` 不传播（复制出来的方案不受原方案变化影响）；
- 只把 `confirmed` 的受影响节点标成 `stale`；`draft` 无需标记，`stale` 不重复标，`superseded` 保持；
- 不删除、不自动重算：工作台展示清单，人确认后才产生新版本；
- 一千节点的影响分析中位 < 5ms（`tests/graph.test.mjs` 卡住）；
- 「校正只影响引用了该数据集的版本」有专门的用例：未引用的设计及其下游保持 `confirmed`。

### 投影与命令

图投影的写入只有一个入口：`src/store/graph.mjs`。

```sh
space graph sync  --project <project.json>          # 从 data/ 重建投影
space graph show  --project <project.json> [--json] # 同步后打印节点/边/复制/版本
space graph stale --project <project.json> --node d1 # 失效预演，不改数据
```

- `graph show` / `graph stale` 会先 `projectFromFiles()` 刷新投影，避免拿上次同步的旧下结论；`sync` 用于 CI 与批处理。
- 声明 `write:data` 的能力执行成功后，能力层会自动刷新投影（`runCapability` 里统一处理），结果里带 `graph` 计数；刷新失败只记日志，不让能力整体失败。
- 节点状态：数据集的取 `dataset.json.status`；设计的取**最新版本**的 `status`（草稿/已确认/待复核/已作废）。
- `graph stale` 只预演「该标谁」，真正的状态改写发生在版本文件上（`space design stale` 单条，后续由确认流批量产生新版本）。
- 索引里的 `node.status` 永远可被 `space index rebuild` + `space graph sync` 从文件恢复。

### 已落地的 M2 能力

| 能力 | 副作用 | 说明 |
|---|---|---|
| `dataset.build` | `write:data` | 由 `cad-source/v1` 生成数据集草稿与 `space-model/v1` 草稿；推断值写进 `assumptions`，`basis: 'preview'`；必须 `confirm`；重建保留 `confirmations`/`corrections`，来源变化只降为 `stale` |
| `dataset.diff` | 无 | 两个数据集的记录层与图元层差异 |
| `dataset.correct` | 无 | 校正预演：图元差异 + 建议复核的设计（走图投影的影响面） |
| `design.create/version/fork/confirm/stale` | `write:data` | 设计只引用一个数据集；复制只记 `forkedFrom`，不建派生边；版本用 `uses` 声明用到的构件 |
| `annotation.confirm` | `write:data` | 逐项确认：对象 + 字段 + 值（或判为无效）+ **依据** + 时间 + 确认人；覆盖时保留 `previous` 历史；同内容重复确认不写盘 |
| `program.check` | 无 | 拆改可行性、门窗净宽与开启、动线宽度 |

对应的 CLI：`space dataset build|diff|correct`、`space design create|version|fork|confirm|stale`、`space program check`、`space annotation confirm|list`（工作台也有「确认清单」面板，一次一项、必须写依据）。

### 构件级影响怎么算

`dataset.correct` 的复核清单分两层，权威在前：

1. **文件层**（不依赖索引）：扫描 `data/designs/*/versions/*.json`，取每个方案的最新版本，用 `uses` 与变化 handle 求交。`uses` 为空表示依赖整个数据集——宁可多复核，不漏。
2. **图投影层**：下游产物（三维 / 彩平 / 施工图）只能由 `readGraph` 给出，索引不可用时显式返回 `downstream.available: false`，不假装有清单。

`uses` 在 `design.create` 时声明（`--uses H1,H2`），`design.version` 未显式给时继承上一版本。

### lane 边界（M2 并行时的文件分工）

| lane | 独占 |
|---|---|
| 图内核 | `src/store/graph.mjs`、`tests/store-graph.test.mjs` |
| 数据集 | `src/capabilities/data.mjs`、`tests/data.test.mjs` |
| 设计版本 | `src/capabilities/design.mjs`、`tests/design.test.mjs` |
| 规则检查 | `src/domain/checks.mjs`、`src/capabilities/program.mjs`、`tests/program.test.mjs` |
| 主控接线 | `src/capabilities/index.mjs`、`src/cli/registry.mjs`、`src/cli/commands/{dataset,design,program,graph}.mjs`、`tests/m2.test.mjs` |

## 能力插件与全局索引（M5）

### 能力插件

插件不是新的运行方式，只是「另一批按契约声明的能力」。

```
<project>/plugins/<插件目录>/plugin.json     # space-plugin/v1 清单
<project>/plugins/<插件目录>/index.mjs       # export const capabilities = [...]
~/.config/house-plan/plugins/<插件目录>/      # 用户级，两个来源都可以
```

- **默认关闭**：只在 `SPACE_PLUGINS=1`（或 `true`）时加载。clone 下来不会执行别人的代码。
- 清单校验：id（小写字母/数字/连字符）、版本、入口必须是插件目录内的 `.mjs`（`..` 与绝对路径都拒）。
- 加载后跑 `validateRegistry`，并检查 id 不得覆盖内置能力、不得占用计划项、不得与已加载插件重名；失败只记录原因，不影响内置能力与其他插件。
- 加载进来的能力带 `plugin` 元数据，`space cap` 与工作台照常显示（工作台按钮标 `⊕`），执行仍走 `runCapability`（同样的存储守卫与事件）。
- 关闭后彻底移除：不残留任何能力。

```sh
space plugin list [--project <project.json>] [--json]
space plugin dirs
SPACE_PLUGINS=1 space cap list --project <project.json>
```

### 只读全局索引

跨项目检索只回答「哪个项目大概有什么」，不复制几何。

- 位置：`~/.cache/house-plan/index.sqlite`，可用 `SPACE_GLOBAL_INDEX` 重定向；不在任何项目的 `.space/` 里。
- 内容：项目 id、名称、路径、工具版本、同步时间，以及图元 / 图层 / 数据集 / 设计 / 施工图 / 渲染的计数。
- 隐私边界由 `FORBIDDEN_FIELDS` 卡住：`geom / geometry / points / polygon / footprint / content / model` 出现在记录里直接报错。
- 派生数据：删掉可重建；同一项目重复同步是更新而不是新增。

```sh
space index global sync --project <project.json>
space index global list [--q 关键词] [--limit 50]
space index global stat
```

`space doctor` 会报告插件开关状态与全局索引位置。

## 能力门面（CLI 与工作台一致）

一个能力只写一份实现，两个宿主都从契约生成界面。

### 三份登记

| 登记 | 位置 | 作用 |
|---|---|---|
| 已实现能力 | `src/contracts/capability.mjs` 校验、`src/capabilities/*.mjs` 声明 | 有 `run`，可执行 |
| 计划中能力 | `PLANNED_CAPABILITIES`（`capability.mjs`） | 只有契约与 `blockedBy`，**没有 `run`**，门面照常显示但不可执行 |
| 图层/图种登记 | `documents.mjs` / `rendering.mjs` 的 `implemented` 标记 | 与上面两份一致，防止「能做」和「说能做」对不上 |

`space capabilities --check` 同时校验两份登记：字段齐全、id 不重复、计划项不能带实现、计划项与已实现项不能重名。

### CLI

```sh
space capabilities                 # {implemented, planned}（JSON）
space cap list [--stage data]      # 一份清单，含计划项
space cap show <id>                # 契约 + 参数 + 副作用；计划项显示阻塞原因
space cap run <id> --project p [--<参数> 值 ...]
```

`space cap run` 的参数**由契约生成**：`number` 转数字，`boolean` 走开关，其余原样；契约里没有的参数直接报错，不静默忽略。计划中的能力用 `E_EXEC_NOT_IMPLEMENTED` 拒绝并带出 `blockedBy`。

各域的专用命令（`space dataset`、`space design`、`space doc`、`space render`…）仍然保留，它们只是把常用能力排得更顺手；`space cap` 是兜底门面，新增能力无需再写一套参数解析。

### 工作台

`/api/capabilities` 返回 `{stages, capabilities, planned}`。界面按同一份登记渲染：

- 已实现：出表单与「执行」按钮，参数控件按 `type` 生成；
- 计划中：侧边栏置灰带「·」，点进去只有说明与 `blockedBy`，**不渲染执行按钮**；
- 运行接口对计划项返回同一个错误码，两端说法一致。

## 底图描图（人工修正）

识别不准或识别不出的构件，由人在底图上画出来，写进数据集模型。

- **契约** `src/contracts/tracing.mjs`：`space-trace/v1`。底图 = `{file, mmPerPx, origin, rotationDeg}`（图片左上角对应的模型毫米坐标）；描图项 = `wall`（中心线两点 + 墙厚）或 `invalid`（判无效的 handle）。
- **纯函数** `src/domain/tracing.mjs`：像素→毫米变换、中心线→墙体多边形、合并进楼层（同一面墙由几何推导 handle，重复提交是覆盖而不是新增）。
- **能力** `annotation.trace`（`write:data`）：读数据集与模型 → 归一化 → 合并 → 校验 → 写回模型并在数据集里追加一条 `traces` 记录（操作者、时间、底图、数量）。**必须带操作者**，人工改动要能追溯。
- **工作台**：`底图描图` 面板。选底图、调 `mm/像素` 与原点、点两下画一面墙、保存；比例不准时改数字重新画即可。
- **CLI**：`space trace save --project … --dataset … --file items.json --actor 名字`，`space trace list`。

### 构件标注（类别与颜色都由项目数据定义）

`data/cad/components.json`（`cad-components/v1`）是「图元 → 构件」的唯一来源：

| 字段 | 含义 |
|---|---|
| `kinds` | 本项目用到的构件类别：`label`（中文名）、`color`（#rrggbb）、`basis`（默认判定依据）、`group`（structural / auxiliary） |
| `assignments` | 图元 id → `{kind, basis?, provenance, confidence?}`；`provenance` 只认 manual / ai / rule / import |

工具里没有内置类别表：换一家设计院就换一份约定，改约定是改数据（`space components kinds --add`），不是改代码。
CLI 只校验「kind 必须在 kinds 里、id 必须在图元索引里」；studio 只按 `kinds[].color` 上色，
没标注的图元显示为「未标注」，不从图层名猜构件。

### 识别不在 CLI 里

CLI **不做语义识别**：不猜墙、不判断门窗类型。它只做四件事——格式准备（DWG→DXF、PDF/图片→底图）、
图元索引（`cad.inspect`，只保留图层/文字/几何，不解释含义；默认展开顶层块，嵌套块只留引用，深度≤1、总量≤2 万）。
工作台「构件核对」只显示 `data/cad/components.json` 里的标注，没有标注就显示「未标注」。
识别规则不写进脚本：图纸怎么读、什么颜色代表什么，都写在 [cad-conventions](cad-conventions.md) 里给人和 AI 看。

历史上的规则识别脚本（`cadvec.py`、`cadsplit.py`、`analyze.py` 等）已从 `space run` 清单移出，
文件保留在 `src/legacy/scripts/` 供参考，不再是产品路径。图纸怎么读交给 AI。

### AI 识别怎么接（主路径）

CLI **不做感知**：看懂图纸是模型的事，CLI 负责给任务单、校验结果、存盘、追溯。

```sh
space trace brief --project <project.json> --dataset d1        # 给 AI 的任务单
#   → 底图绝对路径、mmPerPx、origin、已有实体计数、items 形状、提交命令与规则

space trace save --project <project.json> --dataset d1 \
  --file items.json --actor <操作者> --provenance ai --dry-run  # 只校验
space trace save ... --provenance ai                           # 校验并写盘
space trace review --project <project.json> --dataset d1        # 按来源统计 + 低置信度清单
```

- 模型在环外看图（本地或任意模型），输出 `items[]`：`{kind:'wall', from:[x,y], to:[x,y], thicknessMm, provenance:'ai', confidence}`；不确定就用 `kind:'invalid'` 否定已有实体。
- 坐标是毫米：`model = origin + pixel × mmPerPx`（`trace brief` 里给全）。
- `--dry-run` 只跑契约校验，不会写坏数据；写盘后每条记录留操作者、时间、底图与来源分布。
- studio 里 AI 墙用虚线画、低置信度起点画红点，人工可判无效或补画。

### PDF / 扫描件 → 底图

`cad.raster`（`src/cad/raster.py`）把 PDF / 图片 / **DXF** 栅格化成 `output/cad/underlay.png`，并写 `output/cad/underlay.json`（`mmPerPx` 与原点）。PDF 与图片用 PyMuPDF 渲染；DXF 用 ezdxf 取折线自己画（1 像素 = 4mm，原点=DWG 坐标最小值），这样 DWG/DXF 也能给 AI 看。studio 与 `trace brief` 都读这份元数据对齐。只渲染不识别——识别交给 AI 提议或人工描图。源文件必须在项目内（例如 `source/drawings/`），越界路径会被存储层拒绝。

### DWG 转 DXF

`cad.convert`（`src/capabilities/convert.mjs`）调用本机转换器，产物写 `output/cad/`，再交给 `cad.inspect`。检测顺序：

| 工具 | 说明 |
|---|---|
| **ODA File Converter** | 推荐。免费但需注册下载；macOS 在 `.app/Contents/MacOS/ODAFileConverter`，Windows 在 `C:/Program Files/ODA/…`。可用 `ODA_CONVERTER` 指定路径 |
| **LibreDWG `dwg2dxf`** | 备选。**实测输出 ezdxf 读不了**（缺 EOF / ValueError，r2000–r2018 都失败），只能算最后手段，摘要里会明确警告 |

都没有时能力报 `E_EXEC_DEPENDENCY` 并给出安装提示。转换在 `.space/tmp/` 里进行，工具的 `cwd` 也设在暂存目录——避免它在项目根按默认文件名落一个 DXF（那是绕过存储层的写入）。

### AI 提议与人工修正

自动识别（脚本或 AI）产出的是**提议**，不是结论：

- 描图项带 `provenance`（`cadvec` / `ai` / `dxf` / `manual` / `import`）与可选 `confidence`（0–1）。
- `LOW_CONFIDENCE = 0.8`：低于它的墙在 studio 里画虚线红，视为待核对。
- `space trace review --project … --dataset …` 按来源统计，并列出低置信度的墙。
- studio「底图描图」面板会画出模型里已有的墙（manual 蓝 / ai 橙 / cadvec 紫），切到「判为无效」后点一面墙即可标记，保存后带 handle 写进数据集。

AI 在环外：模型看图纸输出 `items` JSON（或直接调 `annotation.trace`），工具包只负责校验、合并、记录来源与置信度。数据不出机器，也不需要把模型密钥放进 CLI。

边界：

- 现在只收**墙**。房间、门窗、点位还没进 `space-model/v1`，等数据契约确定后再加。
- 底图必须是项目内的图片（PDF 先渲染成 PNG）；比例与原点自动识别会有误差，界面上可手调。
- `cad.vec`（PDF/DXF 识别）还没接成能力，见 [实现计划](roadmap.md) 的 M6 候选。

## 施工图与交付清单（M3 契约）

契约在 `src/contracts/documents.mjs`，纯逻辑在 `src/domain/{demolition,sheet,sheet-projection,documents}.mjs`。

### 图种：实现了才注册能力

| 图种 | 状态 | 说明 |
|---|---|---|
| `wall-demolition` 拆改图 | 已实现 | 保留 / 拆除 / 新建墙体 + 尺寸 + 说明 |
| `mep` 水电图 | 只有契约与图层规范 | 未注册能力，`space doc list` 会明确标注 |
| `furniture` 定制家具图 | 只有契约与图层规范 | 同上 |

`docKind(id).implemented` 是唯一的判据：没实现的图种调用会按 `E_EXEC_UNKNOWN_CAPABILITY` 拒绝，不做假装能出图。

### 图层规范

`LAYERS` 固定了顺序、颜色、线宽与虚线节奏：`frame` → `wall-existing` → `wall-demolish` → `wall-new` → `opening` → `furniture` → `cabinet-inner` → `mep-point` → `mep-route` → `dimension` → `note`。每种图只允许自己的图层子集（`KIND_LAYERS`），跨图种混用被 `validateSheetSpec` 拒绝。图层顺序固定，渲染结果才能比哈希。

### 从模型到图面

1. `demolitionSpec(model, {floor, scale, title})`：模型 → 图面数据（模型毫米）。
2. `projectSheet(spec, {scale})`：按比例换算到图纸毫米并在图框内居中；比例放不下时沿 `[20,25,30,40,50,75,100,150,200,250,300,400,500]` 阶梯放大，记录实际比例。文字高度与标注偏移一起换算。
3. `renderSheet(spec)`：确定性 SVG（图层分组、固定数字格式、XML 转义、无时间戳），同输入字节相同。
4. 越界检查：投影后仍有图元落在图框外则拒绝出图（`E_DATA_RULE`），不交一张错位的图。

### 交付清单

`output/doc/manifest.json`（`space-doc-manifest/v1`）逐条记录：产物路径与哈希、生成器 id 与版本、`inputs`（数据集 / 设计版本 / 模型的文件与哈希、用到的确认值、参数）。任何交付物都能回答「基于哪版数据、哪版设计、哪些确认值」。

两条硬规矩：

- **不静默覆盖**：`doc.wall-demolition` 发现记录里的输入或产物与当前不一致时直接拒绝（`E_DATA_RULE`），要么先 `space doc check` 看原因，要么把改动做成新设计版本，要么显式 `force`。
- **只标待复核**：`space doc check` 比对设计版本哈希与状态、数据集、模型、确认值，命中就把条目改成 `stale` 并写明原因；重出之后回到 `generated`。

```sh
space doc render --project <project.json> --scheme a --seq 1 [--floor ground] [--scale 100] [--force]
space doc check  --project <project.json>
space doc list   --project <project.json> [--json]
```

## 渲染与交付（M4）

契约在 `src/contracts/rendering.mjs`，纯逻辑在 `src/domain/{rendering,bundle,colorplan}.mjs`。

| 能力 | 状态 | 产物 |
|---|---|---|
| `render.colorplan` | 已实现 | `output/render/colorplan/<方案>-<版本>.svg` + 同名 `.json` 渲染记录 |
| `render.interior` | 只有契约 | 需要栅格渲染器（Blender / three 离屏），不在确定性 SVG 链里 |
| `bundle.export` | 已实现 | `output/bundle/<包名>/` + `manifest.json` + `index.html` |
| `deliver.snapshot` | 已实现 | `output/snapshot/<名>.html` + 同名 `.json` 记录 |

### 约定

- **固定机位**：`normalizeCamera()` 只认 `target / azimuthDeg / elevationDeg / distanceMm / fovDeg`，`cameraKey()` 生成稳定指纹，同一组参数必须得到同一张图。
- **基础图 / 风格图分开**：`styleSplit()` 把「锁几何的基础图」和「只改材质光线的风格图」分成两层，`assertStyleOnly()` 拒绝风格参数里夹带几何字段。
- **渲染记录**：`space-render/v1` 记下产物哈希、相机、输入链与 `deterministic: true`；`validateRender()` 强制要求设计版本与数据集输入。
- **交付包只读**：`space-bundle/v1` 逐文件记哈希与角色，`readOnly: true`；包里附 `index.html` 清单，拷到别的机器上双击就能看，不需要本机环境。
- **快照单文件**：`space-snapshot/v1` 声明 `writable: false`、`offline: true`，内嵌数据与哈希清单，体积上限 40MB（`MAX_SNAPSHOT_BYTES`）。
- **写权限守卫**：`isGenerated()` / `assertSourceNotGenerated()` 规定 `output/` 下的产物永远不能当输入——渲染结果反写数据在结构上不可能。

### 不静默覆盖

`render.colorplan`、`bundle.export`、`deliver.snapshot` 都遵守同一条规矩：同名产物已存在且内容或输入不同时，必须显式 `force` 才覆盖，否则报 `E_DATA_RULE`。内容完全相同则直接返回 `unchanged`，一个字节都不写。

```sh
space render colorplan --project <project.json> --scheme a --seq 1 [--floor ground] [--theme plan]
space bundle export     --project <project.json> --scheme a --seq 1 [--name 包名]
space deliver snapshot  --project <project.json> --scheme a --seq 1 [--name 快照名]
```

## 工作台视口取数

工作台不再把整份图纸塞给浏览器：

- `GET /api/index?project=…` → 索引摘要（图元数、图层数、包围盒、体积、dataset 节点）；索引不可用或未建立时返回 `available/present` 标记，界面据此降级。
- `GET /api/entities?project=…&box=x1,y1,x2,y2&layer=…&type=…&limit=…&offset=…&count=1` → 一页图元（只含 handle/type/layer/包围盒，不含点集）。坏参数返回 400。
- 「几何索引」面板：拖动平移、滚轮缩放都会换视口重新取数；每页 2000 条，`继续加载` 走 `nextOffset`，`统计总数` 才请求 `count`。

冒烟检查（需要本机 Chrome）：

```sh
node src/checks/studio.mjs <project.json>
```

断言：首屏不请求整包 `source.json`/`model.json`、视口请求带 `box`、图元已绘制、窄屏无横向滚动。

## 怎么加命令、加能力

两条路径都是纯追加，不需要改公共文件里的分支逻辑：

| 要加的东西 | 改哪里 |
|---|---|
| 一个 CLI 命令 | 新建 `src/cli/commands/<域>.mjs`，导出 `{name, group, usage, summary, run(args, {print, error, root})}`；在 `src/cli/registry.mjs` 的 import 与展开项各加一行。帮助文本自动生成。 |
| 一个能力 | 新建或追加 `src/capabilities/<域>.mjs` 的 `capabilities` 数组；在 `src/capabilities/index.mjs` 各加一行。契约 lint 与工作台表单自动跟上。 |

`validateCommands()`（`space help` 前会跑）检查：命令与别名唯一、分组合法、usage 以 `space ` 开头、有实现。`space capabilities --check` 检查能力契约字段。

## 能力怎么写

```js
export const capabilities = [{
  id: 'demo.thing',
  version: '1.0.0',
  stage: 'model',
  title: '示例能力',
  description: '一句话说明产物',
  params: [{key: 'file', label: '文件', type: 'path', required: true}],
  inputs: {file: 'path:blend'},
  outputs: {glb: 'artifact:model'},
  sideEffects: ['write:artifact'],
  requires: ['blender:cli'],
  idempotent: true,
  errors: ['E_EXEC_PARAM', 'E_EXEC_PROCESS'],
  async run(ctx, {file}) {
    // 只通过 ctx.store 写；外部进程只能写 ctx.store.staging()
  }
}];
```

`space capabilities --check` 与 `tests/contracts.test.mjs` 会核对：字段齐全、id 唯一、stage 合法、schema 已登记、错误码在表内、副作用取值合法。

## 检查方式

```sh
npm test                                             # 含契约、存储、确定性构建与静态扫描
space store verify --project <project.json>
space capabilities --check
```

`tests/store.test.mjs` 里有两条静态卡口：

- 除 `src/store/atomic.mjs`（原子写入原语）与两个浏览器冒烟脚本外，`src/`、`bin/` 不允许出现 `writeFileSync`、`appendFileSync`、`createWriteStream`。
- `src/domain/` 不允许引入 `node:` 内置模块、`fs`、`http`、`child_process`，也不允许读 `process`。

## 已知边界

- 同一项目的并发写用 `.space/write.lock` 串行化，等待超过 60 秒视为残留锁并回收；跨进程的作业队列留给后续的运行时。
- 索引与解析缓存都在 `.space/` 里，所以「删掉 `.space/`」必然丢掉缓存。要验证「重建不重新解析」，删的是索引文件（或从项目内的 `output/cad/source.json` 重建）；删整个 `.space/` 会重新解析一次，结果一致。
- 索引只存包围盒与图层/类型，点线面几何仍以 `cad-source/v1` JSON 为准；点击溯源靠 `handle`。
- `build.viewer` 的 `--out` 必须落在项目内，否则拒绝写入；`space cad view` 的目标目录可能不属于任何项目，因此直接用原子写入原语。
- 白模页面的压缩包在重构后出现压缩器标识符重排（`Dr` → `Nr`）导致 `白模.html` 哈希变化；数据产物（`model.json`、`validation.json`、构建报告）字节不变，重复构建哈希一致。
