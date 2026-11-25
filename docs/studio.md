# 本地工作台

`space studio` 启动随包发布的前端应用。所有项目共用同一套界面与组件，项目只提供数据；工作台不生成项目级 HTML，也不复制前端代码。

```sh
space studio --project my-house/project.json --open
```

只绑定 `127.0.0.1`，默认随机端口；`--port` 可固定端口。前端资源由 esbuild 在启动时打包，无需额外构建步骤。

## 能力与阶段

界面按阶段组织，能力在代码里注册（`src/capabilities/index.mjs`）：

| 阶段 | 能力 | 读写 |
|---|---|---|
| 图纸 | `cad.inspect`、`cad.preview` | 写 `output/cad/` / 只读 |
| 数据 | `dataset.build\|diff\|correct`、`annotation.confirm`、`program.check`、`model.validate` | 前两者写 `data/`，其余只读 |
| 设计 | `design.create\|version\|fork\|confirm\|stale` | 写 `data/designs/` |
| 三维 | `build.viewer`、`model.preview`、`model.convert` | 写 `output/` / 只读 |
| 交付 | `doc.*`、`render.colorplan`、`bundle.export`、`deliver.snapshot` | 写 `output/` |

**计划中**（契约已登记、不可执行，置灰显示并给出阻塞原因）：`doc.mep`、`doc.furniture`、`render.interior`。

三个专用面板：

- **几何索引**：按视口分页取图元（`/api/entities`），首屏不传整包；没建索引时给出重建命令。
- **确认清单**：逐项确认数据集里的假设值，必须写依据，可判为无效。
- **能力表单**：参数控件由 `params[].type` 生成（text / path / output / select / number / boolean），执行结果与日志在下方面板。

`build.viewer` 复用 CLI 的构建实现；`model.preview` 与白模共用同一个 three.js 舞台。插件能力加载后出现在同一侧边栏（带 `⊕` 标记）。

## 新增一个能力

能力写在自己的域文件里（`src/capabilities/<域>.mjs`），在 `index.mjs` 加一行展开；界面与 CLI 自动出现。

```js
{
  id: 'demo.thing',
  version: '1.0.0',
  stage: 'data',                   // source | data | design | model | delivery
  title: '示例能力',
  description: '显示在面板说明里',
  params: [{key: 'file', label: '文件', type: 'path', required: true}],
  inputs: {file: 'cad-source/v1'},
  outputs: {},
  sideEffects: ['none'],           // none | write:artifact | write:data | write:index
  requires: [],
  idempotent: true,
  errors: ['E_EXEC_PARAM'],        // 只能引用 contracts/errors.mjs 已登记码
  async run(ctx, params) {
    // ctx.file / ctx.dir / ctx.store / ctx.python / ctx.log / ctx.root
    // 写项目只经 ctx.store；返回 {summary, outputs:[{path, kind}], data}
  }
}
```

`space capabilities --check` 会校验字段与错误码。只有契约、还没实现的写在 `PLANNED_CAPABILITIES`（`src/contracts/capability.mjs`），两端显示为置灰。

约定：

- `run` 是唯一实现，CLI 命令与工作台都调它；不要在前端重写业务逻辑。
- 参数用 `params` 描述，CLI 与表单同源；`path`/`output` 类型在界面上从项目文件里选择。
- 只写 `output/`；需要改 `data/` 的能力必须先单独设计确认步骤。
- 新增能力要补 `tests/studio.test.mjs` 的注册表断言和一个无头调用用例。

## 安全与边界

- 文件接口只读项目目录内文件，`..` 越界直接拒绝。
- 渲染在浏览器内完成，不上传数据，不访问外部网络。
- 一个页面只保留一个 3D 舞台实例；切换模型会释放上一个 WebGL 上下文。
- `.blend` 转换依赖本机 Blender（`BLENDER_PATH` 或 PATH），缺失时其他能力不受影响。

## 已知限制

- 压缩模型（Draco / KTX2 / MeshOpt）尚未接入解码器；Blender 导出时请关闭压缩，或等后续版本。
- Blender 转换按场景整体导出，不处理多相机、灯光预设和动画分段。
- CAD 源图预览是索引结果的快速核对，复杂文字排版仍以原 CAD 为准。
- 大模型（>200MB）没有分块加载，加载期间界面会等待。

## 验证

```sh
node --test tests/studio.test.mjs     # 注册表、路径守卫、服务、能力无头调用
space studio --project examples/two-level/project.json --open
```
