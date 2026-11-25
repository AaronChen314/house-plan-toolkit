# 变更记录

## 未发布

### 新增

- **CAD 颜色约定表** `src/contracts/cad-colors.mjs`：10 个类别（墙/柱/门/窗/轴线/尺寸/文字/家具/填充/其他）的 ACI 常见色、studio 配色与判断依据；`classifyEntity()` 给出「图层名 0.85 > 颜色唯一 0.5 > 颜色多义 0.25 不下结论」的置信度分层；`overrideCategories()` 支持按院/按项目只覆盖差异项。
- 识别实体新增 `category` 与 `color`；`cad-source` 与 `space-model` 草稿都带上，studio 线稿/描图面板与图例直接 import 同一张表，配色与 CAD 惯例一致。
- `docs/cad-conventions.md` 增加「颜色约定」一节（已随 skills 重新生成），明确「颜色不是国标语义」与失效场景。
- **矢量图纸识别 `cad.vector`**：`cadvec.py` 的 `cad.json` → `cad-source/v1`（WALL/DOOR/WINDOW/TEXT/AXIS，每个实体带 `provenance: cadvec` 与 `confidence`）+ `space-model` 草稿（实心墙自动标承重）。`space dataset build --model` 可直接把识别草稿接入数据集，后续施工图/彩平链路不变。
- 工作台「底图描图」现在把墙、门、窗都画出来（墙紫 / 门橙 / 窗青 / AI 橙黄 / 低置信度虚线红），任何实体都能切「判为无效」标记。
- **PDF/图片转底图**：能力 `cad.raster`（`src/cad/raster.py`，PyMuPDF），输出 `output/cad/underlay.png` 并返回 `mmPerPx`；只渲染不识别，源文件必须在项目内。至此「PDF/截图 → 底图 → studio 描图 → 数据」可用。
- **DWG 转 DXF**：能力 `cad.convert`，检测 ODA File Converter（推荐）与 LibreDWG `dwg2dxf`（备选）；转换在 `.space/tmp/` 内进行、`cwd` 隔离，避免工具在项目根按默认名落盘。实测 LibreDWG 的 DXF 输出 ezdxf 读不了（r2000–r2018 全部失败），摘要里会警告。
- **AI 提议与置信度**：描图项支持 `provenance`（新增 `ai`）与 `confidence`（0–1）；`LOW_CONFIDENCE = 0.8` 以下的墙在 studio 画虚线红，`space trace review` 按来源统计并列出待核对的墙；`space trace save --provenance ai` 用于批量提议。
- studio「底图描图」面板会画出模型里已有的墙（manual 蓝 / ai 橙 / cadvec 紫），切「判为无效」后点墙即可标记。
- `docs/roadmap.md` 新增「M6 候选：图纸识别与人工修正」，记录已落地与待做（cad.vector 映射、房间/门窗进模型、AI 采集流程）。

- **底图描图**：`space-trace/v1` 契约（底图比例/原点、墙与判无效项）、`src/domain/tracing.mjs`（像素→毫米、中心线→墙体多边形、幂等合并）、能力 `annotation.trace`（`write:data`，必须带操作者）、CLI `space trace save|list`、工作台「底图描图」面板（选底图、调比例、点两下画墙、保存）。
- 描图记录写进数据集 `traces[]`（操作者、时间、底图、数量），墙体带 `provenance: manual` 与 `tracedAt/tracedBy`。
- `docs/manual-test.md` 增加「底图描图」回归步骤；`docs/storage.md` 增加对应契约说明。

### 修复

- 存储层登记表按 mtime 检测外部更新：同进程里能力自己开一个 store、宿主也开一个时，`verify` 会对着旧内存值误报「变更」。`saveRegistry` 也不再经 `reg()` 重新加载（后者会丢掉刚写入的条目）。

- `docs/manual-test.md`：按阶段的手工测试流程（准备 → 图纸 → 数据 → 设计 → 施工图 → 渲染交付 → 索引/存储/图 → 门面负向），每步带预期输出，末尾给出测试反馈必需字段。release.md 与 AGENTS.md 已链入。

### 变更

- `space dataset build` 成功后提示下一步：把 `project.json` 的 `model` 指向 `data/datasets/<id>/model.json`，否则 `space check` / `program check` 会报「Project has no verified model yet」。数据集不改项目指针（权威归文件），但调用方需要看见这一步。

## 0.7.1 — 2026-11-25

0.7.0 的 Release 流程在 Windows 上失败（tag 已推送但没生成 Release 产物），这一版修掉跨平台测试问题，是第一个可用的发布包。

### 修复

- **Windows 路径**：测试里用 `new URL(...).pathname` 取本地路径，Windows 得到 `/D:/a/...`，再 `path.resolve` 拼成 `D:\D:\a\...`；改用 `fileURLToPath`。
- **Windows 文件句柄**：删除索引文件或整个 `.space/` 前先 `closeReadHandles()`——数据库句柄未关时 Windows 报 `EPERM`/`EBUSY`。
- **假 Python**：测试里的 sh 脚本在 Windows 不可执行；改用 `process.execPath`（执行 `.py` 必然非零退出，效果等价）。
- **测试不再依赖本地构建产物**：「项目概览」断言 `output/` 下必须有文件，但 `output/` 在 gitignore 里，干净克隆时不存在；改为只校验路径形态，存在时才断言。
- **性能断言分层**：单测里「解析缓存命中 < 50ms」在共享 runner 上会假红，单测放宽为 500ms（只防没走缓存），真实 50ms 门槛仍由 `npm run bench:index` 独占进程卡。

### 验证

- CI：macOS + Windows × Node 22/24 全绿，macOS 浏览器冒烟通过。
- 本地 `npm test` 232 项、`npm run verify`、`npm run verify:browser` 通过。


## 0.7.0 — 2026-11-25

### 新增

- 能力插件：`space-plugin/v1` 清单（`plugin.json` + 入口 `.mjs`），两个来源（项目 `plugins/`、`~/.config/house-plan/plugins/`），默认关闭、`SPACE_PLUGINS=1` 开启。加载后走同一注册表：`space cap`、`space capabilities`、工作台侧边栏自动出现，工作台按钮标 `⊕`。
- 只读全局索引：`~/.cache/house-plan/index.sqlite`（`SPACE_GLOBAL_INDEX` 可重定向），只存项目 id、名称、路径、各类计数与工具版本，不存几何；`space index global sync|list|stat`。
- `space plugin list|dirs`；`space doctor` 增加「能力插件」「全局索引」两项。

### 契约

- `src/contracts/plugins.mjs`：清单字段、id / 版本 / 入口越界校验、`pluginsEnabled`、插件 id 不得覆盖内置或计划项。
- `src/contracts/global-index.mjs`：记录字段、`FORBIDDEN_FIELDS`（geom / geometry / points / polygon / footprint / content / model 一律拒绝）、查询串归一化。

### 修复（收尾三笔账）

- `src/checks/layout.mjs` W005 的修复建议原来指向不存在的 `space upgrade`，改为「重新运行 space lock」。
- 索引的 Node 门槛收成一个常量 `INDEX_NODE_MIN`（`src/indexer/db.mjs`），`space version` 输出 `requirements: {toolkit: '>=20', index: '>=22.5.0'}`，`doctor` 与报错信息都引用它——不再出现「engines 说 20、索引要 22.5」的说法不一致。
- 新增 `node src/checks/bundle.mjs <project.json> [包名]`：起本地只读服务打开包内 `index.html`，并用 `file://` 打开单文件快照，断言零外部请求、清单页行数与条目一致、包内逐文件哈希与清单一致。M4 的「交付包在无本机环境的机器上能打开」由结构成立变为实测。

### 验收

- `npm test` 232 项全绿（新增插件 5、全局索引 4）。
- 插件：默认关闭时看不到；开启后加载、执行、`--check` 通过；覆盖内置 id 或坏清单被拒且不影响其他插件；关闭后彻底移除。
- 全局索引：同一项目重复同步是更新而不是新增；表结构里没有任何几何列；`list` 不需要 `--project`；索引落在项目之外，项目 `store verify` 不受影响。
- 离线验收：`PASS bundle offline · 7 个文件 · 清单页零外部请求 · 快照 file:// 打开零网络`。

### M4 渲染与交付

#### 新增

- `src/contracts/rendering.mjs`：渲染记录（`space-render/v1`）、固定机位、基础图/风格图分离、交付包清单（`space-bundle/v1`）、只读快照（`space-snapshot/v1`）、写权限守卫。
- `src/domain/colorplan.mjs`：确定性彩平（固定图层顺序、鞋带公式算面积、文字全部来自数据）。
- `src/domain/bundle.mjs`：交付包条目归位、离线清单页、单文件快照 HTML（内嵌 JSON 安全转义）。
- `src/domain/rendering.mjs`：机位指纹、条目排序去重、包完整性判定、风格参数校验。
- 能力：`render.colorplan`、`bundle.export`、`deliver.snapshot`。
- CLI：`space render colorplan`、`space bundle export`、`space deliver snapshot`。

#### 验收

- `npm test` 217 项全绿（新增渲染契约 7、彩平 8、交付包 9、端到端 4）。
- 同输入彩平两次字节一致；两个交付包的条目与哈希一致。
- 交付包逐文件哈希与源一致；快照哈希清单包含设计版本哈希。
- 渲染与交付过程中 `data/` 一个字节未变（写权限守卫）。
- `render.interior` 按未知能力拒绝，`space render interior` 提示「只有契约」。

#### 已知缺口

- `render.interior` 未实现：需要栅格渲染器，契约与风格分层已就绪。

### 能力门面

#### 新增

- 计划中能力登记 `PLANNED_CAPABILITIES`（`doc.mep`、`doc.furniture`、`render.interior`）：只有契约与 `blockedBy`，不带实现；`validatePlanned` 卡住「计划项带实现」「缺阻塞原因」「id 重复」。
- CLI 通用门面 `space cap list|show|run`：参数由契约生成（number / boolean / 文本），契约外参数直接报错；未实现能力按 `E_EXEC_NOT_IMPLEMENTED` 拒绝并带出阻塞原因。
- 工作台门面：侧边栏显示计划中能力（置灰 + 「·」），点进去只有说明与阻塞原因，不渲染执行按钮；`/api/capabilities` 同时返回 `planned`。
- 新错误码 `E_EXEC_NOT_IMPLEMENTED`（执行类）：区分「没登记」与「登记了但没实现」。

#### 变更

- `space capabilities` 输出改为 `{implemented, planned}`（原来是能力数组）；`--check` 同时校验两份登记。
- `runCapability` 与工作台运行接口对计划项返回同一条可读错误，两端说法一致。

#### 验收

- `npm test` 223 项全绿（新增门面 6 项）。
- 每条计划项在 CLI（`cap list` / `cap show`）与工作台（`/api/capabilities`）上都可达，且都不可执行。
- 已实现的 22 个能力全部能从 `space cap run` 走通参数解析。

### 开发准备

#### 新增

- `docs/contributing.md`：开工说明书——环境要求、分层落点、加能力/命令/契约的步骤、验证循环、十条红线与提交前检查。
- `npm run verify`：一条命令跑快速门禁（232 项测试 + 能力契约 + 目录规范 + 技能包 + 发布边界，约 7 秒）。
- `npm run verify:browser`：浏览器冒烟（白模 + 工作台，需 Chrome）。
- `.githooks/pre-commit`：可选启用（`git config core.hooksPath .githooks`），提交前只跑 `npm test`；已加入发布白名单。

#### 修复

- `verify:public` 现在会自动读取 `~/.config/house-plan/denylist.txt`（之前只在显式传 `--denylist` 或设 `SPACE_DENYLIST` 时才生效，与 README 说法不一致）。

### 协作准备

#### 新增

- `.gitattributes`：文本统一 LF、二进制按字节保存。`skills/.bundle.json` 记录 22 个文档的哈希，行尾漂移会让 `skills:check` 与 `store verify` 在 Windows 上误报。
- `.github/ISSUE_TEMPLATE/`：`bug`、`feature`、`test-feedback` 三个模板。bug 强制填版本 / 平台 / `space doctor` / 复现命令；feature 强制填「落在哪一层」与「契约影响」；test-feedback 强制填 tag 与 `.skills-version`。
- `.github/workflows/verify.yml`：macOS + Windows × Node 22/24 跑 `npm run verify`；macOS 单独跑浏览器冒烟。
- `docs/release.md`：版本规则、发版前必跑项、tag 与预发布（`-rc.N`）流程、测试机隔离安装、回滚约定。
- 分支模型：`develop` 集成、`main` 只收 PR、tag 只从 `main` 打；CI 现在也覆盖 `develop`，并新增 `.githooks/pre-push` 在推送前跑 `npm run verify`。冲突规则与「生成物不手解」写进 `docs/contributing.md`。
- `.github/workflows/release.yml`：打 tag 自动发版——校验 tag 与 `package.json` 版本一致、跑门禁、`npm pack`、干净前缀试装（`space version` / `capabilities --check` / `skills check`），最后用 `gh` 建 Release 并附 tarball；带 `-` 的 tag 自动标 prerelease。测试机改从 Release 附件安装，不 clone 仓库。

#### 修复

- `tests/store.test.mjs` 的「目录不可写」用例原来依赖 `chmod`，在 Windows 上不生效会假红；改为跨平台的「目标是目录」失败注入，POSIX 下额外保留 chmod 用例。

### 文档

- README 重写：版本到 0.7.0、Node 门槛（索引需 22.5+）、按阶段重排的命令表、目录与项目侧约定同步到数据集/设计版本/交付目录。
- `docs/project-layout.md` 补齐 `data/datasets`、`data/designs`、`output/{cad,doc,render,bundle,snapshot}`、`.space/`、`plugins/` 与写入边界表。
- `schemas/README.md` 从「四种接口」扩为分组总表（17 份 schema），修好指向 `docs/design-sync-manifest.md` 的错误相对链接。
- `docs/public-surface.md` 样例白名单与真实 manifest 对齐，补 P006/P007，说明运行时目录不在发布面内。
- `docs/studio.md` 能力表按五个阶段重写，补三个专用面板与计划中能力的展示方式；新增能力的示例改成当前契约字段。
- `docs/architecture.md` 新增「实现状态（0.7.0）」，标出 L4 运行时只有契约与锁。
- `docs/roadmap.md` 删除 M3/M4 重复的「原计划」块，起点改为留档并指向当前进度。
- `docs/usage.md` 修正技能数量、Node 门槛与家具资产描述。

### 未完成清单（截至 0.7.0）

- `doc.mep`：卡在数据契约——`space-model/v1` 没有点位（插座 / 水位 / 回路）。
- `doc.furniture`：卡在 `detail`（层板 / 抽屉 / 挂衣区）字段约定；轮廓与柜顶有效顶面已能算。
- `render.interior`：卡在渲染器选型（Blender / three 离屏），不属于确定性 SVG 链。
- 存储实现切换：按 roadmap 条件搁置——等真正出现多人并发需求再评估。
- 现有项目迁移：属使用者项目目录，仓库内不涉及。

## 0.6.0 — 2026-11-25

M3 按计划只做「契约接口 + 一种图打通」，水电图与定制家具图留在契约里，缺口写在下方。

### 新增

- `src/contracts/documents.mjs`：图面数据（`space-sheet/v1`）、交付物记录（`space-doc/v1`）、交付清单（`space-doc-manifest/v1`）三份契约，图层规范（顺序 / 颜色 / 线宽 / 虚线）、每种图的图层白名单、图种登记（`implemented` 判据）。
- `src/domain/sheet.mjs`：确定性 SVG 渲染（图层分组、固定数字格式、XML 转义、无时间戳）。
- `src/domain/sheet-projection.mjs`：模型毫米 → 图纸毫米的投影，比例阶梯与越界检查。
- `src/domain/demolition.mjs`：模型 → 拆改图图面数据（保留 / 拆除 / 新建 / 门窗 + 尺寸 + 统计说明）。
- `src/domain/documents.mjs`：失效判定、清单合并、摘要。
- `src/store/documents.mjs`：交付清单读写（键排序保证字节稳定）与产物登记。
- 能力：`doc.wall-demolition`、`doc.check`、`doc.list`。
- CLI：`space doc render|check|list`。

### 变更

- 工作台按契约的 `type` 转换参数（number / boolean），不再把数字当字符串发给能力。
- `space version` 的 schema 列表改为从契约派生，避免漏登记。

### 验收

- `npm test` 189 项全绿（新增契约 7、拆改数据 10、渲染 10、投影 6、端到端 6）。
- 同一设计版本重复生成：产物哈希一致；第二次不重写文件（`unchanged`）。
- 模型变化后 `space doc check` 标待复核并写明原因；直接重出被 `E_DATA_RULE` 拒绝，`force` 才覆盖。
- 交付清单可回答「基于哪版数据、哪版设计、哪些确认值」。

### 已知缺口（M3 未完）

- `doc.mep`：`space-model/v1` 里没有点位概念（插座 / 水位 / 回路），需要先扩数据契约再出图。
- `doc.furniture`：柜体轮廓、高度、柜顶有效顶面数据齐全，缺 `detail`（层板 / 抽屉 / 挂衣区）的字段约定。
- 两者都已拒绝调用（`E_EXEC_UNKNOWN_CAPABILITY`），`space doc list` 会明确标注「只有契约与图层规范，未出图」。

## 0.5.0 — 2026-11-25

### 新增

- `src/contracts/graph.mjs`：推导图契约。七种节点类型、三种关系（派生 / 版本 / 复制）、四种状态与状态机、派生矩阵与复制矩阵、权威文件路径（`datasetFile` / `designVersionFile`）、`validateGraph()`。
- `src/domain/graph.mjs`：`impactOf` / `planStale` / `staleAfterChange` / `upstreamOf` 纯函数。
- `tests/graph.test.mjs`：12 项。含「校正只影响引用了该数据集的版本」与「一千节点影响分析 < 5ms」。
- `src/contracts/datasets.mjs`：数据集、设计方案、设计版本三种文件的形状与校验；`space-dataset/v1` 等三条 schema 登记。
- `src/store/graph.mjs`：推导图的索引投影（唯一写入入口）。`syncGraph` / `readGraph` / `projectFromFiles` / `markStaleProjection`；一次同步一条汇总事件。
- 能力：`dataset.build` / `dataset.diff` / `dataset.correct`（`src/capabilities/data.mjs`），`design.create|version|fork|confirm|stale`（`design.mjs`），`program.check`（`program.mjs`）。
- `src/domain/checks.mjs`：拆改可行性、门窗净宽与开启、动线宽度的纯函数检查。
- CLI：`space dataset build|diff|correct`、`space design create|version|fork|confirm|stale`、`space program check`、`space graph sync|show|stale`。
- `tests/m2.test.mjs`：跨 lane 集成用例——数据集→设计→图投影→校正预演，以及 CLI 全链路。

### 决定

- **`markStale` 写文件，不写索引**。数据集与设计版本的状态写在 `data/` 下的权威文件里；索引的 `node.status` 只是投影，删索引不会抹掉「待复核」结论。
- 版本不是边：版本链只记在 `node_version(parent_seq)`，`canEdge(…, 'version')` 直接拒绝。
- 复制只允许设计之间，且不传播失效。
- **节点状态取「最新版本」**：数据集看 `dataset.json.status`，设计看最大 `seq` 的版本状态。`graph show` / `graph stale` 会先从 `data/` 刷新投影再下结论。
- 图投影写入只有一个入口 `src/store/graph.mjs`；能力层只改文件。

### 验收

- `npm test` 146 项全绿。0.4.0 之后新增 44 项：图投影 10、数据集 7、设计 6、规则 15、跨 lane 集成 6（图契约 12 项在 0.4.0 前已落地）。
- 「校正后只有引用该数据集的设计被标待复核、复制出的方案不受影响」由集成用例覆盖。
- 真实示例 `examples/two-level` 跑 `space program check`：0 error / 0 warning。

### 修复

- **写权威数据后自动刷新推导图投影**：`runCapability` 在 `sideEffects` 含 `write:data` 的能力成功后调用 `projectFromFiles`，能力结果带 `graph: {nodes, edges, forks}`，CLI 不要求再手动 `space graph sync`。投影是派生数据，刷新失败只记日志、不影响能力成功。
- **`dataset.build` 重建保留确认记录**：`confirmations` 与 `corrections` 不再被重新解析抹掉；来源未变时状态保持不变、产物字节稳定；来源变化时只把 `confirmed` 降为 `stale` 并在摘要里提示，同时报告「确认记录指向的构件已不存在」的数量。

### M2 收尾

#### 新增

- `annotation.confirm`：逐项确认（值 / 判为无效），必须写依据，记录时间与确认人；覆盖时保留 `previous` 历史；同内容重复确认不写盘。
- 设计版本 `uses`：声明该版本用到的构件 handle；`design.create --uses H1,H2`，`design.version` 未显式给时继承上一版本。
- 构件级影响：`dataset.correct` 的复核清单从「数据集节点」细化到「哪个版本用到变化的那个 handle」，且权威来自文件，不依赖索引。
- 工作台「确认清单」面板：逐项确认、判为无效，显示依据与时间；没有数据集时给出可执行提示。

#### 变更

- `dataset.correct` 的 `review` 结构：`suggested` 带 `matched`/`reason`（`touches-changed` / `depends-on-dataset`）、`untouched`、`changedHandles`、`downstream`（下游产物，索引缺失时显式降级）。
- 契约：`validateDataset` 要求每条确认必须带 `basis`；`invalid: true` 的确认可以不写值。`validateDesignVersion` 校验 `uses`。

#### 验收

- `npm test` 150 项全绿（新增确认 2 项、构件级影响 2 项、版本继承 1 项）。
- 端到端：`dataset build` → `annotation confirm` → `annotation list` 显示「已确认 1 条 · 待确认 3 条」；工作台面板显示状态行。
- 构件级：`uses: ['H1']` 的方案在 H1 变化时进复核清单，`uses: ['H2']` 的不受影响。

## 0.4.0 — 2026-11-25

### M1 几何索引与视口取数

#### 新增

- `src/indexer/`：SQLite 索引内核。schema（节点、边、版本、复制、实体、包围盒 rtree、事件、meta）、批量写入、包围盒查询、图层清单、索引摘要。
- `src/contracts/index-query.mjs`：查询契约（包围盒、图层/类型白名单、游标分页、可选总数）。
- 解析缓存：键为源文件哈希 + 解析器标识与版本 + 参数；命中直接读缓存，不重跑解析。
- `space index rebuild|stat|query|layers`：可从 `cad-source/v1` 产物建库（不解析），或从 DXF 解析后建库。
- `npm run bench:index`：五万合成图元的验收基准，未达标退出码 1（缓存命中 15ms、5000 条查询 p50 3.99ms、删索引后重建不重新解析）。
- `cad.inspect` 先查解析缓存，命中时完全不启动 Python，产物仍经存储登记。
- 工作台视口取数：`/api/index` 给摘要，`/api/entities` 按包围盒分页返回图元；新增「几何索引」面板，拖拽/滚轮换视口、按页加载。
- `node src/checks/studio.mjs <project.json>`：浏览器冒烟，断言首屏不请求整包 JSON、视口请求带包围盒、窄屏无横向滚动。
- `node` 表的最小数据集登记（`kind=dataset`），为 M2 的校正与设计留挂点。
- `space doctor` 增加「几何索引」检查；`node:sqlite` 不可用时索引命令返回 `available: false`，其余能力退回每次解析。

#### 变更

- 索引是派生存储（`store.derived('index')`）：整表重建而非逐行删除，重建时间从 541ms 降到 ~290ms；每次重建只写一条汇总事件。
- 读路径复用数据库句柄（按 mtime/size/inode 失效），工作台连续取视口不再每次开库。

#### 验收

- `npm test` 90 项全绿。
- `npm run bench:index` 达标。
- 索引不进文件登记，`space store verify` 不受影响。
- 工作台：两万图元项目首屏只取一页视口数据，整包 JSON 请求 0 次（`node src/checks/studio.mjs`）。

### M0 契约与存储骨架（已完成）

详见 [docs/storage.md](docs/storage.md)。

#### 新增

- `src/contracts/`：错误码表（四类前缀）、数据 schema 登记表、能力契约字段与校验、存储接口签名与不变量、CLI / 工作台 / worker 传输格式。
- `src/store/`：唯一写入入口。原子写（临时文件 + fsync + 改名）、基准哈希乐观锁、事件日志（每次写入与每次操作各一条）、artifact 内容寻址、项目写锁、`verify` / `rebuild`。
- `src/domain/`：几何、竖向关系、模型校验、尺寸校验下沉为纯函数；`src/space/*` 保留为兼容出口，视图与测试的引用路径不变。
- `space store verify|rebuild|events|stat`：核对登记、重建登记、导出事件日志、查看存储摘要。
- `space capabilities --check`：能力契约 lint。
- `docs/storage.md`：契约、存储、写入纪律与检查方式。
- 派生存储契约 `store.derived('index' | 'cache')`：SQLite 索引与解析缓存自己管文件，存储层管位置、项目锁与一条汇总事件；为 M1 预留，避免索引层另开发一套写法。

#### 变更

- CLI 改为命令表驱动：`bin/space.mjs` 只做分发，命令在 `src/cli/commands/` 按域分文件，帮助文本由注册表生成，未识别参数不再静默忽略。新增命令是纯追加，不再改同一段分支。
- 能力注册表按域拆分：`src/capabilities/{context,source,model}.mjs`，`index.mjs` 只做聚合，为 M2/M3 新增能力留出无冲突的落点。
- 能力注册表补齐契约字段（版本、输入输出、副作用、环境依赖、幂等性、错误码），`space capabilities` 输出随之扩展。
- 所有能力写入改经存储层：`cad.inspect` 与 `model.convert` 先写 `.space/tmp/`，再由存储搬进项目；`build.viewer` 的每个产物都登记并留事件。
- `space init`、`space lock`、`space skills`、家具资产脚本改用存储层的原子写入；新项目骨架逐文件登记。
- `space build --out` 必须落在项目内，否则按 `E_STORE_PATH` 拒绝。
- 权威数据修改需要 `baseHash` 与显式确认，哈希不一致直接拒绝。

#### 验收

- `npm test` 71 项全绿（原有 45 项不变，新增契约 7 项、存储 12 项、构建 4 项、CLI 3 项）。
- 静态扫描：除原子写入原语与两个浏览器冒烟脚本外，`src/`、`bin/` 无 `writeFileSync` / `appendFileSync` / `createWriteStream`；`src/domain/` 无 IO 依赖。
- 同一空间数据两次构建产物字节一致；示例数据产物（`model.json`、`validation.json`、构建报告）与重构前字节相同。
- `白模.html` 哈希因压缩器标识符重排变化，页面数据、体积与浏览器冒烟结果不变。

## 0.3.2 — 2026-11-24

### 文档

- 新增 `docs/architecture.md`：L0–L6 分层职责、三种数据关系、存储模型、写入纪律、决策记录。
- 新增 `docs/roadmap.md`：M0–M5 实现计划、验收指标、现有项目迁移安排。
- README 与 AGENTS.md 增加架构摘要与文档入口。

## 0.3.1 — 2026-11-23

### 修复

- 工作台构建用例改用临时项目，不再与并行用例共用示例 `output/`，消除偶发失败。

## 0.3.0 — 2026-11-23

### 新增

- `space studio`：随包发布的本地工作台。按阶段组织能力，所有项目共用；前端由 esbuild 在启动时打包。
- 能力注册表 `src/capabilities/`：`cad.inspect`、`cad.preview`、`model.validate`、`build.viewer`、`model.preview`、`model.convert`；CLI 与工作台调用同一实现。
- 3D 舞台 `src/studio/views/model3d.js`：GLB/GLTF/FBX/OBJ 预览、尺度与三角面统计、线框、动画播放、自动取景与资源释放。
- `space model convert`：调用本机 Blender 将 `.blend` 导出为 GLB。
- `space capabilities`：输出能力注册表，供脚本与界面共用。
- `space doctor` 增加 Blender 检测。

### 变更

- 新增运行时依赖 `preact`（工作台界面）；`three` 同时服务户型白模与外部模型预览。

### 限制

- 压缩模型（Draco/KTX2/MeshOpt）尚未接入解码器。
- 工作台不做数据编辑，仍以 CLI 与文件为准；写入仅限 `output/`。

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
