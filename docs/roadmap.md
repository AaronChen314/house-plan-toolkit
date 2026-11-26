# 实现计划

基于 [架构设计](architecture.md) 的分层与存储方案，把工具包演进到可追溯的数据与交付链路。当前版本 **0.7.0**：M0–M2 完成，M3/M4 各剩一个需要新契约或新链路的图种，M5 两项落地。起点与逐项进度见下，未完成清单在文末。

## 起点（0.3.1，留档）

当时具备：CLI 与工作台共用的能力注册表、DXF 索引、空间数据校验、平面与白模生成、外部模型预览、Blender 转 GLB、目录与发布门禁。

当时还缺：统一的存储入口、几何索引与视口查询、数据集与校正流程、推导图与失效传播、设计版本管理、施工图生成、只读交付快照。这些在 M0–M2 与 M4 中已分别落地。

## 原则

- 契约先行：先定字段与接口，再写实现；否则每个能力都会长出自己的私有格式。
- 垂直切片：每个里程碑都能用真实图纸跑通一条完整链路，不做只有骨架没有出口的半成品。
- 先索引后数据库权威：数据库先当索引与缓存，等确实需要多人并发再切换权威模式。
- 每个里程碑都要有可复现的验收数字，不靠"看起来更快"。

## M0 契约与存储骨架（0.4.0）— 已完成

落地情况见 [契约与存储](storage.md)。交付物：`src/contracts/`（错误码、schema 登记、能力契约、存储接口、传输格式）、`src/store/`（原子写、基准哈希、事件日志、内容寻址、verify/rebuild）、`src/domain/`（几何、竖向、模型校验、尺寸校验）、能力契约补字段、`space store verify|rebuild|events|stat`。

验收结果：`npm test` 71 项全绿（原有 45 项不变，新增 26 项）；静态扫描 0 处绕过存储的写入；每次写入都有事件且与磁盘哈希一致；两次构建产物字节一致；示例数据产物（`model.json`、`validation.json`、构建报告）与重构前字节相同，`白模.html` 因压缩器标识符重排哈希变化（数据与行为不变）。

目标：把读写收进一个入口，让后续能力不再各自碰文件。

交付：

- `src/contracts/`：能力契约类型、错误码表、存储接口定义、传输消息格式。
- `src/store/`：文件存储（读、原子写、提案与基准哈希、事件追加）、artifact 内容寻址。
- `src/domain/`：从 `src/space/`、`src/checks/` 抽出纯函数，保留原调用点。
- 能力注册表补齐字段：版本、输入输出、副作用、环境依赖、幂等性、错误码。
- `space store verify`、`space store rebuild`（先只重建事件与文件登记）。

验收：

- 所有能力只经存储写入；代码里不再出现绕过存储的 `writeFileSync`（测试用静态扫描卡住）。
- 中断写不产生半截文件；基准哈希不一致必拒。
- 事件日志覆盖每一次写操作，能用一条命令导出。
- 现有 45 个测试全绿，示例构建产物哈希不变。

风险：抽取纯函数时容易把 IO 带进去；用"领域层禁止 import fs/child_process/http"的静态检查兜底。

## M1 几何索引与视口取数（0.4.0）— 已完成

前置准备（已完成）：CLI 改为命令表驱动、能力注册表按域拆分、`store.derived()` 派生存储契约落定，三条 lane 的文件边界已不重叠。

目标：解析一次、查询毫秒级、工作台不再整包加载。

三条 lane 全部落地：

- [x] SQLite schema：节点、边、版本、复制、实体、包围盒索引、事件（`src/indexer/schema.mjs`）。
- [x] 解析缓存：键为源哈希、解析器与版本、参数；命中直接读缓存。
- [x] `space index rebuild/stat/query/layers`。
- [x] `cad.inspect` 先查解析缓存，命中不启动 Python。
- [x] 工作台按视口取实体，分页返回；首屏不再传完整 JSON。
- [x] 数据集最小节点登记（`node` 表，`kind=dataset`；设计节点留给 M2）。

验收指标（本机已测基准，第二版）：

- 五万图元：解析调用只发生一次；解析缓存命中 15ms（门槛 50ms）。
- 包围盒查询五千条：p50 3.99ms、p95 4.43ms（门槛 p50 < 5ms）。
- 删除索引文件后重建：命中解析缓存，不重新解析；结果与重建前一致。
- 工作台首屏：两万图元项目只请求一页（2000 条）视口数据，整包 JSON 请求 0 次；`node src/checks/studio.mjs <project.json>` 复现。

命令：`npm run bench:index` 复现上述数字，未达标退出码 1。

风险（已处理）：Node 20 没有内置 sqlite。现在用 Node 22.5+ 的 `node:sqlite`；低版本不报死，而是 `space doctor` 提示、索引命令返回 `available: false`、其余能力退回每次解析。

## M2 数据集、校正与设计版本（0.5.0）— 已完成

前置准备（已完成）：推导图契约（`src/contracts/graph.mjs`）、影响面纯函数（`src/domain/graph.mjs`）、`markStale` 写文件不写索引的决定，均已落定并有用例。四条 lane 的文件边界见 [契约与存储](storage.md#推导图与失效传播m2-契约)。

进度（四条 lane 已并行落地）：

- [x] `dataset.build`：源索引生成数据集与模型草稿，推断值标 `preview`。
- [x] `dataset.diff`：任意两个数据集的结构化差异。
- [x] `dataset.correct`：校正预演，输出图元差异与建议复核清单（只读）。
- [x] `design.create` / `design.fork` / `design.version`（另加 `confirm` / `stale`）：设计只引用数据集，复制只记来源。
- [x] `program.check`：拆改可行性、净空与动线检查。
- [x] 失效传播：图投影、影响面、失效预演；`graph stale` 可算「该标谁」。
- [x] 写权威数据后自动刷新投影（能力层统一处理，不再要求手动 `graph sync`）。
- [x] `dataset.build` 重建保留确认记录；来源变化只降为待复核。
- [x] `annotation.confirm`：逐项确认（值 / 判为无效），必须写依据，保留覆盖历史。
- [x] 构件级影响：设计版本用 `uses` 声明用到的 handle，校正后按 handle 求交给出复核清单。
- [x] 工作台确认清单：逐项确认、判为无效、显示依据与时间，不做批量静默通过。

目标：覆盖"校正版图纸 → 受影响清单 → 人确认 → 新设计版本"的真实链路。

交付能力：

- `dataset.build`：源索引生成空间模型草稿，推算值标预览依据。
- `dataset.correct`：校正版与现有数据集比对，产出逐实体差异与受影响清单。
- `dataset.diff`：任意两个数据集版本的结构化差异。
- `annotation.confirm`：记录用户确认的尺寸、归属与无效判定。
- `design.create`、`design.fork`、`design.version`：设计只能引用数据集；复制只记录来源。
- `program.check`：拆改可行性标记、净空与动线检查。
- 失效传播：上游变化后沿推导图标记待复核，工作台给出确认清单。

验收结果：

- 设计派生设计的边被契约与测试双重拒绝（`validateGraph` + `canEdge`）。
- 校正后只有用到变化构件的设计版本进复核清单：`uses: ['H1']` 的方案受影响，`uses: ['H2']` 的不受影响，未声明 `uses` 的按「依赖整个数据集」保守标记。
- 影响分析一千节点中位 < 5ms（`tests/graph.test.mjs`）。
- 复制方案后修改原方案，副本不受影响；两者都只依赖数据集。

风险：用户确认流程容易做成"点一下全通过"；必须逐项带依据与时间，不提供批量静默确认。

## 能力门面（跨里程碑，持续）

- [x] 计划中能力登记（`PLANNED_CAPABILITIES`）：`doc.mep`、`doc.furniture`、`render.interior` 三项目前只有契约与阻塞原因。
- [x] CLI 通用门面 `space cap list|show|run`：参数由契约生成，未实现能力按 `E_EXEC_NOT_IMPLEMENTED` 拒绝。
- [x] 工作台门面：计划项置灰不可执行，面板只显示说明与阻塞原因。
- [x] `space capabilities --check` 同时校验两份登记，防「能做」与「说能做」不一致。

## M3 施工图（0.6.0）— 部分完成并发布

目标：拆改图、水电图、定制家具图从设计版本生成，可追溯、可复核。

契约先行（已完成）：图面数据、图层规范、交付物记录、交付清单四份契约（`src/contracts/documents.mjs`），三种图种的图层白名单，以及「实现了才注册能力」的判据。

进度：

- [x] 图框、图层规范与确定性渲染：同输入产物字节相同；比例从固定阶梯取，投影后越界拒绝出图。
- [x] `doc.wall-demolition`：保留 / 拆除 / 新建墙体与尺寸，标注依据来自数据集确认值。
- [x] 交付清单：每条记录带输入版本链（数据集 / 设计版本 / 模型 / 确认值 / 参数）。
- [x] 设计版本变化后标待复核，重出需要显式 `force`。
- [ ] `doc.mep`：阻塞在数据契约——`space-model/v1` 没有点位（插座 / 水位 / 回路）。
- [ ] `doc.furniture`：阻塞在 `detail`（层板 / 抽屉 / 挂衣区）的字段约定；轮廓与柜顶有效顶面已能算。

验收：

- 同一设计版本重复生成，产物哈希一致。
- 设计版本变化后，施工图标为待复核而不是静默覆盖。
- 任一交付物能回答"基于哪版数据、哪版设计、哪些确认值"。

风险：施工图容易被当成"画得好看"的产物；先把尺寸、依据、版本链做对，再谈表现。

## M4 渲染与交付（0.7.0）— 部分完成

目标：在几何锁定之后做表现层，并生成客户可离线查看的交付包。

进度：

- [x] 契约：渲染记录、固定机位、基础图/风格图分离、交付包清单、快照记录、写权限守卫。
- [x] `render.colorplan`：确定性彩平，文字与面积由数据生成，重复生成哈希一致。
- [x] `bundle.export`：只读交付包 + 逐文件哈希清单 + 离线可看的 index.html。
- [x] `deliver.snapshot`：单文件快照，内嵌数据与哈希清单，`writable: false`。
- [ ] `render.interior`：只有契约——需要栅格渲染器（Blender / three 离屏），不属于确定性 SVG 链。

验收（已达成，离线打开为实测）：

- 交付包在无本机环境的机器上能打开。
- 快照中的几何与数据哈希和源项目一致。
- 生成图不能反向覆盖数据（写权限测试）。

风险：大贴图与大模型让单文件膨胀；默认外置资源目录，单文件模式设体积上限。

## M5 扩展与跨项目（0.7.0）— 已完成（存储切换按条件搁置）

进度：

- [x] 能力插件：默认关闭（`SPACE_PLUGINS=1`），项目 `plugins/` 与 `~/.config/house-plan/plugins/` 两个来源；清单校验、id 冲突拒载、加载失败不影响内置能力；加载后自动出现在 `space cap`、`space capabilities`、工作台侧边栏。
- [x] 只读全局索引：`~/.cache/house-plan/index.sqlite`（可用 `SPACE_GLOBAL_INDEX` 重定向），只存项目摘要与计数，不存几何；`space index global sync|list|stat`。
- [x] 只读全局索引（0.7.0 实测：`space index global sync|list|stat`）。
- [ ] 存储实现切换：**不做**，直到真的出现多人并发需求（与架构文档的决策一致）。
- 0.7.0 收尾：W005 提示改为真实命令、索引 Node 门槛收敛为 `INDEX_NODE_MIN`、交付包离线打开改为实测（`src/checks/bundle.mjs`）。
- 暂不做：实时协作、云端同步、移动端编辑。

原计划（留档）：

- 能力插件：第三方按契约注册，自动进入 CLI 与工作台。
- 只读全局索引：跨项目检索摘要，不复制几何。
- 存储实现切换：多人并发时再评估数据库权威模式，需要配套快照导出与迁移。

暂不做：实时协作、云端同步、移动端编辑。

## 现有项目的迁移（与里程碑并行）

两个本地项目先保持现状，等 M2 完成后再迁移：

- 补齐 `source/manifest.json`，登记图纸来源与指纹。
- 把 `output` 收敛到项目内 `output/`，根目录的核对页移入或废弃。
- 旧 `design/` 目录迁入 `data/designs/<方案>/`，记录版本与依据。
- 家具资产 id 使用通用命名，项目专用模型进 `data/assets/`。
- 用 `space index rebuild` 建立索引，再用工作台逐项确认尺寸。

迁移前后对比一次几何数量与浏览器检查结果，确认没有静默丢构件。

## M6 候选：图纸识别与人工修正

目标：PDF / PNG / DWG 进来，自动识别一部分，识别不准或识别不出的在 studio 里补。

已落地：

- [x] 底图描图：`space-trace/v1` 契约、`annotation.trace` 能力、`space trace save|list|review`、工作台「底图描图」面板（两点画墙、按来源着色、判无效）。
- [x] 来源与置信度：`provenance`（cadvec / ai / dxf / manual / import）+ `confidence`，低置信度（<0.8）在 studio 高亮并在 `trace review` 列出。
- [x] DWG 转 DXF：`cad.convert` 调用 ODA / LibreDWG，产物落 `output/cad/`；实测 LibreDWG 输出 ezdxf 读不了，只作备选。
- [x] PDF / 图片转底图：`cad.raster`（PyMuPDF）输出 `output/cad/underlay.png` 并给出 `mmPerPx`，studio 直接描图。

待做：

- [x] ~~`cad.vector`~~：规则识别已从 CLI 移除（识别归 AI）；`dataset build --model` 保留，用于导入 AI 产出的结构化草稿。`cadvec.py`/`cadsplit.py` 归档在 `src/legacy/`，不再由 `space` 调用。
- [ ] 真实样本上的识别准确率评估（需要一份实际设计院 PDF/DXF）。
- [ ] 房间与门窗进 `space-model/v1`（现在只有墙/柱/家具），studio 才能画/改房间。
- [ ] AI 提议的采集：把「图纸图片 → items JSON」做成可复用的 agent 流程（在环外跑模型，产物走 `annotation.trace`）。

## 未完成清单（截至 0.7.0）

里程碑 M0–M2 完成，M3/M4 各剩一个需要**新数据契约或新链路**的图种，M5 两项落地、第三项按条件搁置。

| 项 | 卡点 |
|---|---|
| `doc.mep` | `space-model/v1` 没有点位模型（插座 / 水位 / 回路） |
| `doc.furniture` | 缺 `detail`（层板 / 抽屉 / 挂衣区）字段约定 |
| `render.interior` | 需要栅格渲染器（Blender / three 离屏） |
| 存储实现切换 | 等多人并发需求；与「文件是事实源」的决策冲突，不提前做 |
| 现有项目迁移 | 属使用者项目目录，仓库内不涉及 |

这张表就是下一步的输入：前两项要的是数据契约决策，第三项要的是技术选型。

## 每步的验证命令

```sh
npm test
npm run skills:check
space verify-public --denylist ~/.config/house-plan/denylist.txt
space lint --project examples/two-level/project.json
space build --project examples/two-level/project.json
node src/checks/white-model.mjs examples/two-level/output/白模.html
node src/checks/studio.mjs <project.json>          # 工作台视口取数冒烟
node src/checks/bundle.mjs <project.json> <包名>    # 交付包离线打开冒烟
```

存储（M0 已可用）：

```sh
space store verify --project examples/two-level/project.json
space store rebuild --project examples/two-level/project.json
space store events --project examples/two-level/project.json --limit 20
space capabilities --check
```

索引（M1，示例项目没有 DXF，用 `--source` 指向任意 `cad-source/v1` 文件）：

```sh
space index rebuild --project <project.json> --source output/cad/source.json
space index stat --project <project.json>
space index query --project <project.json> --box 0,0,5000,5000 --limit 100
npm run bench:index
```

## 交付节奏

- 每个里程碑结束打一个次版本号，更新变更记录与技能副本。
- 契约或数据 schema 不兼容的变更走大版本，并提供迁移命令。
- 里程碑之间允许插入 bug 修复版本，但不在补丁版本里改契约。

## 明确不做

- 不做设计派生设计，也不做"自动设计"这种一次生成全部结果的巨型能力。
- 不把数据库当唯一副本，不把模型文件塞进数据库。
- 不在宿主层写业务规则，不为 CLI 与工作台各维护一套逻辑。
- 不为了演示效果提前做渲染层，先保证尺寸、依据与版本链正确。
