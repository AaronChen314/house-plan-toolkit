// L3 能力：矢量 PDF / DXF 识别（cadvec）。产物是结构化实体：
//   output/cad/source.json      cad-source/v1，studio 直接展示（墙/门窗/文字/轴线）
//   output/cad/model-draft.json space-model 草稿（墙/门/窗进模型）
//   output/cad/underlay.png     底图（有就带，便于核对）
// 竖向值与门窗尺寸识别不出来，按预览值写进草稿，由数据集假设记录。
import fs from 'node:fs';
import path from 'node:path';
import {fail} from '../contracts/errors.mjs';
import {prepareModel, validateModel} from '../domain/model.mjs';
import {recognitionSummary, toCadSource, toModelDraft} from '../domain/cadvec.mjs';
import {relOf, resolveInside, runProcess} from './context.mjs';

export const capabilities = [
  {
    id: 'cad.vector',
    version: '1.0.0',
    stage: 'source',
    title: '矢量 PDF / DXF 识别',
    description: '读矢量图纸的图元坐标，按国标惯例识别墙、门窗、文字与轴线，输出 cad-source 与模型草稿（识别结果可人工修正）。',
    params: [
      {key: 'file', label: '图纸（PDF 或 DXF）', type: 'path', required: true, accept: '.pdf,.dxf'},
      {key: 'out', label: '输出目录', type: 'text', default: 'output/cad'},
      {key: 'totalWidth', label: '总宽 mm（PDF 无比例时用于定标）', type: 'number'},
      {key: 'ratio', label: '出图比例分母（PDF 已知 1:100 时填 100）', type: 'number'},
      {key: 'scale', label: 'mm/pt（已知时直接给）', type: 'number'},
      {key: 'page', label: 'PDF 页码（从 0 开始）', type: 'number', default: 0}
    ],
    inputs: {file: 'path:pdf'},
    outputs: {source: 'cad-source/v1', model: 'space-model/v1', underlay: 'artifact:image'},
    sideEffects: ['write:artifact'],
    requires: ['python:cadvec'],
    idempotent: true,
    errors: ['E_EXEC_PARAM', 'E_EXEC_DEPENDENCY', 'E_EXEC_PROCESS', 'E_DATA_INVALID', 'E_STORE_PATH', 'E_STORE_IO'],
    async run(ctx, {file, out = 'output/cad', totalWidth, ratio, scale, page = 0} = {}) {
      const src = ctx.store.resolve(file);
      if (!fs.existsSync(src)) throw fail('E_EXEC_PARAM', `文件不存在：${file}`);
      if (!/\.(pdf|dxf)$/i.test(src)) throw fail('E_EXEC_PARAM', '需要 .pdf 或 .dxf（DWG 先跑 cad.convert）');
      const outDir = resolveInside(ctx.dir, out);
      const staging = ctx.store.staging();
      try {
        const args = [path.join(ctx.root, 'src/legacy/scripts/cadvec.py'), src, '--out', staging, '--page', String(page)];
        if (totalWidth !== undefined) args.push('--total-width', String(totalWidth));
        if (ratio !== undefined) args.push('--ratio', String(ratio));
        if (scale !== undefined) args.push('--scale', String(scale));
        const stdout = runProcess(ctx, ctx.python, args);
        const last = stdout.trim().split('\n').pop();
        let info;
        try { info = JSON.parse(last); } catch { throw fail('E_EXEC_PROCESS', `cadvec 输出不是 JSON：${last.slice(0, 200)}`); }
        if (info.error) throw fail('E_EXEC_PARAM', info.error);

        const cadFile = path.join(staging, 'cad.json');
        if (!fs.existsSync(cadFile)) throw fail('E_EXEC_PROCESS', 'cadvec 没有产出 cad.json（可能没识别到墙）');
        const cad = JSON.parse(fs.readFileSync(cadFile, 'utf8'));

        const underlayStaging = path.join(staging, 'underlay.png');
        const underlayRel = fs.existsSync(underlayStaging) ? relOf(ctx.dir, path.join(outDir, 'underlay.png')) : null;
        if (underlayRel) ctx.store.writeArtifact(underlayRel, fs.readFileSync(underlayStaging), {kind: 'image'});

        // 底图比例与原点在 draft.json 的 underlay 里；studio 拿它自动对齐。
        let underlayMeta = null;
        const draftFile = path.join(staging, 'draft.json');
        if (underlayRel && fs.existsSync(draftFile)) {
          try {
            const d = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
            if (d?.underlay?.mmPerPx) {
              underlayMeta = {file: underlayRel, mmPerPx: d.underlay.mmPerPx, origin: [d.underlay.x ?? 0, d.underlay.y ?? 0], rotationDeg: 0};
            }
          } catch {}
        }
        const source = toCadSource(cad, {sourceFile: path.basename(src), underlay: underlayMeta});
        const sourceRel = relOf(ctx.dir, path.join(outDir, 'source.json'));
        const sourceWritten = ctx.store.writeArtifact(sourceRel, source, {kind: 'cad-source'});

        const draft = toModelDraft(cad, {floor: 'ground'});
        if (!draft.projectId) draft.projectId = ctx.project?.id ?? 'draft';
        const prepared = prepareModel(draft);
        const report = validateModel(prepared);
        if (!report.passed) {
          throw fail('E_DATA_INVALID', `识别草稿未通过校验：${report.issues.map(i => i.message).join('；')}`, {issues: report.issues});
        }
        const draftRel = relOf(ctx.dir, path.join(outDir, 'model-draft.json'));
        const draftWritten = ctx.store.writeArtifact(draftRel, prepared, {kind: 'json'});

        return {
          summary: `${recognitionSummary(cad)}（draft: ${draftWritten.path}）`,
          outputs: [
            {path: sourceWritten.path, kind: 'cad-source'},
            {path: draftWritten.path, kind: 'json'},
            ...(underlayRel ? [{path: underlayRel, kind: 'image'}] : [])
          ],
          data: {
            source: sourceWritten.path,
            model: draftWritten.path,
            underlay: underlayRel,
            stats: source.stats,
            mmPerUnit: cad.mmPerUnit ?? null,
            scaleFrom: cad.scale_from ?? null,
            issues: report.issues.filter(i => i.severity === 'warning').length
          }
        };
      } finally {
        fs.rmSync(staging, {recursive: true, force: true});
      }
    }
  }
];
