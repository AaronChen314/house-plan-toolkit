// L0 契约：图元 → 构件标注。
// 这里只管结构与校验，不含任何分类规则：
// 有哪些构件类别、各自叫什么、什么颜色、凭什么判，都属于项目的「约定」，
// 写在 data/cad/components.json 的 kinds 里（由人 / AI 按技能文档填写），
// 不在脚本里枚举。
import {fail} from './errors.mjs';

export const SCHEMA = 'cad-components/v1';

// 一条标注：{kind, basis?, provenance?, confidence?}
// kind 必须出现在同一文件的 kinds 里。group 只是显示分组（structural / auxiliary），
// 不参与判定。
const PROVENANCE = ['manual', 'ai', 'rule', 'import'];

export function componentsDoc({sourceSha256, kinds = {}, assignments = {}} = {}) {
  return {schema: SCHEMA, source: {sha256: sourceSha256 || null}, kinds, assignments};
}

export function kindOf(doc, kind) {
  return doc?.kinds?.[kind] || null;
}

export function kindLabel(doc, kind) {
  return doc?.kinds?.[kind]?.label || kind;
}

export function kindColor(doc, kind, fallback = '#7d8f86') {
  return doc?.kinds?.[kind]?.color || fallback;
}

export function validateComponents(doc, {entityIds} = {}) {
  const problems = [];
  if (!doc || doc.schema !== SCHEMA) problems.push(`不是 ${SCHEMA}：${doc?.schema}`);
  const kinds = doc?.kinds || {};
  if (Object.keys(kinds).length === 0 && Object.keys(doc?.assignments || {}).length > 0) {
    problems.push('有 assignments 但 kinds 是空的：构件类别必须由数据定义');
  }
  for (const [key, k] of Object.entries(kinds)) {
    if (!/[a-z0-9_-]/i.test(key)) problems.push(`kinds.${key}: 类别键只能用字母数字下划线`);
    if (!k?.label) problems.push(`kinds.${key}: 缺 label（给人看的中文名）`);
    if (k?.color && !/^#[0-9a-f]{6}$/i.test(k.color)) problems.push(`kinds.${key}: color 必须是 #rrggbb`);
    if (k?.group && !['structural', 'auxiliary'].includes(k.group)) {
      problems.push(`kinds.${key}: group 只能是 structural / auxiliary`);
    }
  }
  const ids = entityIds ? new Set(entityIds) : null;
  for (const [id, a] of Object.entries(doc?.assignments || {})) {
    if (ids && !ids.has(id)) problems.push(`assignments.${id}: 图元索引里没有这个 id`);
    if (!a?.kind) problems.push(`assignments.${id}: 缺 kind`);
    else if (!kinds[a.kind]) problems.push(`assignments.${id}: kinds 里没有 ${a.kind}`);
    if (a?.provenance && !PROVENANCE.includes(a.provenance)) {
      problems.push(`assignments.${id}: provenance 只能是 ${PROVENANCE.join(' / ')}`);
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

// 显示顺序：构件在前、辅助在后；同一组内按种类表给定顺序。
export function kindOrder(doc) {
  const kinds = Object.entries(doc?.kinds || {});
  const rank = (k) => (k.group === 'structural' ? 0 : k.group === 'auxiliary' ? 1 : 0);
  return kinds.sort((a, b) => rank(a[1]) - rank(b[1])).map(([key]) => key);
}

export function assertComponents(doc, opts) {
  const problems = validateComponents(doc, opts);
  if (problems.length) throw fail('E_DATA_SCHEMA', `构件标注不合契约：${problems[0]}`, {problems: problems.slice(0, 10)});
  return doc;
}

// 旧项目格式：{kind: {label, color, basis, sourceIds[]}} —— 类别声明与条目在同一个文件里。
// 这里只做形状转换；认不出的 id 逐条报告，不静默丢弃。
export function fromLegacy(legacy, {entityIds, provenance = 'import'} = {}) {
  const ids = entityIds ? new Set(entityIds) : null;
  const kinds = {};
  const assignments = {};
  const skipped = [];
  for (const [key, def] of Object.entries(legacy || {})) {
    if (!def || typeof def !== 'object') { skipped.push({kind: key, reason: '不是对象'}); continue; }
    kinds[key] = {
      label: def.label || key,
      ...(def.color ? {color: def.color} : {}),
      ...(def.basis ? {basis: def.basis} : {}),
      group: def.group || (key === 'annotation' ? 'auxiliary' : key === 'other' ? 'auxiliary' : 'structural')
    };
    for (const id of def.sourceIds || []) {
      if (ids && !ids.has(id)) { skipped.push({id, kind: key, reason: '图元索引里没有'}); continue; }
      assignments[id] = {kind: key, provenance, ...(def.basis ? {basis: def.basis} : {})};
    }
  }
  return {kinds, assignments, skipped};
}
