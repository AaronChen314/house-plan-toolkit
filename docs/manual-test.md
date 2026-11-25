# 手工测试流程（CLI 能力）

给测试同学用：按阶段把 22 个已实现能力走一遍，每步有**预期输出**，对不上就按模板报 issue。全程在一个临时项目里进行，不碰真实项目。

- 基线版本：**v0.7.1**（从 [Release](https://github.com/AaronChen314/house-plan-toolkit/releases) 安装）
- 预计耗时：首次约 20 分钟，之后回归约 8 分钟
- 只用 CLI 就能覆盖全部能力；工作台另见 [studio](studio.md)

## 0. 准备

```sh
# 独立前缀安装，别覆盖开发机的 space
npm install -g --prefix ~/hp/v0.7.1 \
  https://github.com/AaronChen314/house-plan-toolkit/releases/download/v0.7.1/house-plan-toolkit-0.7.1.tgz
export SPACE=~/hp/v0.7.1/bin/space        # Windows: ~/hp/v0.7.1/Scripts/space

$SPACE version      # 期望 toolkit = 0.7.1
$SPACE doctor       # 记录输出；Python 依赖缺就先跑下一步
```

```sh
mkdir -p ~/hp-lab && cd ~/hp-lab
$SPACE init --id lab --dir lab
$SPACE setup --project lab          # Python 依赖装进项目的 .space/venv
$SPACE lint --project lab/project.json
```

**预期**：`lint` 输出 `PASS lab — 0 error / 0 warning`。

> 没有真实图纸时，用合成 DXF（ezdxf 已随 `space setup` 装好）：

```sh
cd lab && ~/hp-lab/lab/.space/venv/bin/python - <<'PY'
import ezdxf
doc = ezdxf.new(); msp = doc.modelspace()
for a, b in [((0,0),(6000,0)), ((6000,0),(6000,4000)), ((6000,4000),(0,4000)), ((0,4000),(0,0)), ((3000,0),(3000,2500))]:
    msp.add_line(a, b, dxfattribs={'layer': 'WALL'})
msp.add_text('3600', dxfattribs={'layer': 'DIM', 'height': 200}).set_placement((3000, -300))
doc.saveas('source/drawings/20260101-plan.dxf')
PY
```

## 1. 图纸：解析与缓存

```sh
S=~/hp/v0.7.1/bin/space
$S cap run cad.inspect --project project.json --dxf source/drawings/20260101-plan.dxf --out output/cad
```

**预期**：`6 个图元，0 条提示`，产出 `output/cad/source.json`。

再跑一次，**预期**出现「（命中解析缓存）」字样，且 Python 不再被调用。

```sh
$S cap run cad.preview --project project.json --source output/cad/source.json
```

**预期**：`6 个图元`。

## 2. 数据：数据集、确认、规则检查

```sh
$S dataset build --project project.json --source output/cad/source.json --id d1 --confirm
```

**预期**：`d1：N 条 trace，4 条预览假设`，并提示把 `project.json` 的 `model` 指向 `data/datasets/d1/model.json`。

> ⚠️ **已知步骤**：`dataset build` 不改 `project.json.model`（数据集才是权威）。不手动指过去，`space check` / `program check` 会报 `Project has no verified model yet`——这是预期行为，不是 bug。

```sh
# 手动把 project.json 的 model 改成 data/datasets/d1/model.json
$S annotation list --project project.json --dataset d1
```

**预期**：`状态 draft · 确认 0 条 · 假设 4 条`，列出 4 项待确认（elevation / clearHeight / wallHeight / slabThickness）。

```sh
$S annotation confirm --project project.json --dataset d1 \
  --object ground --field clearHeight --value 2750 --basis "图纸标注 2.75m" --actor 你的名字
$S annotation list --project project.json --dataset d1
```

**预期**：`已确认 1 条`，清单里该项显示「已确认 2750」。

**负向**（都应当失败）：

```sh
$S annotation confirm --project project.json --dataset d1 --object ground --field clearHeight --value 2800
# 预期：Error: 确认必须写依据（basis）

$S annotation confirm --project project.json --dataset d1 --object ghost --field heightMm --value 100 --basis x
# 预期：模型里没有 ghost（除非加 --invalid）
```

```sh
$S program check --project project.json
$S check --project project.json
```

**预期**：`通过` / `没有发现问题`。草稿模型没有墙体和门窗，所以规则检查本来就是 0 问题。

## 3. 设计版本

```sh
$S design create --project project.json --scheme a --dataset d1
$S design confirm --project project.json --scheme a --seq 1
$S design version --project project.json --scheme a --note "第二版"
$S design fork --project project.json --from a#1 --scheme b
$S graph show --project project.json
```

**预期**：`a#001 … 已确认`；`graph show` 显示 `dataset 1 · design 2`，边为 `d1→a`、`d1→b`，复制 1 条。

## 4. 施工图（拆改图）

草稿模型没有墙，先换成带墙的模型再出图：

```sh
cp ~/house-plan-toolkit/examples/two-level/data/model.json data/datasets/d1/model.json
$S store rebuild --project project.json
$S doc render --project project.json --scheme a --seq 1
```

**预期**：`拆改图 · a#001`，`比例 1:100 · 图层 frame, wall-existing, opening, dimension, note`。

**关键行为**（不是 bug）：再改模型后直接重出会被拒绝——

```sh
$S doc render --project project.json --scheme a --seq 1
# 预期：Error: 输入或产物已变化…先确认再重出：加 force
$S doc check --project project.json
# 预期：1 张，1 张待复核（并写明原因）
$S doc render --project project.json --scheme a --seq 1 --force
# 预期：重出成功，doc check 回到「全部与输入一致」
```

## 5. 渲染与交付

```sh
$S render colorplan --project project.json --scheme a --seq 1
$S bundle export --project project.json --scheme a --seq 1 --name lab
$S deliver snapshot --project project.json --scheme a --seq 1 --name lab
```

**预期**：

- 彩平：`彩平图 · a#001（XX.X ㎡ · 6 个图层）`
- 交付包：`交付包 lab：7 个文件`，生成 `output/bundle/lab/index.html`
- 快照：`只读快照 lab：… 内嵌 7 个文件哈希`

**离线验收**（最有价值的一步）：

```sh
node ~/house-plan-toolkit/src/checks/bundle.mjs project.json lab
# 预期：PASS bundle offline · 7 个文件 · 清单页零外部请求 · 快照 file:// 打开零网络
```

也可以手动双击 `output/bundle/lab/index.html` 与 `output/snapshot/lab.html`，断网后应当照常显示。

## 6. 索引、存储与推导图

```sh
$S index rebuild --project project.json --source output/cad/source.json
$S index stat --project project.json
$S index query --project project.json --box 0,0,7000,5000 --limit 3
$S store verify --project project.json
$S store events --project project.json --limit 5
$S graph stale --project project.json --node d1
```

**预期**：索引有图元数；`query` 返回分页结果（`3 条，下一页 --offset 3`）；`store verify` 为 PASS；`graph stale` 只预演、不写文件。

## 7. 门面与负向

```sh
$S cap list                      # 22 已实现 + 3 计划中
$S cap show doc.furniture        # 显示阻塞原因
$S cap run doc.mep --project project.json
# 预期：Error: doc.mep 还没有实现——…点位数据…
$S render interior --project project.json
# 预期：Error: 目前只实现 render colorplan
$S plugin list                   # 预期：已关闭（SPACE_PLUGINS=1 开启）
$S capabilities --check          # 预期：22 个已实现，3 个计划中
```

## 8. 结果怎么报

用仓库的 **测试反馈** issue 模板，必须包含：

1. `space version` 的 toolkit 字段（本例 `0.7.1`）
2. `cat .agents/skills/.skills-version`（跑过 `space skills sync` 才有）
3. 平台（macOS / Windows）与 `space doctor` 输出
4. 出问题的**完整命令**与**预期 vs 实际**
5. 产物路径或截图（`space store verify` 输出也很有用）

## 不需要测的

- `doc.mep`、`doc.furniture`、`render.interior`：只有契约，调用会被明确拒绝，这是设计而非缺陷。
- `render.interior` 的「只有契约」提示、`cap list` 里的计划项：属于门面行为，看一眼即可。
- `SPACE_PLUGINS` / `space index global`：开发者扩展能力，测试阶段可跳过。
