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
| 图纸 | `cad.inspect` DXF 图元索引 | 写 `output/cad/` |
| 图纸 | `cad.preview` 源图核对 | 只读 |
| 数据 | `model.validate` 空间数据校验 | 只读 |
| 三维 | `build.viewer` 平面核对 / 白模 | 写 `output/` |
| 三维 | `model.preview` GLB/GLTF/FBX/OBJ 预览 | 只读 |
| 三维 | `model.convert` `.blend` → GLB | 写 `output/` |

`build.viewer` 复用 CLI 的构建实现；`model.preview` 与白模共用同一个 three.js 舞台。

## 新增一个能力

```js
{
  id: 'cad.inspect',
  stage: 'source',                 // source | data | design | model | delivery
  title: 'DXF 图元索引',
  description: '显示在面板说明里',
  params: [{key: 'dxf', label: 'DXF 文件', type: 'path', required: true}],
  async run(ctx, params) {
    // ctx.file / ctx.dir / ctx.python / ctx.log / ctx.root
    // 只写 ctx.outputDir；返回 {summary, outputs:[{path, kind}], data}
  }
}
```

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
