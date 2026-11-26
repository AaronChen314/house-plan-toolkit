// L3 能力：数据集。构建会写权威数据（data/），差异与校正只读。
// 写入只经 ctx.store.writeData；校正绝不改文件，只给出差异与建议复核清单。
import {fail} from '../contracts/errors.mjs';
import {datasetFile, designVersionFile} from '../contracts/graph.mjs';
import {DATASET_SCHEMA, DESIGN_SCHEMA, emptyDataset, validateDataset} from '../contracts/datasets.mjs';
import {diffRecords, matchesChanged} from '../domain/datasets.mjs';
import {mergeTrace, traceSummary} from '../domain/tracing.mjs';
import {traceItem, traceRecord, traceSpec, validateTraceSpec} from '../contracts/tracing.mjs';
import {impactOf} from '../domain/graph.mjs';
import {prepareModel, validateModel} from '../domain/model.mjs';

// 源图只有平面信息；竖向值一律按预览依据记录，等人确认。
const PREVIEW_VERTICALS = [
  {field: 'elevation', value: 0},
  {field: 'clearHeight', value: 3000},
  {field: 'wallHeight', value: 2800},
  {field: 'slabThickness', value: 150}
];

function datasetPath(id) {
  try {
    return datasetFile(id);
  } catch (e) {
    throw fail('E_EXEC_PARAM', e.message, {id});
  }
}

// 模型位置紧挨数据集文件：目录只由 datasetFile 给出，不另拼一套规则。
function modelPath(id) {
  return datasetPath(id).replace(/\/dataset\.json$/, '/model.json');
}

function readDataset(ctx, id) {
  const rel = datasetPath(id);
  if (!ctx.store.exists(rel)) throw fail('E_DATA_REFERENCE', `数据集不存在：${id}`, {id, file: rel});
  let data;
  try {
    data = ctx.store.readJson(rel);
  } catch (e) {
    throw fail('E_DATA_SCHEMA', `数据集文件无法解析：${rel}（${e.message}）`, {id, file: rel});
  }
  if (data?.schema !== 'space-dataset/v1') {
    throw fail('E_DATA_SCHEMA', `需要 space-dataset/v1，读到 ${data?.schema}：${rel}`, {id, file: rel});
  }
  return data;
}

function readSource(ctx, source) {
  if (typeof source !== 'string' || !source.trim()) throw fail('E_EXEC_PARAM', '需要 source（cad-source/v1 索引文件）');
  if (!ctx.store.exists(source)) throw fail('E_EXEC_PARAM', `文件不存在：${source}`, {source});
  let data;
  try {
    data = ctx.store.readJson(source);
  } catch (e) {
    throw fail('E_DATA_SCHEMA', `索引文件无法解析：${source}（${e.message}）`, {source});
  }
  if (data?.schema !== 'cad-source/v1') {
    throw fail('E_DATA_SCHEMA', `需要 cad-source/v1 索引文件，读到 ${data?.schema}`, {source});
  }
  return data;
}

function numbersOf(point) {
  return Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every(Number.isFinite);
}

// 包围盒：显式 minx/miny/maxx/maxy 优先，其次点集、at、footprint、bounds。
function boxOf(item) {
  if (!item || typeof item !== 'object') return null;
  if (['minx', 'miny', 'maxx', 'maxy'].every(k => Number.isFinite(item[k]))) {
    return [item.minx, item.miny, item.maxx, item.maxy];
  }
  const points = [];
  if (Array.isArray(item.points)) points.push(...item.points.filter(numbersOf));
  if (numbersOf(item.at)) points.push(item.at.slice(0, 2));
  for (const poly of item.footprint || []) {
    for (const p of poly?.outer || []) if (numbersOf(p)) points.push(p);
  }
  if (!points.length && Array.isArray(item.bounds) && item.bounds.length === 4 && item.bounds.every(Number.isFinite)) {
    return [...item.bounds];
  }
  if (!points.length) return null;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of points) {
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
  }
  return [minx, miny, maxx, maxy];
}

function entityOf(item, fallbackHandle) {
  const handle = item?.handle ?? item?.source?.handle ?? item?.sourceHandle ?? fallbackHandle;
  if (handle === undefined || handle === null || String(handle) === '') return null;
  return {
    handle: String(handle),
    type: item?.type ?? item?.source?.type ?? null,
    layer: item?.layer ?? item?.source?.layer ?? null,
    box: boxOf(item)
  };
}

// cad-source 是比对的事实源：每个有 handle 的图元都参与。
function entitiesOfSource(data) {
  const entities = new Map();
  for (const [i, item] of (data?.entities || []).entries()) {
    const entity = entityOf(item, `#${i}`);
    if (entity) entities.set(entity.handle, entity);
  }
  return entities;
}

// 模型草稿的图元：优先 trace，兼容已有手工模型里的 sourceHandles。
function entitiesOfModel(model) {
  const entities = new Map();
  for (const floor of model?.floors || []) {
    for (const item of floor.trace || []) {
      const entity = entityOf(item);
      if (entity) entities.set(entity.handle, entity);
    }
    for (const key of ['walls', 'columns', 'slab', 'furniture', 'doors', 'windowOpenings', 'treads']) {
      for (const item of floor[key] || []) {
        const handles = item?.sourceHandles?.length ? item.sourceHandles : (item?.id ? [item.id] : []);
        for (const handle of handles) {
          const entity = entityOf({...item, handle});
          if (entity) entities.set(entity.handle, entity);
        }
      }
    }
  }
  return entities;
}

function sameBox(a, b) {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function compareEntities(left, right) {
  const added = [...right.keys()].filter(k => !left.has(k)).sort();
  const removed = [...left.keys()].filter(k => !right.has(k)).sort();
  const changed = [...left.keys()]
    .filter(k => right.has(k) && !sameBox(left.get(k).box, right.get(k).box))
    .sort();
  const changes = changed.map(handle => ({handle, from: left.get(handle).box, to: right.get(handle).box}));
  return {added, removed, changed, changes};
}

function readModel(ctx, id, dataset) {
  const rel = dataset?.model || modelPath(id);
  if (!ctx.store.exists(rel)) return {present: false, model: null, file: rel};
  try {
    const model = ctx.store.readJson(rel);
    if (model?.schema !== 'space-model/v1') return {present: false, model: null, file: rel, reason: `不是 space-model/v1：${model?.schema}`};
    return {present: true, model, file: rel};
  } catch (e) {
    return {present: false, model: null, file: rel, reason: `无法解析：${e.message}`};
  }
}

// 确认值：能当数字就当数字，否则保留文本（例如「承重」「非承重」）。
function coerceAnnotationValue(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : text;
}

// 确认记录的 object 可能是楼层 id、图元 handle，或「楼层:类别:序号」。
function objectExists(model, key) {
  const floors = model.floors || [];
  const all = new Set();
  for (const f of floors) {
    all.add(f.id);
    for (const t of f.trace || []) {
      const id = t.handle ?? t.id ?? null;
      if (!id) continue;
      all.add(id);
      all.add(`${f.id}:${id}`);
    }
  }
  if (all.has(key)) return true;
  return String(key).split(':').some(part => all.has(part));
}

function previewAssumptions(id) {
  return PREVIEW_VERTICALS.map(v => ({
    object: id === 'ground' ? 'ground' : id,
    field: v.field,
    value: v.value,
    basis: 'preview',
    note: '源索引只有平面图元，竖向值按预览推算，待人工确认'
  }));
}

function traceOf(entities) {
  const trace = [];
  for (const [i, item] of (entities || []).entries()) {
    const handle = item?.handle ?? item?.id ?? `#${i}`;
    const base = {handle: String(handle), type: item?.type ?? null, layer: item?.layer ?? null};
    const source = {handle: String(handle), type: item?.type ?? null, layer: item?.layer ?? null};
    if (Array.isArray(item?.points) && item.points.length > 1) {
      trace.push({...base, kind: 'line', points: item.points, source});
      continue;
    }
    const at = numbersOf(item?.at) ? item.at.slice(0, 2)
      : (item?.points?.length === 1 && numbersOf(item.points[0]) ? item.points[0].slice(0, 2) : null);
    if (item?.text && at) {
      trace.push({...base, kind: 'text', text: item.text, at, source});
      continue;
    }
    if (Array.isArray(item?.points) && item.points.length) {
      trace.push({...base, kind: 'point', points: item.points, source});
    }
  }
  return trace;
}

function draftModel({projectId, name, id, source}) {
  const floor = {
    id: 'ground',
    name: '首层（草稿）',
    ...Object.fromEntries(PREVIEW_VERTICALS.map(v => [v.field, v.value])),
    slab: [],
    walls: [],
    columns: [],
    doors: [],
    windowOpenings: [],
    furniture: [],
    trace: traceOf(source.entities)
  };
  const model = prepareModel({
    schema: 'space-model/v1',
    units: 'mm',
    projectId,
    name,
    defaults: {slab: 150},
    floors: [floor],
    notes: [`由 ${source.file || '源索引'} 生成的数据集草稿；竖向值 basis=preview，待确认。`]
  });
  const report = validateModel(model);
  if (!report.passed) {
    throw fail('E_DATA_INVALID', `生成的模型草稿未通过校验：${report.issues.map(i => i.message).join('；')}`, {issues: report.issues});
  }
  return model;
}

function countMarks({added, removed, changed}) {
  return `+${added.length} -${removed.length} ~${changed.length}`;
}

// 复核清单分两层：
// 1) 权威文件层——哪个设计版本声明用到了变化构件（uses 与 handle 求交），不依赖索引；
// 2) 图投影层——下游产物（三维/彩平/施工图）只能由图给出，索引不可用时显式降级。
function scanDesigns(ctx) {
  const designs = [];
  for (const rel of Object.keys(ctx.store.files().files)) {
    const match = /^data\/designs\/([^/]+)\/design\.json$/.exec(rel);
    if (!match) continue;
    let design;
    try { design = ctx.store.readJson(rel); } catch { continue; }
    if (design?.schema !== DESIGN_SCHEMA) continue;
    const versions = [];
    for (const entry of design.versions || []) {
      const versionRel = designVersionFile(match[1], entry.seq);
      if (!ctx.store.exists(versionRel)) continue;
      try { versions.push(ctx.store.readJson(versionRel)); } catch {}
    }
    versions.sort((a, b) => a.seq - b.seq);
    designs.push({scheme: match[1], dataset: design.dataset, versions});
  }
  return designs;
}

async function reviewSuggestions(ctx, datasetId, {changedHandles = []} = {}) {
  const changed = [...new Set(changedHandles.filter(Boolean))].sort();
  const designs = scanDesigns(ctx).filter(d => d.dataset === datasetId);
  const suggested = [], untouched = [];
  for (const design of designs) {
    const current = design.versions.at(-1);
    if (!current) continue;
    const match = matchesChanged(current.uses, changed);
    const item = {
      id: design.scheme,
      seq: current.seq,
      status: current.status,
      matched: match.matched,
      reason: match.reason
    };
    if (match.affected) suggested.push(item); else untouched.push(item);
  }

  let downstream = {available: false, reason: '索引尚未建立：space index rebuild', affected: []};
  if (ctx.store.derived('index').exists()) {
    try {
      const {readGraph} = await import('../store/graph.mjs');
      const graph = await readGraph(ctx.store);
      const roots = [datasetId, ...suggested.map(item => item.id)];
      const impact = impactOf({changed: roots, edges: graph.edges || []});
      const byId = new Map((graph.nodes || []).map(n => [n.id, n]));
      downstream = {
        available: true,
        affected: impact.affected
          .filter(item => ['model', 'render', 'document', 'bundle'].includes(byId.get(item.id)?.kind))
          .map(item => ({id: item.id, kind: byId.get(item.id).kind, status: byId.get(item.id).status ?? null, depth: item.depth}))
      };
    } catch (e) {
      downstream = {available: false, reason: `读取推导图失败：${e.message}`, affected: []};
    }
  }

  return {available: true, basis: 'design-version-uses', changedHandles: changed, suggested, untouched, downstream};
}

export const capabilities = [
  {
    id: 'dataset.build',
    version: '1.0.0',
    stage: 'data',
    title: '建立数据集',
    description: '从 cad-source 索引生成空间模型草稿，竖向推算值按预览依据登记到数据集。',
    params: [
      {key: 'source', label: 'cad-source 索引文件', type: 'output', required: true},
      {key: 'id', label: '数据集 id', type: 'text', required: true},
      {key: 'confirm', label: '确认写入权威数据', type: 'boolean', default: false},
      {key: 'model', label: '模型草稿（识别结果，可选）', type: 'text'}
    ],
    inputs: {source: 'cad-source/v1'},
    outputs: {dataset: 'space-dataset/v1', model: 'space-model/v1'},
    sideEffects: ['write:data'],
    requires: [],
    idempotent: true,
    errors: ['E_DATA_CONFIRM_REQUIRED', 'E_DATA_INVALID', 'E_DATA_REFERENCE', 'E_DATA_SCHEMA', 'E_EXEC_PARAM', 'E_STORE_CONFLICT', 'E_STORE_IO', 'E_STORE_PATH'],
    async run(ctx, {source, id, confirm = false, model: modelDraftRel} = {}) {
      if (confirm !== true) {
        throw fail('E_DATA_CONFIRM_REQUIRED', '建立数据集会写 data/ 权威数据，需要 confirm: true', {id, source});
      }
      if (typeof id !== 'string' || !id.trim()) throw fail('E_EXEC_PARAM', '需要数据集 id');
      const sourceData = readSource(ctx, source);
      const sourceRel = ctx.store.rel(ctx.store.resolve(source));
      const sourceSha256 = ctx.store.hashOf(sourceRel);
      const dsRel = datasetPath(id);
      const modelRel = modelPath(id);

      // 重建既有数据集时，确认与校正记录必须保留——它们是人在图纸上做过的判断，
      // 不能被一次重新解析抹掉。来源变化时只把状态降为待复核，不静默覆盖。
      const previous = ctx.store.exists(dsRel) ? ctx.store.readJson(dsRel) : null;
      const createdAt = previous?.createdAt || new Date().toISOString();
      const previousSha = previous?.sources?.[0]?.sha256 ?? null;
      const sourceChanged = !!previous && previousSha !== sourceSha256;

      const projectId = ctx.project?.id || id;
      const name = `${ctx.project?.name || id} · ${id} 草稿`;
      // 有结构化草稿（AI 产出或人工编写）就用它，否则生成只含 trace 的空墙草稿。
      let model;
      if (modelDraftRel) {
        const rel = ctx.store.rel(ctx.store.resolve(modelDraftRel));
        if (!ctx.store.exists(rel)) throw fail('E_DATA_REFERENCE', `模型草稿不存在：${modelDraftRel}`, {file: rel});
        const draft = ctx.store.readJson(rel);
        if (draft?.schema !== 'space-model/v1') throw fail('E_DATA_SCHEMA', `${rel} 不是 space-model/v1`);
        model = prepareModel({...draft, projectId: draft.projectId || projectId, name});
      } else {
        model = draftModel({projectId, name, id, source: sourceData});
      }
      const dataset = emptyDataset({
        id,
        model: modelRel,
        sources: [{file: sourceRel, sha256: sourceSha256, note: sourceData.source?.file || null}],
        at: createdAt
      });
      dataset.assumptions = previewAssumptions('ground');
      if (modelDraftRel) {
        // 识别草稿的竖向值覆盖同名假设，而不是并列（否则确认清单会出现两行 wallHeight）。
        const extra = {object: 'ground', field: 'wallHeight', value: model.floors[0].wallHeight ?? 2800, basis: 'preview', note: '来自识别草稿的竖向值，需人工确认'};
        const key = (a) => `${a.object}::${a.field}`;
        dataset.assumptions = [...dataset.assumptions.filter(a => key(a) !== key(extra)), extra];
      }
      if (previous) {
        dataset.corrections = previous.corrections || [];
        dataset.confirmations = previous.confirmations || [];
        dataset.status = sourceChanged && previous.status === 'confirmed' ? 'stale' : (previous.status || 'draft');
        if (previous.status === 'superseded') dataset.status = 'superseded';
      }
      const problems = validateDataset(dataset);
      if (problems.length) throw fail('E_DATA_INVALID', problems.join('；'), {id, problems});

      // 确认值指向的构件可能在新模型里消失：保留记录，但要让人看见。
      const orphaned = dataset.confirmations.filter(c => c.object && !objectExists(model, c.object)).length;

      ctx.store.writeData(modelRel, model, {baseHash: ctx.store.hashOf(modelRel), confirm: true});
      ctx.store.writeData(dsRel, dataset, {baseHash: ctx.store.hashOf(dsRel), confirm: true});

      const notices = [];
      if (sourceChanged && dataset.status === 'stale') notices.push('来源已变化，状态标待复核');
      if (orphaned) notices.push(`${orphaned} 条确认在新模型中找不到对应构件（已保留，待人工复核）`);
      if (dataset.confirmations.length) notices.push(`保留 ${dataset.confirmations.length} 条确认记录`);

      return {
        summary: `${id}：${model.floors[0].trace.length} 条 trace，${dataset.assumptions.length} 条预览假设${notices.length ? '；' + notices.join('；') : ''}`,
        outputs: [
          {path: dsRel, kind: 'data'},
          {path: modelRel, kind: 'data'}
        ],
        data: {
          id,
          dataset: dsRel,
          model: modelRel,
          source: sourceRel,
          sourceSha256,
          traces: model.floors[0].trace.length,
          assumptions: dataset.assumptions.length,
          status: dataset.status,
          sourceChanged,
          confirmations: dataset.confirmations.length,
          orphanedConfirmations: orphaned
        }
      };
    }
  },
  {
    id: 'dataset.diff',
    version: '1.0.0',
    stage: 'data',
    title: '比较数据集',
    description: '比较两份数据集的来源、假设与确认记录，并在都有模型时按 handle 比较图元包围盒。',
    params: [
      {key: 'a', label: '数据集 A', type: 'text', required: true},
      {key: 'b', label: '数据集 B', type: 'text', required: true}
    ],
    inputs: {a: 'space-dataset/v1', b: 'space-dataset/v1'},
    outputs: {},
    sideEffects: ['none'],
    requires: [],
    idempotent: true,
    errors: ['E_DATA_REFERENCE', 'E_DATA_SCHEMA', 'E_EXEC_PARAM'],
    async run(ctx, {a, b} = {}) {
      if (!a || !b) throw fail('E_EXEC_PARAM', '需要两个数据集 id：a 与 b');
      const left = readDataset(ctx, a);
      const right = readDataset(ctx, b);
      const records = diffRecords(left, right);

      const leftModel = readModel(ctx, a, left);
      const rightModel = readModel(ctx, b, right);
      const compared = leftModel.present && rightModel.present;
      const entities = compared
        ? compareEntities(entitiesOfModel(leftModel.model), entitiesOfModel(rightModel.model))
        : {added: [], removed: [], changed: [], changes: []};

      const reasons = [];
      if (!leftModel.present) reasons.push(`${a}：${leftModel.reason || `缺少 ${leftModel.file}`}`);
      if (!rightModel.present) reasons.push(`${b}：${rightModel.reason || `缺少 ${rightModel.file}`}`);

      return {
        summary: `${a} → ${b}：来源 ${countMarks(records.sources)}，假设 ${countMarks(records.assumptions)}，确认 ${countMarks(records.confirmations)}，图元 ${countMarks(entities)}`,
        outputs: [],
        data: {
          a,
          b,
          records,
          entities,
          changes: entities.changes,
          models: {a: leftModel.file, b: rightModel.file, compared, reasons}
        }
      };
    }
  },
  {
    id: 'dataset.correct',
    version: '1.0.0',
    stage: 'data',
    title: '校正比对',
    description: '把新的 cad-source 与数据集现有图元按 handle 比对，并给出建议复核的设计清单；不修改任何文件。',
    params: [
      {key: 'dataset', label: '数据集 id', type: 'text', required: true},
      {key: 'source', label: '新的 cad-source 索引文件', type: 'output', required: true}
    ],
    inputs: {dataset: 'space-dataset/v1', source: 'cad-source/v1'},
    outputs: {},
    sideEffects: ['none'],
    requires: [],
    idempotent: true,
    errors: ['E_DATA_REFERENCE', 'E_DATA_SCHEMA', 'E_EXEC_PARAM'],
    async run(ctx, {dataset, source} = {}) {
      if (!dataset) throw fail('E_EXEC_PARAM', '需要数据集 id');
      const record = readDataset(ctx, dataset);
      const sourceData = readSource(ctx, source);
      const existing = readModel(ctx, dataset, record);
      if (!existing.present) {
        throw fail('E_DATA_REFERENCE', `数据集 ${dataset} 缺少可比较的模型：${existing.file}`, {dataset, file: existing.file, reason: existing.reason || null});
      }

      const entities = compareEntities(entitiesOfModel(existing.model), entitiesOfSource(sourceData));
      const changedHandles = [...entities.added, ...entities.removed, ...entities.changed];
      const review = await reviewSuggestions(ctx, dataset, {changedHandles});
      const reviewText = review.available
        ? (review.suggested.length ? `建议复核 ${review.suggested.length} 个设计` : '无需复核的设计')
        : `复核清单未给出（${review.reason}）`;

      return {
        summary: `校正比对 ${dataset}：图元 ${countMarks(entities)}；${reviewText}`,
        outputs: [],
        data: {
          dataset,
          source,
          model: existing.file,
          entities,
          changes: entities.changes,
          review
        }
      };
    }
  },
  {
    id: 'annotation.confirm',
    version: '1.0.0',
    stage: 'data',
    title: '逐项确认',
    description: '记录一条人工确认：对象、字段、取值（或判为无效）、依据与时间。一次只确认一项，不提供批量静默通过。',
    params: [
      {key: 'dataset', label: '数据集 id', type: 'text', required: true},
      {key: 'object', label: '对象（楼层 id / handle / 楼层:类别:序号）', type: 'text', required: true},
      {key: 'field', label: '字段', type: 'text', required: true},
      {key: 'value', label: '确认值', type: 'text'},
      {key: 'invalid', label: '判为无效', type: 'boolean', default: false},
      {key: 'basis', label: '依据（图纸位置、说明或测量）', type: 'text', required: true},
      {key: 'actor', label: '确认人', type: 'text'}
    ],
    inputs: {dataset: 'space-dataset/v1'},
    outputs: {dataset: 'space-dataset/v1'},
    sideEffects: ['write:data'],
    requires: [],
    idempotent: true,
    errors: [
      'E_EXEC_PARAM', 'E_DATA_SCHEMA', 'E_DATA_INVALID', 'E_DATA_REFERENCE', 'E_DATA_CONFIRM_REQUIRED',
      'E_STORE_CONFLICT', 'E_STORE_LOCK_REQUIRED', 'E_STORE_PATH', 'E_STORE_IO'
    ],
    async run(ctx, {dataset, object, field, value, invalid = false, basis, actor = 'cli'} = {}) {
      if (!dataset) throw fail('E_EXEC_PARAM', '需要数据集 id');
      if (typeof object !== 'string' || !object.trim()) throw fail('E_EXEC_PARAM', '需要确认对象');
      if (typeof field !== 'string' || !field.trim()) throw fail('E_EXEC_PARAM', '需要确认字段');
      // 逐项带依据：这条是「不提供批量静默确认」的硬闸门。
      if (typeof basis !== 'string' || !basis.trim()) throw fail('E_EXEC_PARAM', '确认必须写依据（basis）');

      const dsRel = datasetPath(dataset);
      if (!ctx.store.exists(dsRel)) throw fail('E_DATA_REFERENCE', `数据集不存在：${dataset}`, {dataset, file: dsRel});
      const baseHash = ctx.store.hashOf(dsRel);
      const record = ctx.store.readJson(dsRel);
      if (record?.schema !== DATASET_SCHEMA) throw fail('E_DATA_SCHEMA', `${dsRel} 不是 ${DATASET_SCHEMA}`);
      const problems = validateDataset(record);
      if (problems.length) throw fail('E_DATA_INVALID', problems.join('；'), {dataset, problems});

      const model = readModel(ctx, dataset, record);
      if (!invalid && model.present && !objectExists(model.model, object)) {
        throw fail('E_DATA_REFERENCE', `模型里没有 ${object}；若该构件不存在，请用 invalid: true 判为无效`, {object});
      }
      const parsed = invalid ? undefined : coerceAnnotationValue(value);
      if (!invalid && parsed === undefined) throw fail('E_EXEC_PARAM', '需要 value，或显式判为无效（invalid: true）');

      const previous = (record.confirmations || []).find(c => c.object === object && c.field === field);
      const unchanged = previous
        && (previous.invalid === true) === (invalid === true)
        && (invalid || JSON.stringify(previous.value) === JSON.stringify(parsed))
        && previous.basis === basis.trim();
      if (unchanged) {
        return {
          summary: `${object}.${field} 已确认，内容未变`,
          outputs: [],
          data: {dataset, object, field, unchanged: true, total: record.confirmations.length}
        };
      }

      const entry = {
        object,
        field,
        ...(invalid ? {invalid: true} : {value: parsed}),
        at: new Date().toISOString(),
        actor: actor || 'cli',
        basis: basis.trim()
      };
      if (previous) {
        entry.previous = [...(previous.previous || []), {
          value: previous.value, invalid: previous.invalid, at: previous.at, actor: previous.actor, basis: previous.basis
        }];
      }
      const updated = {
        ...record,
        confirmations: [...(record.confirmations || []).filter(c => !(c.object === object && c.field === field)), entry]
      };
      const nextProblems = validateDataset(updated);
      if (nextProblems.length) throw fail('E_DATA_INVALID', nextProblems.join('；'), {dataset, problems: nextProblems});

      ctx.store.writeData(dsRel, updated, {baseHash, confirm: true});
      return {
        summary: `${object}.${field} ${invalid ? '判为无效' : `= ${parsed}`}（依据：${entry.basis}）`,
        outputs: [{path: dsRel, kind: 'data'}],
        data: {
          dataset, object, field, invalid, value: parsed, basis: entry.basis, at: entry.at,
          actor: entry.actor, total: updated.confirmations.length
        }
      };
    }
  },
  {
    id: 'annotation.trace',
    version: '1.0.0',
    stage: 'data',
    title: '底图描图',
    description: '把人工在底图上画的墙体合并进数据集模型，记录来源、操作者与时间；前提是底图比例与原点已校准。',
    params: [
      {key: 'dataset', label: '数据集 id', type: 'text', required: true},
      {key: 'floor', label: '楼层 id（留空取第一层）', type: 'text'},
      {key: 'items', label: '描图项（JSON 数组）', type: 'text', required: true},
      {key: 'underlay', label: '底图（JSON：file / mmPerPx / origin / rotationDeg）', type: 'text'},
      {key: 'actor', label: '操作者', type: 'text', required: true},
      {key: 'note', label: '备注', type: 'text'}
    ],
    inputs: {dataset: 'space-dataset/v1', model: 'space-model/v1'},
    outputs: {dataset: 'space-dataset/v1', model: 'space-model/v1'},
    sideEffects: ['write:data'],
    requires: [],
    idempotent: true,
    errors: [
      'E_EXEC_PARAM', 'E_DATA_SCHEMA', 'E_DATA_INVALID', 'E_DATA_REFERENCE',
      'E_STORE_CONFLICT', 'E_STORE_LOCK_REQUIRED', 'E_STORE_PATH', 'E_STORE_IO'
    ],
    async run(ctx, {dataset, floor, items, underlay: ul, actor, note = ''} = {}) {
      if (!dataset) throw fail('E_EXEC_PARAM', '需要数据集 id');
      if (!actor || typeof actor !== 'string' || !actor.trim()) throw fail('E_EXEC_PARAM', '人工改动必须记录操作者（actor）');
      let parsed;
      if (typeof items === 'string') {
        try { parsed = JSON.parse(items); } catch (e) { throw fail('E_EXEC_PARAM', `描图项不是合法 JSON：${e.message}`); }
      } else {
        parsed = items;
      }
      let parsedUnderlay = ul;
      if (typeof ul === 'string') {
        try { parsedUnderlay = JSON.parse(ul); } catch (e) { throw fail('E_EXEC_PARAM', `底图参数不是合法 JSON：${e.message}`); }
      }
      const normalized = (Array.isArray(parsed) ? parsed : []).map(traceItem);
      const problems = validateTraceSpec(traceSpec({dataset, floor, items: normalized, underlay: parsedUnderlay, actor, note}));
      if (problems.length) throw fail('E_EXEC_PARAM', problems.join('；'), {problems});

      const dsRel = datasetPath(dataset);
      if (!ctx.store.exists(dsRel)) throw fail('E_DATA_REFERENCE', `数据集不存在：${dataset}`, {dataset, file: dsRel});
      const dsHash = ctx.store.hashOf(dsRel);
      const record = ctx.store.readJson(dsRel);
      if (record?.schema !== DATASET_SCHEMA) throw fail('E_DATA_SCHEMA', `${dsRel} 不是 ${DATASET_SCHEMA}`);
      const dsProblems = validateDataset(record);
      if (dsProblems.length) throw fail('E_DATA_INVALID', dsProblems.join('；'), {dataset, problems: dsProblems});

      const modelRel = record.model || modelPath(dataset);
      if (!ctx.store.exists(modelRel)) throw fail('E_DATA_REFERENCE', `模型不存在：${modelRel}`, {file: modelRel});
      const modelHash = ctx.store.hashOf(modelRel);
      const rawModel = ctx.store.readJson(modelRel);
      if (rawModel?.schema !== 'space-model/v1') throw fail('E_DATA_SCHEMA', `${modelRel} 不是 space-model/v1`);
      // 手写/外部生成的模型可能缺数组字段：先按 prepareModel 归一化，再合并与校验。
      const model = prepareModel(rawModel);

      const at = new Date().toISOString();
      let merged;
      try {
        merged = mergeTrace(model, {floor, items: normalized, actor, at});
      } catch (e) {
        throw fail('E_DATA_REFERENCE', e.message, {dataset, floor});
      }
      const modelProblems = validateModel(merged.model);
      if (!modelProblems.passed) {
        throw fail('E_DATA_INVALID', `描图后模型不合法：${modelProblems.issues.map(i => i.message).join('；')}`, {issues: modelProblems.issues});
      }

      // 先写模型，再补数据集里的描图记录；两次都是权威写入，带各自基准哈希。
      ctx.store.writeData(modelRel, merged.model, {baseHash: modelHash, confirm: true});
      const entry = traceRecord({at, actor, floor: merged.floor, items: normalized, underlay: parsedUnderlay ?? null, note});
      const updated = {...record, traces: [...(record.traces || []), entry]};
      ctx.store.writeData(dsRel, updated, {baseHash: dsHash, confirm: true});

      const summary = traceSummary({applied: merged.applied, invalidHandles: merged.invalidHandles, floor: merged.floor});
      return {
        summary: `描图已合并 · ${summary.text}`,
        outputs: [{path: dsRel, kind: 'data'}, {path: modelRel, kind: 'data'}],
        data: {
          dataset, floor: merged.floor, model: modelRel,
          created: summary.created, replaced: summary.replaced, invalid: summary.invalid,
          handles: merged.applied.map(a => a.handle), at
        }
      };
    }
  }
];
