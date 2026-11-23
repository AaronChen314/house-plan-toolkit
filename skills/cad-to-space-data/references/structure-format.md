# CAD 结构线框数据 v2

本格式用于可追溯的二维户型绘制。JSON Schema 位于 [structure.schema.json](structure.schema.json)，实例为生成目录中的 `walls.json`。Schema 使用 JSON Schema Draft 2020-12；生成器构建时必须通过校验。

## 坐标与空值

- `schema: "cad-structure/v2"`、`schemaVersion: 2`、`units: "mm"`。
- 每层独立绘图坐标：x 向右，y 向下。`floors[].origin` 是该层在原 CAD 中的基准点：`x = CAD.x - origin.x`，`y = origin.y - CAD.y`。
- 这是各层二维图纸的坐标，不声称已经测得三维楼层标高或上下层实际对齐关系。
- 线框坐标保留到 0.000001 mm；这一输出精度不是测量精度声明。
- 未标明的厚度、高度、洞口宽度与材料填 `null`，不填写默认值、估计值或 0。
- 圆弧 `start/end` 保留 CAD 角度，绘制时 y 已翻转，使用逆向 SVG 圆弧。文字记录原图字号、位置、旋转及对齐方式。MTEXT 用 `lineAdvanceMm` 保留原图段间距与段落换行，LX 标注原文（含 m 单位）保留在 `geometry[].text`；不以此推定梁截面高度。

## 文档结构

| 字段 | 含义 |
|---|---|
| `sourceName` / `sourceSha256` | 源文件显示名及转换后 DXF 的 SHA-256 |
| `coordinateSystem` | 毫米坐标方向与变换约定 |
| `palette` | ACI 色值表、官方来源、项目映射声明 |
| `typeCatalog` | 类型 → 语义种类、显示名称、输出图层、ACI 色号、线型、线宽、依据 |
| `sources` | 原图图元目录，以句柄或 `块引用句柄/块内图元句柄` 为键 |
| `floors` | 楼层编号、名称、原点、显示范围及 `objects` |

## 构件 / 轮廓对象

| 字段 | 类型 / 规则 |
|---|---|
| `id` | 唯一且稳定的对象编号；拆分图元用 `/0`、`/1` 后缀 |
| `floorId` | 所属楼层编号，必须等于容器楼层 |
| `type` | 引用 `typeCatalog` 的类型键，见下表 |
| `geometryRole` | `source_outline` 原图轮廓；`component_outline` 已核对的轮廓组；`opening_marker` 按原图墙端生成的洞口查看框；`annotation` 原图文字标注 |
| `structuralRole` | `unknown` / `load_bearing` / `non_load_bearing`，与厚度及颜色分开记录 |
| `material` | 已确认材料名称；未知为 `null` |
| `dimensions` | `thicknessMm`、`heightMm`、`openingWidthMm`，每个字段均为正数或 `null` |
| `classification` | `status` 为 `unconfirmed` / `drawing_observed` / `user_confirmed`；`basis` 为依据说明 |
| `sourceIds` | 指向文档 `sources` 的来源集合，包含对象内所有几何的来源 |
| `geometry` | `polyline` / `arc` / `text` 数组；每个几何均含来源、`origin` 和 `cadColorIndex` |

`geometryRole` 是必要区别：一个 `source_outline` 可能只是墙的一侧边线，不能把每个对象都统计为一面完整墙。`component_outline` 也不保证闭合，例如楼梯踏步组和有缺边的庭院外围。当前数据不虚构中线连接、墙高或洞口宿主墙关系。

几何的 `origin: drawing` 表示由源图读取；`review_marker` 表示根据成对墙端坐标生成的查看标记，不是原图墙线。只有后者不参与原始直线完整性对账。

`sources` 保留 `handle`、`blockHandle`、`blockName`、`layer`、`entityType`、`colorIndex`、`resolvedColorIndex`、`lineType`。`colorIndex` 可为 BYBLOCK 0 / BYLAYER 256；`resolvedColorIndex` 记录解析后的索引色。LEADER 展开后的可见颜色还受 CAD 标注样式影响，所以各几何保留最终 `cadColorIndex`。

## 类型与配色

| 类型键 | 输出图层 | ACI | 含义 |
|---|---|---:|---|
| `wall` | A-WALL-UNKN | 2 黄 | 普通墙线，承重待确认；沿用原图 |
| `bearing` | A-WALL-LOAD | 1 红 | 用户确认的承重墙 |
| `nonbearing` | A-WALL-NONLOAD | 3 绿 | 用户确认的非承重墙 |
| `thin` | A-WALL-THIN | 4 青 | 已核对的薄墙；不隐含非承重 |
| `partition` | A-PARTITION | 6 品红 | 用户确认的隔断；承重状态独立 |
| `enclosure` | A-ENCLOSURE | 8 灰 | 花园、阳台围护；材料及高度不推断 |
| `beam` | S-BEAM | 6 品红虚线 | 原图梁轮廓；LX 文字沿用青 4，独立开关 |
| `column` | S-COLUMN | 8 灰 | 原图柱块轮廓，不实心填充 |
| `door` | A-DOOR | 3 绿 | 原图门扇与开向 |
| `window` | A-GLAZING | 3 绿 | 原图门窗边框，不猜门窗具体构造 |
| `opening` | A-OPENING | 4 青虚线 | 洞口及用途待确认的原图虚线框 |
| `stair` | A-STAIR | 8 灰 | 踏步及平台；方向 / 折断线沿用红 1，文字沿用青 4 |
| `unconfirmed` | A-REVIEW | 6 品红虚线 | 用途待确认的轮廓 |

ACI 索引色采用 [Autodesk 官方定义](https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-14BC039D-238D-4D9E-921B-F4015F96CB54.htm)，图层组织参考 [Autodesk 的分层属性说明](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-OnBoarding/files/ACD_FOUNDATIONS_MAIN8.html)。原图墙黄 2、门窗绿 3、柱及围护灰 8 继续保留。其余语义对应是本项目明确记录的图层约定，不是声称全行业采用“红色等于承重”的通用标准。

网页采用固定黑底绘图区，直接呈现 ACI RGB 值；界面浅色 / 深色切换不会重新调制这些颜色。网页默认类型分层色，也可切换到原图色。SVG 使用同一绘制逻辑，嵌入黑底和实际色值，不依赖网页 CSS。JSON 始终包含两种模式所需的数据，不受当前筛选影响。

## 校验规则与兼容性

- 构建必须通过 JSON Schema；对象类型、来源引用、楼层归属和图元唯一性另做语义检查。
- `bearing` 必须同时写 `structuralRole: load_bearing` 和 `classification.status: user_confirmed`；`nonbearing` 同理。只改变颜色不构成结构判定。
- 原图直线拆分后，各子段必须完整覆盖原线，无移动、漏段或增加长度。查看标记不参与此检查。
- 花园围护、阳台围护和三层楼梯的句柄列入专项回归检查；梁图层及 LX 文字全量与源图对账；显示范围覆盖新增外边界。
- 网页读取旧 v1 本地分类记录时，仅迁移仍存在且允许修改的对象 ID。新保存记录使用 v2 存储键。
- 原 v1 中 `category` 改为 `type`，`bearing` 改为 `structuralRole`，`thickness/height/width` 合并到 `dimensions`，零散 `source` 属性规范为文档级 `sources` 与 `sourceIds` 引用。v1 JSON 不能伪装成 v2 使用。

以一楼花园围护为例：

```json
{
  "id": "1f-garden-wall",
  "floorId": "1f",
  "type": "enclosure",
  "geometryRole": "component_outline",
  "structuralRole": "unknown",
  "material": null,
  "dimensions": {"thicknessMm": 240, "heightMm": null, "openingWidthMm": null},
  "classification": {
    "status": "drawing_observed",
    "basis": "一楼右下花园南侧围护双线，间距 240 mm；高度、材料和承重未标明。"
  },
  "sourceIds": ["64E6", "6506"],
  "geometry": [
    {"kind": "polyline", "points": [[9890, 11000], [3750, 11000]], "closed": false,
      "sourceIds": ["64E6"], "origin": "drawing", "cadColorIndex": 8},
    {"kind": "polyline", "points": [[9890, 11240], [3750, 11240]], "closed": false,
      "sourceIds": ["6506"], "origin": "drawing", "cadColorIndex": 8}
  ]
}
```
