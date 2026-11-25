// L0 契约：数据集与设计版本的文件形状。
// 权威在文件（data/ 下），索引里的 node/edge 只是投影。
// 所有 lane 必须用这里的构造函数与校验器，不许自己拼字段。

export const DATASET_SCHEMA = 'space-dataset/v1';
export const DESIGN_SCHEMA = 'space-design/v1';
export const DESIGN_VERSION_SCHEMA = 'space-design-version/v1';

// 状态沿用推导图契约：draft → confirmed → stale → superseded。
export const DESIGN_STATUSES = ['draft', 'confirmed', 'stale', 'superseded'];

const now = (at) => at || new Date().toISOString();
const isText = (v) => typeof v === 'string' && v.trim().length > 0;

function problemsOf(schema, obj, required) {
  const problems = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [`${schema}: 需要对象`];
  if (obj.schema !== schema) problems.push(`${schema}: schema 应为 ${schema}，读到 ${obj.schema}`);
  for (const key of required) {
    const value = obj[key];
    if (value === undefined || value === null) problems.push(`${schema}: 缺少 ${key}`);
  }
  return problems;
}

export function emptyDataset({id, model = null, sources = [], at} = {}) {
  return {
    schema: DATASET_SCHEMA,
    id,
    status: 'draft',
    createdAt: now(at),
    model,
    sources: sources.map(s => ({file: s.file, sha256: s.sha256 ?? null, ...(s.note ? {note: s.note} : {})})),
    corrections: [],
    confirmations: [],
    assumptions: []
  };
}

export function validateDataset(obj) {
  const problems = problemsOf(DATASET_SCHEMA, obj, ['id', 'status', 'sources']);
  if (problems.length > 1) return problems;
  if (!isText(obj.id)) problems.push('数据集 id 不能为空');
  if (!DESIGN_STATUSES.includes(obj.status)) problems.push(`dataset.status 不合法：${obj.status}`);
  if (!Array.isArray(obj.sources) || !obj.sources.length) problems.push('数据集必须登记至少一个来源');
  for (const [i, s] of (obj.sources || []).entries()) {
    if (!isText(s?.file)) problems.push(`sources[${i}] 缺少 file`);
  }
  for (const key of ['corrections', 'confirmations', 'assumptions']) {
    if (obj[key] !== undefined && !Array.isArray(obj[key])) problems.push(`${key} 必须是数组`);
  }
  for (const [i, c] of (obj.confirmations || []).entries()) {
    if (!isText(c?.object) || !isText(c?.field)) problems.push(`confirmations[${i}] 需要 object 与 field`);
    if (c?.invalid !== true && c?.value === undefined) problems.push(`confirmations[${i}] 缺少 value（判为无效时用 invalid: true）`);
    if (!isText(c?.at)) problems.push(`confirmations[${i}] 缺少确认时间`);
    if (!isText(c?.basis)) problems.push(`confirmations[${i}] 缺少依据（basis）：确认必须逐项带依据`);
  }
  for (const [i, a] of (obj.assumptions || []).entries()) {
    if (!isText(a?.object) || !isText(a?.field)) problems.push(`assumptions[${i}] 需要 object 与 field`);
    if (!isText(a?.basis)) problems.push(`assumptions[${i}] 缺少依据（basis）`);
  }
  return problems;
}

export function emptyDesign({scheme, dataset, at} = {}) {
  return {
    schema: DESIGN_SCHEMA,
    scheme,
    dataset,
    createdAt: now(at),
    versions: []
  };
}

export function validateDesign(obj) {
  const problems = problemsOf(DESIGN_SCHEMA, obj, ['scheme', 'dataset', 'versions']);
  if (problems.length > 1) return problems;
  if (!isText(obj.scheme)) problems.push('方案 id 不能为空');
  if (!isText(obj.dataset)) problems.push('设计必须引用一个数据集');
  if (!Array.isArray(obj.versions)) { problems.push('versions 必须是数组'); return problems; }
  const seqs = new Set();
  for (const [i, v] of obj.versions.entries()) {
    if (!Number.isInteger(v?.seq) || v.seq < 1) problems.push(`versions[${i}] seq 需为正整数`);
    else if (seqs.has(v.seq)) problems.push(`versions[${i}] seq 重复：${v.seq}`);
    seqs.add(v?.seq);
    if (!DESIGN_STATUSES.includes(v?.status)) problems.push(`versions[${i}] status 不合法：${v?.status}`);
    if (v?.dataset && v.dataset !== obj.dataset) problems.push(`versions[${i}] 引用的数据集与方案不一致`);
  }
  return problems;
}

export function designVersion({scheme, seq, dataset, parent = null, forkedFrom = null, status = 'draft', payload = null, uses = [], note = '', at} = {}) {
  return {
    schema: DESIGN_VERSION_SCHEMA,
    scheme,
    seq,
    dataset: dataset ?? null,
    parent,
    forkedFrom,
    status,
    createdAt: now(at),
    note,
    // 这个版本用到哪些构件（handle）。空数组表示「依赖整个数据集」，
    // 上游任何图元变化都算受影响——保守但不会漏。
    uses: normalizeUses(uses),
    payload
  };
}

export function normalizeUses(uses) {
  const list = Array.isArray(uses) ? uses : [];
  return [...new Set(list.filter(u => typeof u === 'string' && u.trim()).map(u => u.trim()))].sort();
}

export function validateDesignVersion(obj) {
  const problems = problemsOf(DESIGN_VERSION_SCHEMA, obj, ['scheme', 'seq', 'dataset', 'status']);
  if (problems.length > 1) return problems;
  if (!isText(obj.scheme)) problems.push('版本必须记录方案 id');
  if (!Number.isInteger(obj.seq) || obj.seq < 1) problems.push('seq 需为正整数');
  if (!DESIGN_STATUSES.includes(obj.status)) problems.push(`status 不合法：${obj.status}`);
  if (obj.parent !== null && !(Number.isInteger(obj.parent) && obj.parent < obj.seq)) problems.push('parent 必须是更小的版本号');
  if (obj.forkedFrom !== null && obj.forkedFrom !== undefined) {
    if (!isText(obj.forkedFrom?.scheme) || !Number.isInteger(obj.forkedFrom?.seq)) problems.push('forkedFrom 需要 {scheme, seq}');
  }
  if (obj.payload !== null && typeof obj.payload !== 'object') problems.push('payload 必须是对象或 null');
  if (obj.uses !== undefined && (!Array.isArray(obj.uses) || obj.uses.some(u => !isText(u)))) problems.push('uses 需要非空字符串数组');
  return problems;
}

// 设计版本号只增不减；复制出来的方案从 001 重新开始。
export function nextSeq(design) {
  const seqs = (design?.versions || []).map(v => v.seq).filter(Number.isInteger);
  return seqs.length ? Math.max(...seqs) + 1 : 1;
}

// 供能力与工作台共用：从版本清单里挑「当前版本」（最大 seq）。
export function currentVersion(design) {
  const versions = [...(design?.versions || [])].sort((a, b) => a.seq - b.seq);
  return versions.at(-1) || null;
}
