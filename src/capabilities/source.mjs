// L3 能力：图纸来源。解析走索引层的解析缓存：命中就不启动解析器。
import fs from 'node:fs';
import path from 'node:path';
import {fail} from '../contracts/errors.mjs';
import {loadSource} from '../indexer/build.mjs';
import {pythonParser} from '../indexer/python.mjs';
import {relOf, resolveInside, runProcess} from './context.mjs';

export const capabilities = [
  {
    id: 'cad.raster',
    version: '1.0.0',
    stage: 'source',
    title: '出底图（PDF / 图片 / DXF）',
    description: '把 PDF、图片或 DXF 栅格化成 PNG 底图并给出比例与原点，供 AI 识别（trace brief）或人工描图；只渲染不识别。',
    params: [
      {key: 'source', label: 'PDF / 图片 / DXF', type: 'path', required: true, accept: '.pdf,.png,.jpg,.jpeg,.dxf'},
      {key: 'out', label: '输出目录', type: 'text', default: 'output/cad'},
      {key: 'dpi', label: 'DPI（PDF/图片用）', type: 'number', default: 200},
      {key: 'page', label: '页码（从 0 开始）', type: 'number', default: 0}
    ],
    inputs: {source: 'path:pdf'},
    outputs: {underlay: 'artifact:image'},
    sideEffects: ['write:artifact'],
    requires: ['python:fitz', 'python:ezdxf'],
    idempotent: true,
    errors: ['E_EXEC_PARAM', 'E_EXEC_DEPENDENCY', 'E_EXEC_PROCESS', 'E_STORE_PATH', 'E_STORE_IO'],
    async run(ctx, {source, out = 'output/cad', dpi = 200, page = 0} = {}) {
      const src = resolveInside(ctx.dir, source);
      if (!fs.existsSync(src)) throw fail('E_EXEC_PARAM', `文件不存在：${source}`);
      const outDir = resolveInside(ctx.dir, out);
      const staging = ctx.store.staging();
      try {
        const stdout = runProcess(ctx, ctx.python, [
          path.join(ctx.root, 'src/cad/raster.py'), src, '--out', staging,
          '--dpi', String(dpi), '--page', String(page)
        ]);
        const info = JSON.parse(stdout.trim().split('\n').pop());
        if (info.error) throw fail('E_EXEC_PARAM', info.error);
        if (!fs.existsSync(path.join(staging, 'underlay.png'))) throw fail('E_EXEC_PROCESS', '没有产出 underlay.png');
        const written = ctx.store.writeArtifact(relOf(ctx.dir, path.join(outDir, 'underlay.png')), fs.readFileSync(path.join(staging, 'underlay.png')), {kind: 'image'});
        // 底图元数据：给 AI 任务单（trace brief）用；原点默认 0,0，可在 studio 调整。
        const metaRel = relOf(ctx.dir, path.join(outDir, 'underlay.json'));
        ctx.store.writeArtifact(metaRel, {file: written.path, mmPerPx: info.mmPerPx, origin: info.origin ?? [0, 0], rotationDeg: 0}, {kind: 'json'});
        return {
          summary: `底图已生成：${written.path}（${info.width}×${info.height}，${info.dpi}dpi，1 像素 = ${info.mmPerPx} mm）`,
          outputs: [{path: written.path, kind: 'image'}, {path: metaRel, kind: 'json'}],
          data: {file: written.path, width: info.width, height: info.height, dpi: info.dpi, mmPerPx: info.mmPerPx, page: info.page, pages: info.pages}
        };
      } finally {
        fs.rmSync(staging, {recursive: true, force: true});
      }
    }
  },
  {
    id: 'cad.inspect',
    version: '1.0.0',
    stage: 'source',
    title: 'DXF 图元索引',
    description: '保留图层、块实例路径与源文件指纹，不把线条猜成墙。',
    params: [
      {key: 'dxf', label: 'DXF 文件', type: 'path', required: true, accept: '.dxf'},
      {key: 'out', label: '输出目录', type: 'text', default: 'output/cad'}
    ],
    inputs: {dxf: 'path:dxf'},
    outputs: {index: 'cad-source/v1'},
    sideEffects: ['write:artifact'],
    requires: ['python:cad'],
    idempotent: true,
    errors: ['E_EXEC_PARAM', 'E_EXEC_DEPENDENCY', 'E_EXEC_PROCESS', 'E_STORE_PATH', 'E_STORE_IO'],
    async run(ctx, {dxf, out = 'output/cad'}) {
      const src = resolveInside(ctx.dir, dxf);
      if (!fs.existsSync(src)) throw fail('E_EXEC_PARAM', `文件不存在：${dxf}`);
      const outDir = resolveInside(ctx.dir, out);
      const sourceRel = relOf(ctx.dir, src);

      // 解析缓存命中时完全不启动 Python；未命中才调 read.py。
      const loaded = await loadSource(ctx.store, sourceRel, {
        parse: pythonParser({cwd: ctx.dir, python: ctx.python, root: ctx.root, log: ctx.log})
      });
      const entities = loaded.data.entities || [];
      const issues = loaded.data.issues || [];
      const target = relOf(ctx.dir, path.join(outDir, 'source.json'));
      const written = ctx.store.writeArtifact(target, JSON.stringify(loaded.data, null, 2), {kind: 'cad-source'});

      return {
        summary: `${entities.length} 个图元，${issues.length} 条提示${loaded.cacheHit ? '（命中解析缓存）' : ''}`,
        outputs: [{path: written.path, kind: 'cad-source'}],
        data: {entities: entities.length, issues: issues.length, cacheHit: loaded.cacheHit, parseKey: loaded.parseKey}
      };
    }
  },
  {
    id: 'cad.preview',
    version: '1.0.0',
    stage: 'source',
    title: '源图核对',
    description: '按楼层查看索引后的线稿与文字，点击构件查看来源。',
    params: [{key: 'source', label: '索引文件', type: 'output', required: true, accept: '.json'}],
    inputs: {source: 'cad-source/v1'},
    outputs: {},
    sideEffects: ['none'],
    requires: [],
    idempotent: true,
    errors: ['E_DATA_SCHEMA', 'E_EXEC_PARAM', 'E_STORE_PATH'],
    async run(ctx, {source}) {
      const file = resolveInside(ctx.dir, source);
      const data = ctx.store.readJson(relOf(ctx.dir, file));
      if (data.schema !== 'cad-source/v1') throw fail('E_DATA_SCHEMA', '需要 cad-source/v1 索引文件');
      return {
        summary: `${data.entities.length} 个图元`,
        outputs: [],
        data: {file: relOf(ctx.dir, file), entities: data.entities.length}
      };
    }
  }
];
