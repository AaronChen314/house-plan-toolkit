// L3 能力：空间数据与三维。校验只读，生成只写 output/。
import fs from 'node:fs';
import path from 'node:path';
import {loadProject} from '../cli/project.mjs';
import {buildProject} from '../cli/build.mjs';
import {fail} from '../contracts/errors.mjs';
import {relOf, resolveInside, runProcess} from './context.mjs';

export const capabilities = [
  {
    id: 'model.validate',
    version: '1.0.0',
    stage: 'data',
    title: '空间数据校验',
    description: '检查标高、引用、多边形与覆盖值，不生成文件。',
    params: [],
    inputs: {model: 'space-model/v1'},
    outputs: {},
    sideEffects: ['none'],
    requires: [],
    idempotent: true,
    errors: ['E_DATA_INVALID', 'E_DATA_SCHEMA', 'E_DATA_REFERENCE'],
    async run(ctx) {
      const loaded = loadProject(ctx.file);
      const issues = loaded.report.issues || [];
      return {
        summary: loaded.report.passed ? '通过' : `${issues.length} 个问题`,
        outputs: [],
        data: {passed: loaded.report.passed, issues}
      };
    }
  },
  {
    id: 'build.viewer',
    version: '1.0.0',
    stage: 'model',
    title: '生成平面核对 / 白模',
    description: '从空间数据生成离线单文件页面，输出到项目 output/。',
    params: [
      {key: 'viewer', label: '视图', type: 'select', options: ['white-model', 'drawing'], default: 'white-model'}
    ],
    inputs: {model: 'space-model/v1', project: 'space-project/v1'},
    outputs: {viewer: 'artifact:html', report: 'artifact:json'},
    sideEffects: ['write:artifact'],
    requires: [],
    idempotent: true,
    errors: ['E_DATA_INVALID', 'E_DATA_SCHEMA', 'E_STORE_PATH', 'E_STORE_IO'],
    async run(ctx, {viewer = 'white-model'}) {
      const r = await buildProject(ctx.file, {viewer, store: ctx.store});
      return {
        summary: relOf(ctx.dir, r.file),
        outputs: [{path: relOf(ctx.dir, r.file), kind: 'html'}],
        data: {file: relOf(ctx.dir, r.file), viewer}
      };
    }
  },
  {
    id: 'model.preview',
    version: '1.0.0',
    stage: 'model',
    title: '外部模型预览',
    description: '预览 Blender / SketchUp 导出的 GLB、GLTF、FBX、OBJ，查看尺度、材质与动画。',
    params: [{key: 'file', label: '模型文件', type: 'path', required: true, accept: '.glb,.gltf,.fbx,.obj'}],
    inputs: {file: 'artifact:model'},
    outputs: {},
    sideEffects: ['none'],
    requires: [],
    idempotent: true,
    errors: ['E_EXEC_PARAM', 'E_STORE_PATH'],
    async run(ctx, {file}) {
      const abs = resolveInside(ctx.dir, file);
      if (!fs.existsSync(abs)) throw fail('E_EXEC_PARAM', `文件不存在：${file}`);
      const bytes = fs.statSync(abs).size;
      return {
        summary: `${(bytes / 1048576).toFixed(2)} MB`,
        outputs: [],
        data: {file: relOf(ctx.dir, abs), bytes}
      };
    }
  },
  {
    id: 'model.convert',
    version: '1.0.0',
    stage: 'model',
    title: 'Blender 转 GLB',
    description: '用本机 Blender 把 .blend 导出为 GLB，供工作台预览或交付。',
    params: [
      {key: 'file', label: '.blend 文件', type: 'path', required: true, accept: '.blend'},
      {key: 'out', label: '输出文件', type: 'text', default: 'output/model/preview.glb'}
    ],
    inputs: {file: 'path:blend'},
    outputs: {glb: 'artifact:model'},
    sideEffects: ['write:artifact'],
    requires: ['blender:cli'],
    idempotent: true,
    errors: ['E_EXEC_PARAM', 'E_EXEC_DEPENDENCY', 'E_EXEC_PROCESS', 'E_STORE_PATH', 'E_STORE_IO'],
    async run(ctx, {file, out = 'output/model/preview.glb'}) {
      const src = resolveInside(ctx.dir, file);
      if (!fs.existsSync(src)) throw fail('E_EXEC_PARAM', `文件不存在：${file}`);
      const target = resolveInside(ctx.dir, out);
      if (!target.startsWith(ctx.outputDir + path.sep) && target !== ctx.outputDir) {
        throw fail('E_STORE_PATH', `输出必须落在 output/：${out}`);
      }
      const blender = process.env.BLENDER_PATH || 'blender';
      const staging = ctx.store.staging();
      try {
        const glbTarget = path.join(staging, 'preview.glb').split(path.sep).join('/');
        const expr = `import bpy;bpy.ops.export_scene.gltf(filepath=r'${glbTarget}',export_format='GLB',export_apply=True)`;
        runProcess(ctx, blender, ['--background', src, '--python-expr', expr]);
        if (!fs.existsSync(glbTarget)) throw fail('E_EXEC_PROCESS', 'Blender 未生成 GLB，检查模型是否为空');
        const result = ctx.store.writeArtifact(relOf(ctx.dir, target), fs.readFileSync(glbTarget), {kind: 'model'});
        return {
          summary: `${(result.size / 1048576).toFixed(2)} MB`,
          outputs: [{path: result.path, kind: 'model'}],
          data: {file: result.path}
        };
      } finally {
        fs.rmSync(staging, {recursive: true, force: true});
      }
    }
  }
];
