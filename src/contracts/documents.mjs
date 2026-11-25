// L0 契约：施工图与交付清单。
// 施工图只能从「数据集 + 设计版本」生成；产物是派生物，记录在交付清单里。
// 契约先定图面数据、图层规范与交付物记录，渲染与生成由 L1/L3 实现。

export const SHEET_SCHEMA = 'space-sheet/v1';
export const DOC_SCHEMA = 'space-doc/v1';
export const DOC_MANIFEST_SCHEMA = 'space-doc-manifest/v1';

// implemented=false 的图种只有契约与图层规范，没有能力——不做假装能出的图。
export const DOC_KINDS = [
  {id: 'wall-demolition', title: '拆改图', implemented: true},
  {id: 'mep', title: '水电图', implemented: false},
  {id: 'furniture', title: '定制家具图', implemented: false}
];

export const DOC_KIND_IDS = DOC_KINDS.map(d => d.id);

export function docKind(id) {
  return DOC_KINDS.find(d => d.id === id) || null;
}

// 图层规范：order 决定绘制顺序，width 是毫米线宽，dash 是虚线节奏（毫米）。
// 同一张图的图层顺序固定，渲染结果才可比哈希。
export const LAYERS = {
  frame: {name: '图框', order: 0, color: '#1f2d26', width: 0.5},
  'wall-existing': {name: '保留墙体', order: 10, color: '#2f4a3a', width: 0.7},
  'wall-demolish': {name: '拆除墙体', order: 20, color: '#b3261e', width: 0.7, dash: [40, 20]},
  'wall-new': {name: '新建墙体', order: 30, color: '#1a5fb4', width: 0.9},
  opening: {name: '门窗洞口', order: 40, color: '#5f6f66', width: 0.5},
  furniture: {name: '家具', order: 50, color: '#6b5a3e', width: 0.5},
  'cabinet-inner': {name: '柜内格局', order: 60, color: '#8a6d3b', width: 0.35, dash: [20, 10]},
  'mep-point': {name: '水电点位', order: 70, color: '#0b6e99', width: 0.6},
  'mep-route': {name: '管线路由', order: 75, color: '#0b6e99', width: 0.45, dash: [30, 15]},
  dimension: {name: '尺寸标注', order: 80, color: '#34483b', width: 0.35},
  note: {name: '文字说明', order: 90, color: '#1f2d26', width: 0.35}
};

export const LAYER_IDS = Object.keys(LAYERS).sort((a, b) => LAYERS[a].order - LAYERS[b].order);

// 每种图能用哪些图层：跨图种混用一律拒绝。
export const KIND_LAYERS = {
  'wall-demolition': ['frame', 'wall-existing', 'wall-demolish', 'wall-new', 'opening', 'dimension', 'note'],
  mep: ['frame', 'wall-existing', 'mep-point', 'mep-route', 'dimension', 'note'],
  furniture: ['frame', 'wall-existing', 'furniture', 'cabinet-inner', 'dimension', 'note']
};

export const SHEET_DEFAULTS = {width: 841, height: 594, margin: 10, scale: 100};

export const ITEM_KINDS = ['polyline', 'polygon', 'text', 'dimension', 'point'];

export function layerOf(id) {
  const layer = LAYERS[id];
  return layer ? {id, ...layer} : null;
}

export function layersFor(kind) {
  const allowed = KIND_LAYERS[kind];
  if (!allowed) return [];
  return allowed.map(id => ({id, ...LAYERS[id]})).sort((a, b) => a.order - b.order);
}

const finitePair = (point) => Array.isArray(point) && point.length === 2 && point.every(v => Number.isFinite(v));

// 图面数据：纯数据，渲染前唯一输入。坐标单位毫米，与空间模型一致。
export function sheetSpec({kind, title, subtitle = '', scale = SHEET_DEFAULTS.scale, size = {}, items = [], notes = [], meta = {}} = {}) {
  return {
    schema: SHEET_SCHEMA,
    kind,
    title,
    subtitle,
    scale,
    size: {...SHEET_DEFAULTS, ...size},
    layerOrder: KIND_LAYERS[kind] || [],
    items,
    notes,
    meta
  };
}

export function validateSheetSpec(spec) {
  const problems = [];
  if (!spec || typeof spec !== 'object') return ['图面数据必须是对象'];
  if (spec.schema !== SHEET_SCHEMA) problems.push(`schema 应为 ${SHEET_SCHEMA}`);
  if (!DOC_KIND_IDS.includes(spec.kind)) problems.push(`未知图种：${spec.kind}`);
  if (!spec.title) problems.push('缺少图名');
  if (!Number.isFinite(spec.scale) || spec.scale <= 0) problems.push('比例必须是正数');

  const allowed = new Set(KIND_LAYERS[spec.kind] || []);
  for (const [i, item] of (spec.items || []).entries()) {
    const where = `items[${i}]`;
    if (!allowed.has(item?.layer)) problems.push(`${where} 图层不在该图种的规范里：${item?.layer}`);
    if (!ITEM_KINDS.includes(item?.kind)) problems.push(`${where} 未知图元类型：${item?.kind}`);
    if (item?.kind === 'text') {
      if (!finitePair(item.at)) problems.push(`${where} 文字缺少坐标`);
      if (typeof item.text !== 'string' || !item.text) problems.push(`${where} 文字为空`);
    } else if (item?.kind === 'dimension') {
      if (!finitePair(item.from) || !finitePair(item.to)) problems.push(`${where} 标注缺少端点`);
      if (!Number.isFinite(item.offset)) problems.push(`${where} 标注缺少偏移`);
    } else if (item?.kind === 'point') {
      if (!finitePair(item.at)) problems.push(`${where} 点位缺少坐标`);
    } else {
      if (!Array.isArray(item?.points) || item.points.length < 2) problems.push(`${where} 折线/多边形至少两个点`);
      else if (!item.points.every(finitePair)) problems.push(`${where} 点坐标不合法`);
    }
  }
  for (const [i, note] of (spec.notes || []).entries()) {
    if (typeof note !== 'string' || !note.trim()) problems.push(`notes[${i}] 不能为空`);
  }
  return problems;
}

// 交付物路径：一张图一个文件，文件名带方案与版本，肉眼可查。
export function deliverableFile({kind, scheme, seq}) {
  if (!DOC_KIND_IDS.includes(kind)) throw new Error(`未知图种：${kind}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(scheme || ''))) throw new Error(`方案 id 不合法：${scheme}`);
  if (!Number.isInteger(seq) || seq < 1) throw new Error(`版本号需为正整数：${seq}`);
  return `output/doc/${kind}/${scheme}-${String(seq).padStart(3, '0')}.svg`;
}

export function docManifestFile() {
  return 'output/doc/manifest.json';
}

export function docKey({kind, scheme, seq}) {
  return `${kind}:${scheme}:${seq}`;
}

// 输入版本链：任何交付物都要能回答「基于哪版数据、哪版设计、哪些确认值」。
export function inputChain({dataset = null, design = null, model = null, confirmations = [], params = {}} = {}) {
  return {
    dataset: dataset ? {id: dataset.id, file: dataset.file, sha256: dataset.sha256 ?? null} : null,
    design: design ? {scheme: design.scheme, seq: design.seq, status: design.status ?? null, file: design.file, sha256: design.sha256 ?? null} : null,
    model: model ? {file: model.file, sha256: model.sha256 ?? null} : null,
    confirmations: (confirmations || []).map(c => ({object: c.object, field: c.field, ...(c.invalid ? {invalid: true} : {value: c.value}), basis: c.basis ?? null})),
    params
  };
}

export function deliverable({kind, title, file, sha256, bytes, generator, inputs, status = 'generated', staleReason = null, generatedAt} = {}) {
  return {
    schema: DOC_SCHEMA,
    kind,
    title,
    file,
    sha256,
    bytes,
    generator: {id: generator?.id ?? null, version: generator?.version ?? null},
    inputs,
    status,
    staleReason,
    generatedAt
  };
}

export function validateDeliverable(record) {
  const problems = [];
  if (!record || typeof record !== 'object') return ['交付物记录必须是对象'];
  if (record.schema !== DOC_SCHEMA) problems.push(`schema 应为 ${DOC_SCHEMA}`);
  if (!DOC_KIND_IDS.includes(record.kind)) problems.push(`未知图种：${record.kind}`);
  if (!record.file) problems.push('缺少产物路径');
  if (!/^[0-9a-f]{64}$/.test(String(record.sha256 || ''))) problems.push('缺少产物哈希');
  if (!Number.isFinite(record.bytes) || record.bytes < 0) problems.push('缺少产物大小');
  if (!['generated', 'stale'].includes(record.status)) problems.push(`状态不合法：${record.status}`);
  if (!record.inputs?.design?.scheme) problems.push('缺少设计版本输入：交付物必须能追溯到设计版本');
  if (!record.inputs?.dataset?.id) problems.push('缺少数据集输入');
  return problems;
}

export function manifest({docs = {}, updatedAt} = {}) {
  return {schema: DOC_MANIFEST_SCHEMA, updatedAt: updatedAt ?? null, docs};
}

export function validateManifest(value) {
  const problems = [];
  if (!value || typeof value !== 'object') return ['交付清单必须是对象'];
  if (value.schema !== DOC_MANIFEST_SCHEMA) problems.push(`schema 应为 ${DOC_MANIFEST_SCHEMA}`);
  if (!value.docs || typeof value.docs !== 'object' || Array.isArray(value.docs)) { problems.push('docs 必须是对象'); return problems; }
  for (const [key, record] of Object.entries(value.docs)) {
    for (const problem of validateDeliverable(record)) problems.push(`${key}: ${problem}`);
  }
  return problems;
}
