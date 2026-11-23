# 数据格式 v1

四种接口各自保留，不把一种文件当另一种解释：

| 接口 | 用途 | 生成 / 消费方 |
|---|---|---|
| `cad-source/v1` | 图元索引，图层、颜色、文字、块路径、源摘要、原始单位 | `cad inspect` / `cad view` |
| `space-model/v1` | 已核查空间实体、竖向关系及预览假设 | 项目数据 / 公共白模与平面核对 |
| HouseSpec | 原设计器的墙线、房间、家具及编辑器输入 | 早期识别脚本 / `build --viewer designer` |
| `design-sync/v1` | 已确认设计更新三维时的版本、变更、门禁和固定机位 | `sync check` / 三维同步流程 |

JSON Schema 见 模型（space-model.schema.json）、项目配置（project.schema.json）、同步清单（design-sync.schema.json）。允许扩展来源、设计变更与核查字段，不静默删除不认识的信息。Schema 查字段类型，`check` 查引用和高度，`sync check` 查同步阻断条件，`checks/data.py` 另查多边形有效性；逐图对照仍需完成。

同步清单的字段、风险分类和覆盖规则见 设计到三维同步清单（../../reference/design-sync-manifest.md）。它引用项目配置和设计数据，不替代 `space-model/v1`。

## 坐标与楼层

`space-model` 固定毫米，平面 X 向右、Y 向下，竖向正值向上。CAD 原点/单位转换和各层对齐依据保存在项目来源记录。三维导出为米；显示中心和展开间距不改变真实平面坐标或标高。

`floors[]` 每项至少有 `id/name/elevation/clearHeight/slab`：

- `elevation`：统一建筑基准下的完成面标高，可以是负数，0 是有效数值。
- `clearHeight`：完成面至该层基准顶面的净高。局部更低的顶面独立表达。
- `wallHeight`：可选，墙体拉伸高度，默认净高；分层表达通高围护时显式指定。
- `slabThickness`：可选，楼板/预览构造厚度；默认由 `defaults.slab` 提供，未设时预览值为 150。
- `slab/walls/columns/outdoor/roofSlab`：多边形数组。多边形形如 `{"outer":[[0,0],[4000,0],[4000,3000],[0,3000]],"holes":[]}`。环可带或不带重复终点；加载时补空 holes。
- `roofSlab` 必须显式提供；不凭“这是最高一层”自动给露台封顶。
- 其他几何数组可为空；没有漫游入口时隐藏进入功能，不发明入口。

高度字段既可为数字，也可为关系：

```json
{"floorId":"ground","field":"elevation","valueMm":3100,"slabFactor":1}
```

含义是 `ground.elevation + 3100 + 当前公共板厚`。`field` 默认 `elevation`；省略 `floorId` 时基值为 0。关系可引用 `elevation/clearHeight/wallHeight/slabThickness` 中明确存在的字段；循环、引用缺失及未知值会报错。关系中的板厚系数使用公共滑杆值；各层单独固定的板厚用 `slabThickness` 显式声明。

## 门窗、家具与局部顶面

| 对象 | 必要内容 |
|---|---|
| 家具 | `id/kind/footprint[]/heightMm`；`label/sourceHandles/heightFrom` 提供名称与依据 |
| 定制柜 | 同家具，增加 `cabinetRole`：`full/counter/low/bar/appliance`，可设 `baseMm/topGapMm` |
| 门 | `kind:"door"`、`id/hinge/closedEnd/openEnd/heightMm/thicknessMm`，坐标为二维点 |
| 窗 | `kind:"window"`、`id/footprint/sillMm/headMm`，footprint 是单个多边形，窗顶须高于窗台 |
| 楼梯 | 层的 `stairsTo` 指向目标层，`treads[]` 放踏步多边形；可用 `{polygon,heightMm}` 指定相对本层完成面的踏步顶高，否则均分层间高差并标为示意 |
| 护栏 | `guards[]` 中 `a/b/heightMm` |
| 室内入口 | `walkEntries[]` 中 `name/point/yaw`，yaw 为弧度；入口须在地板上且避开障碍 |

`full` 柜可不填固定高度：以本层净高为上限，结合 `ceilingFromFloorIds` 中与柜体占地相交的上层楼板底、`ceilingZones` 的局部顶面，取最低值，减去柜底高度和顶缝。局部顶面形如 `{footprint:[…],top:高度表达式}`，`top` 是统一基准的绝对标高。当前实现按整个柜体与分区的相交关系取最小高度，斜顶需另建细分数据。

`heightFrom` 写明如 `drawing/user-confirmed/preview-assumption`，具体证据、标注原文和未核项保留为附加字段或项目记录。`sourceHandles` 不等于已确认高度；没有竖向来源会给出警告。

`assetId` 明确绑定模型目录中的 ID。`facing` 是前向弧度，模型约定为底部居中、前向 +Z；`modelHeightMm/minAssetHeightScale` 表达高度选择，不影响原平面占地。定制柜体和洁具继续使用程序化几何。

## 项目配置与覆盖

`project.json` 读取 `model` 后应用 `floorSettings[楼层id]`、`furnitureBindings[楼层id:构件id]`、`view/defaults`；输出校验后的 `model.json`，不写回输入文件。图纸抽取数据可保留原始表达，确认后的层高关系放在项目配置。

构件 ID 在同层家具、门、窗之间唯一，楼层 ID 在项目中唯一。资产映射只用 ID，不按房间名称猜测。

`overrides[楼层id:构件id]` 保存柜体及门窗尺寸覆盖。网页加载顺序：模型字段 → 旧项目兼容覆盖（仅显式声明时）→ 配置覆盖 → 当前项目浏览器覆盖。浏览器键为 `space-toolkit:<projectId>:dimensions:v1`。`overrideAliases` 仅用于迁移旧重复 ID，不让其他项目共用设置。

导出的尺寸 JSON 包含 `projectId/overrides`，其他项目不能导入；旧导出没有项目 ID 时仍检查构件 ID。重新生成前将长期有效的网页覆盖写回配置，直接改 HTML 或仅留在浏览器不构成可移交的数据源。

## 核查范围

`space.mjs check` 检查必要单位、ID、层高引用、基础坐标、构件高度和入口地板支撑，并报告竖向来源缺失与净高冲突。`checks/data.py` 检查 Schema 与墙、板、柱、家具、窗、踏步等多边形自交/面积。浏览器检查验证实际渲染、楼层切换、入口碰撞和导出。

这些检查尚不自动证明原图无遗漏、所有洞口都有正确宿主、楼梯净空合规或管路可施工；这些证据继续放在项目核查记录中。
