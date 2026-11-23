# 家具 3D 模型包（GLB）

当前唯一资产目录为 `toolkit/furniture/assets/`，根目录 `assets/furniture` 是兼容链接。安装依赖用 `npm --prefix toolkit ci`，统一入口为 `node toolkit/cli/space.mjs assets …`。公共白模使用项目 `furnitureBindings` 的 `assetId`，无需 patch 模板；下文的 `patch` 只适用于旧 HouseSpec 设计器。

列表以 `catalog.json` 为准；模型按功能命名，不绑定具体项目。目录中的历史说明保留来源和处理方法，远端可用性以实际查询结果为准。

设计器里**可移动家具**（沙发 / 餐桌 / 床 / 床头柜…）用的写实模型。定制柜体、橱柜、洁具、构件仍然是程序化几何，
不动这里的内容。

```
assets/furniture/
  catalog.json          清单：文件、真实尺寸、绑定的家具 key、可染色材质、许可证
  *.glb                 归一后的模型（单文件，无贴图或 WebP 贴图）
```

模板 `assets/template.html` 里的 `<script id="__furn3d">` 与运行时函数都由 `scripts/furniture3d.mjs patch` 生成，
**不要手改**；改了 `catalog.json` 之后重跑 patch 即可（幂等）。

## 现在的模型

| 模型 | 真实尺寸 (w×d×h mm) | 绑定 key | 三角面 | 许可 |
|---|---|---|---|---|
| sofa-main | 2500×920×990 | sofa, fourSofa, officeSofa | 3140 | CC0 |
| sofa-2s | 1900×920×990 | loveseat | — | CC0 |
| sofa-l | 2400×1740×935 | lSofa | 2464 | CC0 |
| bed-main | 1710×2190×1105 | bed18, bed15 | 1944 | CC0 |
| dining-6s | 2000×1000×773 | diningTable, diningTable6, longTable | 512 | CC0 |
| nightstand-main | 450×420×530 | nightstand | 588 | CC0 |
| chair-main | 490×471×1003 | chair | 1248 | CC0 |
| coffee-table-main | 1200×600×466 | coffeeTable | 448 | CC0 |
| armchair-dining | 579×525×995 | armDiningChair | 2116 | CC0 |
| chair-training | 480×480×950 | trainingChair | 864 | CC0 |
| tea-table | 841×836×499 | teaTable | 2508 | CC0 |

除 `tea-table` 来自 **Poly Haven** 外，其余来自 **3D Assets (3dassets.dev)**；全部 CC0（公共领域，商用、免署名）。

`tea-table` 是唯一的“尺寸拉伸”件：模型本身是 841×836×499 的中式茶桌，`teaTable` 的库尺寸是 1800×800×700，
按比例拉到 1.8m 长、0.7m 高（宽 ×2.14、高 ×1.40）。实测观感可以接受（罗锅枨 / 马蹄足拉长后仍像长茶台），
但如果你觉得腿太细、台面太厚，可以改成不绑 `teaTable`（保留带茶具和坐墩的程序化版本），或换一件更接近的长条桌。
原始条目、标题、作者、来源 URL 都记在 `catalog.json` 的 `credit` / `source` 里，交付时随设计器一起给用户。

## 新增 / 替换一件家具

```bash
cd <本 skill 仓库>
npm --prefix toolkit ci          # 首次：公共依赖

node scripts/furniture3d.mjs search "dining table" --provider threedassets
node scripts/furniture3d.mjs add <assetId> --as dining-oak \
     --keys diningTable,diningTable6 --tint fabricBlack
node scripts/furniture3d.mjs patch --external   # 写回 template.html（外链，模板不变大）
node scripts/furniture3d.mjs check
```

`add` 会做这几件事：

1. 从 `https://3d.shep.bot/v1/assets/{id}` 拿单文件 `glb`（该服务聚合 27 个 3D 资产站，无 key、返回许可证）；
   **Poly Haven 的资产**没有 glb（gltf + 分离的 bin/贴图），脚本会自动走 `api.polyhaven.com/files/{id}`
   把 1k 档的 gltf 和 include 文件抓到临时目录再读，之后一样压 WebP、量尺寸；
2. `dequantize + dedup + prune`（有贴图时压成 1024 WebP）——设计器的加载器不支持 Draco，所以不要开 Draco/meshopt；
3. 量包围盒换成毫米，写进 `catalog.json`（运行时按 `家具尺寸 / 模型尺寸` 缩放，和「我的模型」导入逻辑一致）；
4. 自动判朝向：靠背/床头板如果跑到 +Z 就转 180°，保证和程序化家具的前方一致（前 = +Z，背面贴 -Z 的墙）；
5. 列出材质名，把布料类（fabric / linen / upholstery / cushion…）记成可染色材质——用户在库里换颜色时只染这些，
   木料、金属、白色床品保持原样。用 `--tint ""` 关掉染色，或 `--tint a,b` 指定。

**为什么改颜色只要改 `tint` 不用重导模型**：设计器渲染家具时按材质名区分，GLB 的材质名（oak / walnut / fabricBlue…）
会原样保留，所以“布料跟家具颜色走、木头不动”是运行时做的，不是烘焙进模型里的。

**加载时序**（踩过的坑）：家具 3D 网格按“签名缓存”复用，签名里没有“模型到位”这一项。首帧时模型还没下载完，
会先画一版程序化几何然后就一直留着——所以模型加载完成后要主动把受影响家具从缓存里挑掉再重建
（运行时函数 `g3dRebuildFor`）。如果你在页面上看到“还是方块”，先确认这一钩子还在。

常用参数：`--rot 90` 手动定朝向，`--no-flip` 不自动翻转，`--long-x` 长轴不在 X 上时转 90°（床别用，会把床睡反）。

## 运行方式与体积

当前模板用的是 **外链模式**（`patch --external`）：模板只有 +5KB，运行时读同目录的 `assets/furniture/*.glb`。

- `build.py` 会自动把 `assets/furniture/`（glb + catalog.json）复制到输出 HTML 旁边，并用 `--zip` 打进交付包；
  构建结果里 `furniture3d` 字段就是复制到的相对目录。
- **必须通过 http 打开**（`file://` 读不到本地 glb）。双击打开时会弹一句提示、并**自动退回程序化家具**，不会白屏。
  本地看：`cd 输出目录 && python3 -m http.server 8000`，然后开 `http://localhost:8000/xxx.html`。
- `scripts/check.mjs` / `qa.mjs` / `closeup.mjs` / `walktest.mjs` / `clicktest.mjs` / `qa_furniture.mjs` 已经会自动识别这种外链模板：
  在这一层起个只读静态服务再打开（`browser.mjs` 的 `pageUrl()`），所以 3D 验收里看到的就是真模型。
- 需要“双击就能看”的单文件版时再跑 `node scripts/furniture3d.mjs patch`（不带 `--external`）：GLB 内嵌 base64，
  6 个模型约 +820KB（模板 2.1MB → 2.9MB），file:// 和分享导出都能带着走。
- 加载失败只打一条 warn，**自动退回原来的程序化家具**，不会白屏、不会占位方块。

验收：`window.__furn3d.ready() / failed() / pending()` 能看模型加载状态；
2D 平面图完全不受影响（同一份 plan 数据，2D 仍画矢量符号）。
