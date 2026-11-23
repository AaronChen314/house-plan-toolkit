# 公共户型工具包

将 CAD 核查、空间数据、平面核对、三维白模、家具资产和交付检查放在同一个目录。各项目提供自己的图纸、数据及配置，公共模板按配置加载空间关系和家具资产。

先看 [数据格式](../schemas/README.md)，再按下面的命令运行。三个领域 skill 负责读图与设计判断，`design-to-3d-sync` 负责设计版本到三维的交接和阻断检查，`design-image-render` 负责基础图与风格图的出图和验收，工具包负责可重复执行的处理与展示；颜色、图块名称和识别结果仍需结合当前图纸核查。

## 首次安装

从仓库根目录执行（Node.js 20+、Python 3.10+）：

```sh
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

Windows 使用 `.venv/Scripts/python.exe`。Python 命令会优先使用包内虚拟环境，也可以设置 `SPACE_PYTHON`。浏览器检查需要 Chrome/Chromium，自动发现或通过 `CHROME_PATH` 指定；生成 HTML 本身不需要浏览器。

工具包可整个复制到其他位置；依赖重新安装即可。所有 CLI 输入路径相对当前工作目录，`project.json` 里的数据、输出、资产目录相对该配置文件。包内只有一个设计器模板和一份模型资产，旧路径为兼容入口。复制时保留目录内符号链接，或复制链接实际内容。

## 先运行独立示例

```sh
space check --project examples/two-level/project.json
space build --project examples/two-level/project.json
space build --project examples/two-level/project.json --viewer drawing
space serve examples/two-level/output/白模.html --no-open
```

两层示例是合成测试数据，包含负标高、异地原点、挑空、局部柜顶、不同板厚及室内入口。白模 HTML 内嵌脚本与所用家具，可离线打开。

## 新项目怎么接入

可先复制 [空项目模板](../templates/project/README.md)，再按以下步骤接入。

1. 在项目中保留 `source/` 原图及核查记录；建立 `data/model.json`，按 `space-model/v1` 填入确认数据和明确的预览假设。
2. 建立配置，路径相对配置文件：

```json
{
  "schema": "space-project/v1",
  "id": "my-house",
  "name": "我的住宅",
  "model": "data/model.json",
  "output": "../../output/my-house",
  "assets": "../../src/furniture/assets/catalog.json"
}
```

3. 运行 `check`，处理错误；运行 `build --viewer drawing` 对照平面，再运行 `build` 查看白模。未知的必要标高和净高会阻止建模，须补证据或明确写入预览假设。
4. 核查上下层、柜顶、门窗、关键室内路径，再导出及打包。输出不是数据源；修改应回到项目数据或覆盖配置。
5. 设计版本更新已有三维时，增加 `design-manifest.json`，先运行 `sync check`，再构建平面核对或白模。风险分类和输出目录见 [同步清单](design-sync-manifest.md)。

尚无资料时可设 `model: null` 并标记 `status: "awaiting-source"`，收到本项目图纸后再填写模型路径。

## 常用入口

| 工作 | 命令或位置 |
|---|---|
| DXF 图元索引 | `space cad inspect source.dxf --out output/cad` |
| 源图核对网页 | `space cad view output/cad/source.json --out output/cad` |
| 校验空间关系 | `space check --project projects/<id>/project.json` |
| 设计版本同步清单 | `space sync check --manifest projects/<id>/design-manifest.json` |
| 平面核对 / 白模 | `build --project … --viewer drawing` / `build --project …` |
| HouseSpec 设计器 | `build --project … --viewer designer`，配置提供 `spec` |
| 早期识别 / 对账脚本 | `space tools`；`run dxfinventory source.dxf …` |
| 家具资产 | `space assets list`，其他参数见 [资产说明](../src/furniture/assets/README.md) |
| 浏览器实际检查 | `node src/checks/white-model.mjs output/<id>/白模.html` |
| JSON 格式与多边形检查 | `.venv/bin/python src/checks/data.py output/<id>/model.json` |
| 交付打包 | `space pack --project projects/<id>/project.json` |

DWG 需要本机可用的转换器先转换为 DXF；这里未内置专有 DWG 解码。`cad inspect` 保留图层、颜色、块实例路径和源文件摘要，不自动把线条认成墙；不支持生成预览的图元保留在索引并报告。源图网页是核对辅助，文字排版及复杂 CAD 对象仍应与原 CAD 对照。

`drawing` 面向构件与原线稿对照，不具备原设计器的拖拽编辑；`designer` 继续使用独立的 HouseSpec 接口。两者与原始 CAD 索引不做隐式、有损的相互转换。

## 白模与用户修改

- 每个项目用不同 `id` 隔离浏览器尺寸设置；楼层数量、坐标中心、楼层关系、入口均来自数据。
- 柜体使用占地多边形和明确柜型。到顶柜读取所在区域上方楼板/局部顶面；普通家具使用 `assetId` 显式绑定。替换成品家具不自动替换定制柜或洁具。
- 支持单层/多层、实际标高/展开、剖低墙、门窗模型、板厚联动、室内漫游、PNG/GLB 导出。漫游需在 `walkEntries` 提供经过核查的入口；楼梯还需明确目标层及踏步。
- 网页尺寸修改保存在浏览器中，可导出/导入参数 JSON。长期维护时将其 `overrides` 合入项目配置，便于其他浏览器和 AI 复现。配置、已有浏览器显式设置的优先级见数据格式。
- 再次生成会把旧 HTML 和相应数据保存在输出的 `history/`。直接手改 HTML 无法普遍逆向恢复到数据中，先备份，再将修改对应到数据/资产/覆盖字段。
- 资产的许可、来源、尺寸和哈希保留在 `furniture-credits.json`；仅嵌入当前项目实际引用的模型。

首版支持水平楼面、平面多边形和分区平顶。斜顶、曲面、复杂门窗分格与施工级楼梯净空需扩展模型和检查；不能把浏览器通过当成完成结构或机电审查。

## 目录与迁移边界

| 目录 | 内容 |
|---|---|
| `cad/` | 保留来源的 DXF 索引 |
| `space/`、`schemas/` | 公共空间关系与数据约定 |
| `viewers/white-model/`、`viewers/drawing/` | 白模与平面对照源码、模板 |
| `furniture/` | CLI、资产归一与模型目录 |
| `checks/`、`tests/` | 数据、浏览器和独立示例检查 |
| `cli/` | 项目加载、生成、预览和打包 |
| `legacy/` | 早期脚本及已编译的 HouseSpec 设计器；见 [兼容范围](../src/legacy/README.md) |
| `templates/project/` | 不含户型数据的新项目模板 |
| `examples/` | 不依赖真实项目的最小示例 |

旧 `scripts/*` 保留原有调用入口，`assets/template.html` 和 `assets/furniture` 链接到公共实现。公共实现与原路径的对应关系见 [迁移清单](migration-map.json)。

## 维护时验证

```sh
npm test
space build --project examples/two-level/project.json
node src/checks/white-model.mjs examples/two-level/output/白模.html
.venv/bin/python src/checks/data.py examples/two-level/output/model.json
.venv/bin/python tests/design_sync_test.py
```

改动公共渲染或空间关系后，检查独立两层示例。手头有真实案例时，可补充核查对应的楼层和构件。改动 CAD 读取时检查镜像块与源句柄，改动兼容层时运行对应旧入口。
