// L3 能力：确定性彩平图。输入固定为「数据集 + 设计版本 + 空间模型」，产物写 output/render/colorplan/。
// 契约在 src/contracts/rendering.mjs：产物 + 渲染记录（同一目录、同名 .json），记录输入版本链与机位。
// 输入或产物变化时先拒绝静默覆盖，重出需要显式 force——和 doc.wall-demolition 同一套语义。
import {fail} from '../contracts/errors.mjs';
import {datasetFile, designVersionFile} from '../contracts/graph.mjs';
import {validateDataset, validateDesignVersion} from '../contracts/datasets.mjs';
import {inputChain} from '../contracts/documents.mjs';
import {
  normalizeCamera, renderFile, renderRecord, renderRecordFile, validateCamera, validateRender
} from '../contracts/rendering.mjs';
import {COLORMAP_THEMES, buildColorplan, colorplanLayerIds, formatAreaMm2} from '../domain/colorplan.mjs';
import {sha256 as digest} from '../store/atomic.mjs';

const GENERATOR = {id: 'render.colorplan', version: '1.0.0'};

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

// 彩平不用真机位，但渲染记录要求一份合法机位：留空即取契约默认值，传了就照传（对象或 JSON 字符串）。
function readCamera(camera) {
  if (camera === undefined || camera === null || camera === '') return undefined;
  let value = camera;
  if (typeof camera === 'string') {
    try { value = JSON.parse(camera); } catch { throw fail('E_EXEC_PARAM', `机位不是合法 JSON：${camera}`); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('E_EXEC_PARAM', '机位必须是对象');
  const normalized = normalizeCamera(value);
  const problems = validateCamera(normalized);
  if (problems.length) throw fail('E_EXEC_PARAM', `机位不合法：${problems.join('；')}`, {problems});
  return normalized;
}

// 设计版本的输入链：数据集、设计版本、模型三份文件加用到确认值。
// 彩平与施工图共用同一个形状（contracts/documents.mjs 的 inputChain），便于对照追溯。
function liveInputs(ctx, {dataset, version, versionRel, modelRel, params}) {
  const dsRel = assetPath(ctx, version.dataset);
  return inputChain({
    dataset: {id: dataset.id, file: dsRel, sha256: ctx.store.hashOf(dsRel)},
    design: {
      scheme: version.scheme, seq: version.seq, file: versionRel,
      sha256: ctx.store.hashOf(versionRel), status: version.status
    },
    model: {file: modelRel, sha256: ctx.store.hashOf(modelRel)},
    confirmations: dataset.confirmations || [],
    params
  });
}

export const capabilities = [
  {
    id: 'render.colorplan',
    version: '1.0.0',
    stage: 'delivery',
    title: '彩平图',
    description: '从设计版本与数据集生成确定性彩平：地面填充、墙体、门窗、家具、楼层名与面积、图例，不画尺寸；同时记录输入版本链与机位。',
    params: [
      {key: 'scheme', label: '方案 id', type: 'text', required: true},
      {key: 'seq', label: '版本号', type: 'number', required: true},
      {key: 'floor', label: '楼层（留空取模型第一层）', type: 'text'},
      {key: 'scale', label: '比例分母', type: 'number', default: 100},
      {key: 'title', label: '图名（留空按楼层名生成）', type: 'text'},
      {key: 'theme', label: '配色', type: 'select', options: Object.keys(COLORMAP_THEMES), default: 'plan'},
      {key: 'camera', label: '机位（JSON，彩平可留空）', type: 'text'},
      {key: 'force', label: '输入或产物已变化时仍然重出', type: 'boolean', default: false}
    ],
    inputs: {dataset: 'space-dataset/v1', design: 'space-design-version/v1', model: 'space-model/v1'},
    outputs: {render: 'artifact:svg', record: 'artifact:json'},
    sideEffects: ['write:artifact'],
    requires: [],
    idempotent: true,
    errors: [
      'E_EXEC_PARAM', 'E_DATA_SCHEMA', 'E_DATA_INVALID', 'E_DATA_REFERENCE', 'E_DATA_RULE',
      'E_STORE_PATH', 'E_STORE_IO', 'E_STORE_CONFLICT'
    ],
    async run(ctx, {scheme, seq, floor, scale = 100, title, theme = 'plan', camera, force = false} = {}) {
      if (!scheme) throw fail('E_EXEC_PARAM', '需要方案 id');
      if (!Number.isInteger(seq) || seq < 1) throw fail('E_EXEC_PARAM', '版本号需为正整数', {seq});
      const scaleNum = Number(scale);
      if (!Number.isFinite(scaleNum) || scaleNum <= 0) throw fail('E_EXEC_PARAM', `比例必须是正数：${scale}`, {scale});
      if (typeof theme === 'string' && theme && !COLORMAP_THEMES[theme]) {
        throw fail('E_EXEC_PARAM', `未知彩平配色：${theme}`, {theme, options: Object.keys(COLORMAP_THEMES)});
      }
      const cameraIn = readCamera(camera);

      let file;
      let recordRel;
      try {
        file = renderFile({kind: 'colorplan', scheme, seq});
        recordRel = renderRecordFile({kind: 'colorplan', scheme, seq});
      } catch (e) {
        throw fail('E_EXEC_PARAM', e.message, {scheme, seq});
      }

      const versionRel = designVersionFile(scheme, seq);
      const version = readValid(ctx, versionRel, validateDesignVersion, '设计版本');
      if (!version.dataset) throw fail('E_DATA_RULE', `${scheme}#${seq} 没有引用数据集，无法出彩平图`);

      const dsRel = assetPath(ctx, version.dataset);
      const dataset = readValid(ctx, dsRel, validateDataset, '数据集');
      const modelRel = dataset.model || `data/datasets/${dataset.id}/model.json`;
      if (!ctx.store.exists(modelRel)) throw fail('E_DATA_REFERENCE', `空间模型不存在：${modelRel}`, {file: modelRel});
      const model = ctx.store.readJson(modelRel);
      if (model?.schema !== 'space-model/v1') throw fail('E_DATA_SCHEMA', `${modelRel} 不是 space-model/v1`);

      let built;
      try {
        built = buildColorplan(model, {floor, scale: scaleNum, title, theme});
      } catch (e) {
        throw fail('E_EXEC_PARAM', e.message, {floor, scale: scaleNum});
      }
      const svg = built.svg;
      const sha = digest(svg);

      const inputs = liveInputs(ctx, {
        dataset,
        version,
        versionRel,
        modelRel,
        params: {
          floor: built.stats.floor,
          scale: built.stats.scale,
          title: built.stats.title,
          theme: built.stats.theme
        }
      });

      // 已有记录的渲染结果：先读、先校验，坏记录同样不能静默覆盖。
      let previous = null;
      if (ctx.store.exists(recordRel)) {
        let raw = null;
        let problems = [];
        try { raw = ctx.store.readJson(recordRel); } catch (e) { problems = [`不是合法 JSON：${e.message}`]; }
        if (!problems.length) problems = validateRender(raw);
        if (problems.length) {
          if (!force) {
            throw fail('E_DATA_INVALID',
              `渲染记录不合法（${recordRel}）：${problems.join('；')}。确认后用 force 重出`,
              {file: recordRel, problems});
          }
        } else {
          previous = raw;
        }
      }

      const sameInputs = previous ? JSON.stringify(previous.inputs) === JSON.stringify(inputs) : false;
      // 内容相同且产物还在：一个字节都不动，直接报告「未变化」。
      if (previous && previous.sha256 === sha && sameInputs && ctx.store.exists(file) && ctx.store.hashOf(file) === sha) {
        const padded = String(seq).padStart(3, '0');
        return {
          summary: `彩平图 ${scheme}#${padded} 未变化（${file}）`,
          outputs: [{path: file, kind: 'render'}, {path: recordRel, kind: 'json'}],
          data: {
            kind: 'colorplan', scheme, seq, floor: built.stats.floor, file, recordFile: recordRel,
            sha256: previous.sha256, recordSha256: ctx.store.hashOf(recordRel),
            bytes: previous.bytes, unchanged: true,
            camera: previous.camera, layers: colorplanLayerIds(),
            areaM2: built.stats.areaM2, scale: built.stats.scale, theme: built.stats.theme,
            inputs, stats: built.stats
          }
        };
      }

      // 输入变了或产物会变就拒绝静默重出：彩平是派生物，但已经交出去的那张图不能悄悄换内容。
      // 先让人看见差异（或跑 store/doc 复核），再决定 force 覆盖，还是把改动做成新设计版本。
      if (previous && (previous.sha256 !== sha || !sameInputs) && !force) {
        throw fail('E_DATA_RULE',
          `彩平图 ${scheme}#${seq} 的输入或产物已变化（${file}）。先确认再重出：加 force，或把改动做成新版本`,
          {file, previousSha256: previous.sha256, nextSha256: sha, inputsChanged: !sameInputs});
      }

      const written = ctx.store.writeArtifact(file, svg, {kind: 'image', op: 'render.colorplan'});
      const record = renderRecord({
        kind: 'colorplan',
        file,
        sha256: written.sha256,
        bytes: written.size,
        camera: cameraIn,
        inputs,
        deterministic: true
      });
      const problems = validateRender(record);
      if (problems.length) throw fail('E_DATA_INVALID', `渲染记录不合法：${problems.join('；')}`, {problems});
      const recordWritten = ctx.store.writeArtifact(recordRel, JSON.stringify(record, null, 2) + '\n', {
        kind: 'json', op: 'render.colorplan.record'
      });

      const padded = String(seq).padStart(3, '0');
      const used = built.layers.filter(layer => layer.count > 0);
      return {
        summary: `彩平图 · ${scheme}#${padded}（${formatAreaMm2(built.stats.areaMm2)}，${used.length} 个图层 · ${(written.size / 1024).toFixed(1)}KB）`,
        outputs: [{path: file, kind: 'render'}, {path: recordRel, kind: 'json'}],
        data: {
          kind: 'colorplan',
          scheme,
          seq,
          floor: built.stats.floor,
          file,
          recordFile: recordRel,
          sha256: written.sha256,
          recordSha256: recordWritten.sha256,
          bytes: written.size,
          unchanged: false,
          camera: record.camera,
          generator: GENERATOR,
          layers: colorplanLayerIds(),
          usedLayers: used.map(layer => layer.id),
          areaM2: built.stats.areaM2,
          scale: built.stats.scale,
          theme: built.stats.theme,
          inputs,
          stats: built.stats
        }
      };
    }
  }
];
