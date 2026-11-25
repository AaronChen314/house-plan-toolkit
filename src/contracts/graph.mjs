// L0 契约：推导图。三种关系必须分开，且只有一种能传播失效。
//
//   派生 derived —— 下游的输入是上游，上游变化让下游失效
//   版本 version —— 同一实体的第 N 次修改，存在 node_version(parent_seq)，不是边
//   复制 fork    —— 从某个方案抄一份，之后互不影响，只记录来源
//
// 规则（由 canEdge 与 tests/graph.test.mjs 双重把关）：
// - 设计之间只允许复制，不允许派生；
// - 数据集只能来自原件或校正，不能复制；
// - 反向依赖一律禁止（模型不能成为设计的输入）；
// - 派生边一旦确认不可原地修改，改动产生新版本。

export const NODE_KINDS = ['source', 'dataset', 'design', 'model', 'render', 'document', 'bundle'];

export const RELATIONS = ['derived', 'version', 'fork'];

// edge 表只承载派生与复制；版本走 node_version。
export const EDGE_ROLES = ['derived', 'fork'];

export const NODE_STATUSES = ['draft', 'confirmed', 'stale', 'superseded'];

export const STATUS_TRANSITIONS = {
  draft: ['confirmed', 'superseded'],
  confirmed: ['stale', 'superseded'],
  stale: ['confirmed', 'superseded'],
  superseded: []
};

// 允许的派生边：srcKind → dstKind[]。
export const ALLOWED_DERIVED = {
  source: ['dataset'],
  dataset: ['dataset', 'design'],
  design: ['model', 'render', 'document', 'bundle'],
  model: ['render', 'document', 'bundle'],
  render: ['bundle'],
  document: ['bundle'],
  bundle: []
};

// 允许的复制边：只有设计之间。
export const ALLOWED_FORK = {
  source: [],
  dataset: [],
  design: ['design'],
  model: [],
  render: [],
  document: [],
  bundle: []
};

// 状态的权威在文件，索引里的 node.status 只是投影。
// 这条不变量保证 space index rebuild / store rebuild 不会抹掉「待复核」结论。
export const STATUS_AUTHORITY = 'file';

export const GRAPH_INVARIANTS = [
  'version-is-not-an-edge',
  'design-fork-only',
  'dataset-never-forked',
  'no-reverse-dependency',
  'stale-does-not-delete',
  'status-authority-is-file'
];

export function canEdge(srcKind, dstKind, role) {
  if (!NODE_KINDS.includes(srcKind)) return {ok: false, reason: `未知来源类型 ${srcKind}`};
  if (!NODE_KINDS.includes(dstKind)) return {ok: false, reason: `未知目标类型 ${dstKind}`};
  if (role === 'derived') {
    if (srcKind === dstKind && !ALLOWED_DERIVED[srcKind].includes(dstKind)) return {ok: false, reason: `${srcKind} → ${dstKind} 不允许派生`};
    return ALLOWED_DERIVED[srcKind].includes(dstKind)
      ? {ok: true}
      : {ok: false, reason: `不允许派生：${srcKind} → ${dstKind}`};
  }
  if (role === 'fork') {
    return ALLOWED_FORK[srcKind].includes(dstKind)
      ? {ok: true}
      : {ok: false, reason: `只允许设计之间复制，不允许 ${srcKind} → ${dstKind}`};
  }
  if (role === 'version') {
    return {ok: false, reason: '版本不是边：用 node_version(parent_seq) 记录'};
  }
  return {ok: false, reason: `未知关系 ${role}`};
}

export function canTransition(from, to) {
  const status = from || 'draft';
  return (STATUS_TRANSITIONS[status] || []).includes(to);
}

export function relationStorage(role) {
  if (role === 'derived') return 'edge';
  if (role === 'fork') return 'fork';
  if (role === 'version') return 'node_version';
  throw new Error(`未知关系：${role}`);
}

// 派生边会传播失效；复制不传播。
export function propagates(role) {
  return role === 'derived';
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safeId(id, label) {
  if (!SAFE_ID.test(String(id || ''))) throw new Error(`${label} 只能是字母、数字、点、下划线与连字符：${id}`);
  return id;
}

// 权威文件位置：M2 的所有 lane 必须用这两个函数，不许各自发明目录。
export function datasetFile(id) {
  return `data/datasets/${safeId(id, '数据集体 id')}/dataset.json`;
}

export function designFile(scheme) {
  return `data/designs/${safeId(scheme, '方案 id')}/design.json`;
}

export function designVersionFile(scheme, seq) {
  safeId(scheme, '方案 id');
  if (!Number.isInteger(seq) || seq < 1) throw new Error(`版本号需为正整数：${seq}`);
  return `data/designs/${scheme}/versions/${String(seq).padStart(3, '0')}.json`;
}

export function validateGraph({nodes = [], edges = []} = {}) {
  const problems = [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const id of byId.keys()) if (!SAFE_ID.test(String(id))) problems.push(`节点 id 不合法：${id}`);

  for (const node of nodes) {
    if (!NODE_KINDS.includes(node.kind)) problems.push(`${node.id}: 未知节点类型 ${node.kind}`);
    const status = node.status || 'draft';
    if (!NODE_STATUSES.includes(status)) problems.push(`${node.id}: 未知状态 ${status}`);
  }

  const seen = new Set();
  for (const edge of edges) {
    const src = byId.get(edge.src), dst = byId.get(edge.dst);
    if (!src || !dst) { problems.push(`边指向未登记节点：${edge.src} → ${edge.dst}`); continue; }
    if (edge.src === edge.dst) problems.push(`自环边：${edge.src} [${edge.role}]`);
    const key = `${edge.src}|${edge.dst}|${edge.role}`;
    if (seen.has(key)) problems.push(`重复边：${edge.src} → ${edge.dst} [${edge.role}]`);
    seen.add(key);
    const check = canEdge(src.kind, dst.kind, edge.role);
    if (!check.ok) problems.push(`${edge.src}(${src.kind}) → ${edge.dst}(${dst.kind}) [${edge.role}]：${check.reason}`);
  }

  // 环检测只看会传播的边。
  const outgoing = new Map();
  for (const edge of edges) {
    if (!propagates(edge.role)) continue;
    if (!outgoing.has(edge.src)) outgoing.set(edge.src, []);
    outgoing.get(edge.src).push(edge.dst);
  }
  const state = new Map();
  const visit = (id, path) => {
    const mark = state.get(id);
    if (mark === 'done') return;
    if (mark === 'visiting') { problems.push(`派生关系成环：${[...path, id].join(' → ')}`); return; }
    state.set(id, 'visiting');
    for (const next of outgoing.get(id) || []) visit(next, [...path, id]);
    state.set(id, 'done');
  };
  for (const id of outgoing.keys()) visit(id, []);

  return problems;
}

export function kindOfIndexPath(rel) {
  const posix = String(rel);
  if (posix.startsWith('data/datasets/')) return 'dataset';
  if (posix.startsWith('data/designs/')) return 'design';
  if (posix.startsWith('data/documents/')) return 'document';
  return null;
}
