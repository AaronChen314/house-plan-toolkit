// 能力注册表：同一份实现同时供 CLI 与本地工作台调用。
// 每个能力声明所属阶段、参数、产物，并只写项目的 output/。
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadProject} from '../cli/project.mjs';
import {buildProject} from '../cli/build.mjs';
import {findPython} from '../cli/python.mjs';
import {ROOT} from '../root.mjs';
import {lintProject} from '../checks/layout.mjs';

export const STAGES = [
  {id: 'source', name: '图纸'},
  {id: 'data', name: '数据'},
  {id: 'design', name: '设计'},
  {id: 'model', name: '三维'},
  {id: 'delivery', name: '交付'}
];

export function resolveInside(base, rel) {
  const root = path.resolve(base);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`路径越界：${rel}`);
  return abs;
}

function relOf(projectDir, abs) {
  return path.relative(projectDir, abs).split(path.sep).join('/');
}

function runProcess(ctx, exec, args) {
  ctx.log(`$ ${path.basename(exec)} ${args.map(a => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);
  const r = spawnSync(exec, args, {cwd: ctx.dir, encoding: 'utf8'});
  if (r.stdout) ctx.log(r.stdout.trim());
  if (r.stderr) ctx.log(r.stderr.trim());
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`命令失败（退出码 ${r.status}）`);
  return r.stdout;
}

export function createContext(projectFile, {log} = {}) {
  const file = path.resolve(projectFile);
  const project = JSON.parse(fs.readFileSync(file, 'utf8'));
  const logs = [];
  const logger = (line) => { logs.push(line); if (log) log(line); };
  return {
    file,
    root: ROOT,
    dir: path.dirname(file),
    project,
    logs,
    log: logger,
    python: findPython(path.dirname(file)),
    outputDir: path.resolve(path.dirname(file), project.output || 'output')
  };
}

export const capabilities = [
  {
    id: 'cad.inspect',
    stage: 'source',
    title: 'DXF 图元索引',
    description: '保留图层、块实例路径与源文件指纹，不把线条猜成墙。',
    params: [
      {key: 'dxf', label: 'DXF 文件', type: 'path', required: true, accept: '.dxf'},
      {key: 'out', label: '输出目录', type: 'text', default: 'output/cad'}
    ],
    async run(ctx, {dxf, out = 'output/cad'}) {
      const src = resolveInside(ctx.dir, dxf);
      if (!fs.existsSync(src)) throw new Error(`文件不存在：${dxf}`);
      const outDir = resolveInside(ctx.dir, out);
      const stdout = runProcess(ctx, ctx.python, [path.join(ctx.root, 'src/cad/read.py'), src, '--out', outDir]);
      const summary = JSON.parse(stdout.trim().split('\n').pop());
      return {
        summary: `${summary.entities} 个图元，${summary.issues} 条提示`,
        outputs: [{path: relOf(ctx.dir, path.join(outDir, 'source.json')), kind: 'cad-source'}],
        data: summary
      };
    }
  },
  {
    id: 'cad.preview',
    stage: 'source',
    title: '源图核对',
    description: '按楼层查看索引后的线稿与文字，点击构件查看来源。',
    params: [{key: 'source', label: '索引文件', type: 'output', required: true, accept: '.json'}],
    async run(ctx, {source}) {
      const file = resolveInside(ctx.dir, source);
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.schema !== 'cad-source/v1') throw new Error('需要 cad-source/v1 索引文件');
      return {
        summary: `${data.entities.length} 个图元`,
        outputs: [{path: relOf(ctx.dir, file), kind: 'cad-source'}],
        data: {file: relOf(ctx.dir, file), entities: data.entities.length}
      };
    }
  },
  {
    id: 'model.validate',
    stage: 'data',
    title: '空间数据校验',
    description: '检查标高、引用、多边形与覆盖值，不生成文件。',
    params: [],
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
    stage: 'model',
    title: '生成平面核对 / 白模',
    description: '从空间数据生成离线单文件页面，输出到项目 output/。',
    params: [
      {key: 'viewer', label: '视图', type: 'select', options: ['white-model', 'drawing'], default: 'white-model'}
    ],
    async run(ctx, {viewer = 'white-model'}) {
      const r = await buildProject(ctx.file, {viewer});
      return {
        summary: relOf(ctx.dir, r.file),
        outputs: [{path: relOf(ctx.dir, r.file), kind: 'html'}],
        data: {file: relOf(ctx.dir, r.file), viewer}
      };
    }
  },
  {
    id: 'model.preview',
    stage: 'model',
    title: '外部模型预览',
    description: '预览 Blender / SketchUp 导出的 GLB、GLTF、FBX、OBJ，查看尺度、材质与动画。',
    params: [{key: 'file', label: '模型文件', type: 'path', required: true, accept: '.glb,.gltf,.fbx,.obj'}],
    async run(ctx, {file}) {
      const abs = resolveInside(ctx.dir, file);
      if (!fs.existsSync(abs)) throw new Error(`文件不存在：${file}`);
      const bytes = fs.statSync(abs).size;
      return {
        summary: `${(bytes / 1048576).toFixed(2)} MB`,
        outputs: [{path: relOf(ctx.dir, abs), kind: 'model'}],
        data: {file: relOf(ctx.dir, abs), bytes}
      };
    }
  },
  {
    id: 'model.convert',
    stage: 'model',
    title: 'Blender 转 GLB',
    description: '用本机 Blender 把 .blend 导出为 GLB，供工作台预览或交付。',
    params: [
      {key: 'file', label: '.blend 文件', type: 'path', required: true, accept: '.blend'},
      {key: 'out', label: '输出文件', type: 'text', default: 'output/model/preview.glb'}
    ],
    async run(ctx, {file, out = 'output/model/preview.glb'}) {
      const src = resolveInside(ctx.dir, file);
      if (!fs.existsSync(src)) throw new Error(`文件不存在：${file}`);
      const blender = process.env.BLENDER_PATH || 'blender';
      const target = resolveInside(ctx.dir, out);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      const glbTarget = target.split(path.sep).join('/');
      const expr = `import bpy;bpy.ops.export_scene.gltf(filepath=r'${glbTarget}',export_format='GLB',export_apply=True)`;
      runProcess(ctx, blender, ['--background', src, '--python-expr', expr]);
      if (!fs.existsSync(target)) throw new Error('Blender 未生成 GLB，检查模型是否为空');
      return {
        summary: `${(fs.statSync(target).size / 1048576).toFixed(2)} MB`,
        outputs: [{path: relOf(ctx.dir, target), kind: 'model'}],
        data: {file: relOf(ctx.dir, target)}
      };
    }
  }
];

export function listCapabilities() {
  return capabilities.map(({run, ...meta}) => meta);
}

export function getCapability(id) {
  const cap = capabilities.find(c => c.id === id);
  if (!cap) throw new Error(`未知能力：${id}`);
  return cap;
}

export async function runCapability({project, capability, params = {}, log = () => {}}) {
  const ctx = createContext(project, {log});
  const cap = getCapability(capability);
  const result = await cap.run(ctx, params);
  return {capability: cap.id, title: cap.title, ...result, logs: ctx.logs || []};
}

export function projectOverview(projectFile) {
  const ctx = createContext(projectFile);
  const lint = lintProject(ctx.file);
  const files = [];
  for (const dir of ['source', 'data', 'output', 'docs', 'scripts', 'checks']) {
    const base = path.join(ctx.dir, dir);
    if (!fs.existsSync(base)) continue;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, {withFileTypes: true})) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'history') continue;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) walk(abs);
        else if (files.length < 400) files.push(relOf(ctx.dir, abs));
      }
    };
    walk(base);
  }
  return {file: ctx.file, dir: ctx.dir, project: ctx.project, lint, files};
}
