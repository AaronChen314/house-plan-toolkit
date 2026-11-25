// L3 能力：施工图与交付清单。
// 一张图的输入固定为「数据集 + 设计版本 + 空间模型」，产物写 output/doc/，记录进交付清单。
// 设计版本变化时先标待复核，重出需要显式 force——不静默覆盖已交付的图。
import {fail} from '../contracts/errors.mjs';
import {datasetFile, designVersionFile} from '../contracts/graph.mjs';
import {validateDataset, validateDesignVersion} from '../contracts/datasets.mjs';
import {
  DOC_KINDS, deliverableFile, deliverable as deliverableRecord, inputChain,
  validateDeliverable, validateSheetSpec
} from '../contracts/documents.mjs';
import {demolitionSpec} from '../domain/demolition.mjs';
import {renderSheet, renderTextSummary, svgLayerIds} from '../domain/sheet.mjs';
import {outOfFrame, projectSheet} from '../domain/sheet-projection.mjs';
import {existingDoc, summarizeManifest, upsertDoc, withStaleness} from '../domain/documents.mjs';
import {putDeliverable, readManifest, writeManifest} from '../store/documents.mjs';
import {sha256 as digest} from '../store/atomic.mjs';

const GENERATOR = {id: 'doc.wall-demolition', version: '1.0.0'};

function assetPath(ctx, id) {
  try { return datasetFile(id); } catch (e) { throw fail('E_EXEC_PARAM', e.message, {id}); }
}

function readValid(ctx, rel, validate, label) {
  if (!ctx.store.exists(rel)) throw fail('E_DATA_REFERENCE', `${label}不存在：${rel}`, {file: rel});
  const value = ctx.store.readJson(rel);
  if (typeof value?.schema !== 'string') throw fail('E_DATA_SCHEMA', `${label}缺少 schema：${rel}`, {file: rel});
  const problems = validate(value);
  if (problems.length) throw fail('E_DATA_INVALID', `${label}不符合契约：${problems.join('；')}`, {file: rel, problems});
  return value;
}

// 施工图的输入链：数据集、设计版本、模型三份文件加用到确认值。
function liveInputs(ctx, {dataset, version, versionRel, modelRel}) {
  const dsRel = assetPath(ctx, version.dataset);
  return inputChain({
    dataset: {id: dataset.id, file: dsRel, sha256: ctx.store.hashOf(dsRel)},
    design: {
      scheme: version.scheme, seq: version.seq, file: versionRel,
      sha256: ctx.store.hashOf(versionRel), status: version.status
    },
    model: {file: modelRel, sha256: ctx.store.hashOf(modelRel)},
    confirmations: dataset.confirmations || [],
    params: {}
  });
}

export const capabilities = [
  {
    id: 'doc.wall-demolition',
    version: '1.0.0',
    stage: 'delivery',
    title: '拆改图',
    description: '从设计版本与数据集生成拆改图：保留、拆除、新建墙体与尺寸，并记录输入版本链。',
    params: [
      {key: 'scheme', label: '方案 id', type: 'text', required: true},
      {key: 'seq', label: '版本号', type: 'number', required: true},
      {key: 'floor', label: '楼层（留空为全部楼层）', type: 'text'},
      {key: 'scale', label: '比例分母', type: 'number'},
      {key: 'title', label: '图名', type: 'text'},
      {key: 'force', label: '输入已变化时仍然重出', type: 'boolean', default: false}
    ],
    inputs: {dataset: 'space-dataset/v1', design: 'space-design-version/v1', model: 'space-model/v1'},
    outputs: {sheet: 'space-sheet/v1', document: 'space-doc/v1', manifest: 'space-doc-manifest/v1'},
    sideEffects: ['write:artifact'],
    requires: [],
    idempotent: true,
    errors: [
      'E_EXEC_PARAM', 'E_DATA_SCHEMA', 'E_DATA_INVALID', 'E_DATA_REFERENCE', 'E_DATA_RULE',
      'E_STORE_PATH', 'E_STORE_IO', 'E_STORE_CONFLICT'
    ],
    async run(ctx, {scheme, seq, floor, scale, title = '拆改图', force = false} = {}) {
      if (!scheme) throw fail('E_EXEC_PARAM', '需要方案 id');
      if (!Number.isInteger(seq) || seq < 1) throw fail('E_EXEC_PARAM', '版本号需为正整数', {seq});

      const versionRel = designVersionFile(scheme, seq);
      const version = readValid(ctx, versionRel, validateDesignVersion, '设计版本');
      if (!version.dataset) throw fail('E_DATA_RULE', `${scheme}#${seq} 没有引用数据集，无法出施工图`);

      const dsRel = assetPath(ctx, version.dataset);
      const dataset = readValid(ctx, dsRel, validateDataset, '数据集');
      const modelRel = dataset.model || `data/datasets/${dataset.id}/model.json`;
      if (!ctx.store.exists(modelRel)) throw fail('E_DATA_REFERENCE', `空间模型不存在：${modelRel}`, {file: modelRel});
      const model = ctx.store.readJson(modelRel);
      if (model?.schema !== 'space-model/v1') throw fail('E_DATA_SCHEMA', `${modelRel} 不是 space-model/v1`);

      const source = demolitionSpec(model, {title, scale, floor, notes: []});
      const spec = projectSheet(source, {scale});
      const sheetProblems = validateSheetSpec(spec);
      if (sheetProblems.length) throw fail('E_DATA_INVALID', `图面数据不合法：${sheetProblems.join('；')}`, {problems: sheetProblems});
      const outside = outOfFrame(spec);
      if (outside.length) throw fail('E_DATA_RULE', `有 ${outside.length} 个图元落在图框外，投影失败`, {outside: outside.slice(0, 5)});

      const file = deliverableFile({kind: 'wall-demolition', scheme, seq});
      const inputs = liveInputs(ctx, {dataset, version, versionRel, modelRel});
      inputs.params = {scale: spec.scale, floor: floor ?? null, title};

      const manifest = readManifest(ctx.store);
      const previous = existingDoc(manifest, {kind: 'wall-demolition', scheme, seq});
      const svg = renderSheet(spec);
      const sha = digest(svg);
      const sameInputs = previous && JSON.stringify(previous.inputs) === JSON.stringify(inputs);

      // 输入变了就拒绝静默重出：先让人看见「这张图过期了」，再决定是否覆盖。
      if (previous && (previous.sha256 !== sha || !sameInputs) && !force) {
        throw fail('E_DATA_RULE',
          `拆改图 ${scheme}#${seq} 的输入或产物已变化（${file}）。先确认再重出：加 force，或把改动做成新版本`,
          {file, previousSha256: previous.sha256, nextSha256: sha});
      }

      const written = putDeliverable(ctx.store, {
        file,
        content: svg,
        record: deliverableRecord({
          kind: 'wall-demolition',
          title,
          file,
          sha256: '0'.repeat(64),
          bytes: 0,
          generator: GENERATOR,
          inputs,
          generatedAt: new Date().toISOString()
        }),
        op: 'doc.wall-demolition'
      });

      if (previous && previous.sha256 === written.sha256 && sameInputs) {
        return {
          summary: `拆改图 ${scheme}#${String(seq).padStart(3, '0')} 未变化（${file}）`,
          outputs: [{path: file, kind: 'drawing'}],
          data: {kind: 'wall-demolition', scheme, seq, file, sha256: written.sha256, unchanged: true, layers: svgLayerIds(spec), scale: spec.scale}
        };
      }

      const record = {...written.record, status: 'generated', staleReason: null};
      const next = upsertDoc(manifest, record, {at: new Date().toISOString()});
      writeManifest(ctx.store, next, {baseHash: ctx.store.hashOf('output/doc/manifest.json'), op: 'doc.manifest'});

      return {
        summary: `${renderTextSummary(spec).split('\n')[0]} · ${scheme}#${String(seq).padStart(3, '0')}（${(written.size / 1024).toFixed(1)}KB）`,
        outputs: [{path: file, kind: 'drawing'}, {path: 'output/doc/manifest.json', kind: 'json'}],
        data: {
          kind: 'wall-demolition',
          scheme,
          seq,
          file,
          sha256: written.sha256,
          bytes: written.size,
          scale: spec.scale,
          layers: svgLayerIds(spec),
          inputs,
          stale: false
        }
      };
    }
  },
  {
    id: 'doc.check',
    version: '1.0.0',
    stage: 'delivery',
    title: '交付清单复核',
    description: '逐条核对交付物：产物是否还在、哈希是否被改、输入（设计版本/数据集/模型/确认值）是否已变化；只标待复核，不重出图。',
    params: [],
    inputs: {manifest: 'space-doc-manifest/v1'},
    outputs: {manifest: 'space-doc-manifest/v1'},
    sideEffects: ['write:artifact'],
    requires: [],
    idempotent: true,
    errors: ['E_DATA_SCHEMA', 'E_DATA_INVALID', 'E_STORE_PATH', 'E_STORE_IO'],
    async run(ctx) {
      const manifest = readManifest(ctx.store);
      const entries = Object.entries(manifest.docs || {});
      if (!entries.length) {
        return {summary: '交付清单为空', outputs: [], data: {checked: 0, stale: 0, missing: 0, docs: []}};
      }

      const docs = [];
      let changed = false;
      for (const [key, record] of entries) {
        const problems = validateDeliverable(record);
        const reasons = [];
        if (problems.length) reasons.push(`记录不合法：${problems.join('；')}`);

        const actual = ctx.store.exists(record.file) ? ctx.store.hashOf(record.file) : null;
        if (actual === null) reasons.push('产物文件缺失');
        else if (actual !== record.sha256) reasons.push('产物哈希与记录不一致（被改动过）');

        const live = {};
        if (record.inputs?.design?.scheme) {
          try {
            const versionRel = designVersionFile(record.inputs.design.scheme, record.inputs.design.seq);
            if (ctx.store.exists(versionRel)) {
              const version = ctx.store.readJson(versionRel);
              live.design = {sha256: ctx.store.hashOf(versionRel), status: version.status};
            } else {
              reasons.push('设计版本文件缺失');
            }
          } catch { reasons.push('设计版本路径不合法'); }
        }
        if (record.inputs?.dataset?.id) {
          try {
            const dsRel = assetPath(ctx, record.inputs.dataset.id);
            if (!ctx.store.exists(dsRel)) reasons.push('数据集文件缺失');
            else {
              const dataset = ctx.store.readJson(dsRel);
              live.dataset = {sha256: ctx.store.hashOf(dsRel)};
              live.confirmations = dataset.confirmations || [];
            }
          } catch { reasons.push('数据集路径不合法'); }
        }
        if (record.inputs?.model?.file && ctx.store.exists(record.inputs.model.file)) {
          live.model = {sha256: ctx.store.hashOf(record.inputs.model.file)};
        }

        const merged = withStaleness(record, live);
        const byInputs = merged.staleReason ? [merged.staleReason] : [];
        const all = [...reasons, ...byInputs];
        const nextRecord = all.length
          ? {...record, status: 'stale', staleReason: all.join('；')}
          : {...record, status: 'generated', staleReason: null};
        if (nextRecord.status !== record.status || nextRecord.staleReason !== record.staleReason) changed = true;
        manifest.docs[key] = nextRecord;
        docs.push({key, kind: nextRecord.kind, file: nextRecord.file, status: nextRecord.status, reasons: all});
      }

      if (changed) {
        writeManifest(ctx.store, {...manifest, updatedAt: new Date().toISOString()}, {baseHash: ctx.store.hashOf('output/doc/manifest.json'), op: 'doc.check'});
      }
      const summary = summarizeManifest(manifest);
      const stale = docs.filter(d => d.status === 'stale');
      return {
        summary: `交付清单：${summary.total} 张，${stale.length ? `${stale.length} 张待复核` : '全部与输入一致'}`,
        outputs: [],
        data: {checked: docs.length, stale: stale.length, missing: docs.filter(d => d.reasons.some(r => r.includes('缺失'))).length, docs}
      };
    }
  },
  {
    id: 'doc.list',
    version: '1.0.0',
    stage: 'delivery',
    title: '图种与交付清单',
    description: '列出已实现 / 待实现的图种，以及当前清单里每张图的状态与输入版本。',
    params: [],
    inputs: {manifest: 'space-doc-manifest/v1'},
    outputs: {},
    sideEffects: ['none'],
    requires: [],
    idempotent: true,
    errors: ['E_STORE_PROJECT', 'E_STORE_PATH'],
    async run(ctx) {
      const manifest = readManifest(ctx.store);
      const summary = summarizeManifest(manifest);
      const docs = Object.entries(manifest.docs || {}).map(([key, record]) => ({
        key,
        kind: record.kind,
        file: record.file,
        status: record.status,
        staleReason: record.staleReason,
        design: record.inputs?.design ? `${record.inputs.design.scheme}#${String(record.inputs.design.seq).padStart(3, '0')}` : null,
        dataset: record.inputs?.dataset?.id ?? null,
        confirmations: (record.inputs?.confirmations || []).length,
        generatedAt: record.generatedAt
      }));
      return {
        summary: `${summary.total} 张交付物${summary.stale ? `（${summary.stale} 张待复核）` : ''}；图种 ${DOC_KINDS.filter(k => k.implemented).length}/${DOC_KINDS.length} 已实现`,
        outputs: [],
        data: {kinds: DOC_KINDS.map(k => ({id: k.id, title: k.title, implemented: k.implemented})), summary, docs}
      };
    }
  }
];

