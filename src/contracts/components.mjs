// L0 契约：图元 → 构件标注。cad-source 只说「这条线是什么形状」，
// 这里说「它是什么构件、凭什么这么判」。识别（人/AI/规则）产出的就是这一层，
// 校验与存盘由 CLI 做，改判也留依据。
import {fail} from './errors.mjs';

export const SCHEMA = 'cad-components/v1';

// 构件类别：给核对页用的语义表。basis 是「判定依据」的默认文字，
// 单项可以带自己的 basis（例如「0层墙带双边与洞口收边」）。
export const COMPONENTS = {
  wall: {label: '墙体（待判承重）', color: '#65409a', basis: '墙带双边或加粗轮廓'},
  bearing: {label: '承重墙', color: '#ae2738', basis: '结构图或图例确认'},
  partition: {label: '非承重墙', color: '#367642', basis: '结构图或图例确认'},
  beam: {label: '梁', color: '#be5800', basis: '梁图层或双虚线'},
  pier: {label: '柱／墙垛', color: '#793131', basis: '成对封闭轮廓与填充'},
  door: {label: '门扇', color: '#bf1670', basis: '门扇轮廓与开启弧配对'},
  window: {label: '窗带', color: '#007891', basis: '洞口内三至四根平行线'},
  slide: {label: '推拉扇', color: '#2465b1', basis: '相邻错位扇框'},
  opening: {label: '洞口', color: '#009275', basis: '贯穿扇与固定段的边框'},
  slab: {label: '楼板', color: '#475569', basis: '楼板图层或板边界'},
  stair: {label: '楼梯', color: '#7c2d12', basis: '踏步阵列'},
  annotation: {label: '标注', color: '#647177', basis: '尺寸块、文字与引线'},
  other: {label: '其他／待识别', color: '#88857a', basis: '未定性'}
};

export const COMPONENT_KEYS = Object.keys(COMPONENTS);
// 核对页的主视图是「构件」，标注/其他单独归组，别让文字数量盖住墙柱门窗。
export const STRUCTURAL_KEYS = ['wall', 'bearing', 'partition', 'beam', 'pier', 'door', 'window', 'slide', 'opening', 'slab', 'stair'];

export function componentsDoc({sourceSha256, assignments = {}, kinds = {}} = {}) {
  return {
    schema: SCHEMA,
    source: {sha256: sourceSha256 || null},
    kinds: {...structuredClone(COMPONENTS), ...kinds},
    assignments
  };
}

export function componentOf(doc, id) {
  return doc?.assignments?.[id] || null;
}

// 校验：id 必须存在于图元索引，kind 必须在类别表里，provenance 只认三种。
export function validateComponents(doc, {entityIds} = {}) {
  const problems = [];
  if (!doc || doc.schema !== SCHEMA) problems.push(`不是 ${SCHEMA}：${doc?.schema}`);
  const ids = entityIds ? new Set(entityIds) : null;
  for (const [id, a] of Object.entries(doc?.assignments || {})) {
    if (ids && !ids.has(id)) problems.push(`assignments.${id}: 图元索引里没有这个 id`);
    if (!COMPONENTS[a?.kind]) problems.push(`assignments.${id}: 未知构件类别 ${a?.kind}`);
    if (a?.provenance && !['manual', 'ai', 'rule', 'import'].includes(a.provenance)) {
      problems.push(`assignments.${id}: provenance 只能是 manual / ai / rule / import`);
    }
    if (a?.confidence != null && (typeof a.confidence !== 'number' || a.confidence < 0 || a.confidence > 1)) {
      problems.push(`assignments.${id}: confidence 必须是 0–1`);
    }
  }
  return problems;
}

export function summarize(doc) {
  const counts = {};
  for (const a of Object.values(doc?.assignments || {})) counts[a.kind] = (counts[a.kind] || 0) + 1;
  return counts;
}

export function assertComponents(doc, opts) {
  const problems = validateComponents(doc, opts);
  if (problems.length) throw fail('E_DATA_SCHEMA', `构件标注不合契约：${problems[0]}`, {problems: problems.slice(0, 10)});
  return doc;
}

// 从外部标注（例如旧项目的 components.json：{kind:{label,sourceIds[]}}）
// 转成本契约。认不出的 id 留在 skipped 里报告，不静默丢弃。
export function fromLegacy(legacy, {entityIds, provenance = 'import', basis = {}} = {}) {
  const ids = entityIds ? new Set(entityIds) : null;
  const assignments = {};
  const skipped = [];
  for (const [kind, def] of Object.entries(legacy || {})) {
    if (!COMPONENTS[kind]) { skipped.push({kind, reason: '未知类别'}); continue; }
    for (const id of def?.sourceIds || []) {
      if (ids && !ids.has(id)) { skipped.push({id, kind, reason: '图元索引里没有'}); continue; }
      assignments[id] = {kind, provenance, basis: basis[kind] || def?.basis || COMPONENTS[kind].basis};
    }
  }
  return {assignments, skipped};
}
