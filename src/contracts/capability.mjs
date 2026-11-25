// L0 契约：能力契约的字段定义与校验。CLI 帮助、工作台表单、存储权限与
// 测试核对都由这里生成，能力实现本身不重复声明这些约束。
import {ERROR_CODE_SET} from './errors.mjs';
import {SCHEMA_SET} from './schemas.mjs';

export const STAGES = [
  {id: 'source', name: '图纸'},
  {id: 'data', name: '数据'},
  {id: 'design', name: '设计'},
  {id: 'model', name: '三维'},
  {id: 'delivery', name: '交付'}
];

export const STAGE_IDS = STAGES.map(s => s.id);

// 副作用决定存储层给这个能力开什么权限。
export const SIDE_EFFECTS = ['none', 'write:artifact', 'write:data', 'write:index'];

// 环境依赖前缀；未知前缀视为契约缺陷。
export const REQUIREMENT_PREFIXES = ['node:', 'python:', 'blender:', 'chrome:'];

export const PARAM_TYPES = ['text', 'path', 'output', 'select', 'number', 'boolean'];

// 与 docs/architecture.md 的「能力契约」一节逐项对应。
export const CAPABILITY_FIELDS = [
  'id', 'version', 'stage', 'title', 'description',
  'params', 'inputs', 'outputs', 'sideEffects', 'requires', 'idempotent', 'errors'
];

const SEMVER = /^\d+\.\d+\.\d+$/;
const CAPABILITY_ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;

// 输入输出引用：已登记的数据 schema、外部文件（path:dxf）或派生物类别（artifact:html）。
const PATH_REF = /^path:[a-z0-9,]+$/;
const ARTIFACT_REF = /^artifact:[a-z0-9-]+$/;

export function isSchemaRef(value) {
  return SCHEMA_SET.has(value) || PATH_REF.test(String(value)) || ARTIFACT_REF.test(String(value));
}

export function validateCapability(cap) {
  const problems = [];
  const add = (message) => problems.push(`${cap?.id || '?'}: ${message}`);

  if (!cap || typeof cap !== 'object') return ['能力必须是对象'];
  for (const field of CAPABILITY_FIELDS) if (!(field in cap)) add(`缺少字段 ${field}`);
  if (!CAPABILITY_ID.test(String(cap.id || ''))) add('id 需为「域.动词」形式的点分小写标识');
  if (!SEMVER.test(String(cap.version || ''))) add('version 需为 x.y.z');
  if (!STAGE_IDS.includes(cap.stage)) add(`stage 必须是 ${STAGE_IDS.join('|')}`);

  if (!Array.isArray(cap.params)) add('params 必须是数组');
  else for (const p of cap.params) {
    if (!p?.key) add('参数缺少 key');
    if (!PARAM_TYPES.includes(p?.type)) add(`参数 ${p?.key} 的 type 不合法`);
    if (!p?.label) add(`参数 ${p?.key} 缺少 label`);
    if (p?.type === 'select' && !Array.isArray(p.options)) add(`参数 ${p.key} 缺少 options`);
  }

  for (const field of ['inputs', 'outputs']) {
    if (!cap[field] || typeof cap[field] !== 'object' || Array.isArray(cap[field])) { add(`${field} 必须是对象`); continue; }
    for (const [key, schema] of Object.entries(cap[field])) {
      if (!isSchemaRef(schema)) add(`${field}.${key} 引用了未登记的 schema：${schema}`);
    }
  }

  if (!Array.isArray(cap.sideEffects) || !cap.sideEffects.length) add('sideEffects 不能为空');
  else for (const s of cap.sideEffects) if (!SIDE_EFFECTS.includes(s)) add(`未声明的副作用：${s}`);

  if (!Array.isArray(cap.requires)) add('requires 必须是数组');
  else for (const r of cap.requires) if (!REQUIREMENT_PREFIXES.some(p => r.startsWith(p))) add(`未知的环境依赖：${r}`);

  if (typeof cap.idempotent !== 'boolean') add('idempotent 必须是布尔值');

  if (!Array.isArray(cap.errors) || !cap.errors.length) add('errors 不能为空');
  else for (const code of cap.errors) if (!ERROR_CODE_SET.has(code)) add(`引用未登记的错误码：${code}`);

  if (typeof cap.run !== 'function') add('缺少实现 run');
  return problems;
}

// 计划中的能力：契约先登记，门面（CLI / 工作台）照常显示，但明确不可执行。
// blockedBy 写清「缺什么」，避免把「没做」说成「做不了」或者反过来。
export const PLANNED_FIELDS = ['id', 'stage', 'title', 'description', 'blockedBy'];

export const PLANNED_CAPABILITIES = [
  {
    id: 'doc.mep',
    stage: 'delivery',
    title: '水电图',
    description: '点位与管线路由草案，未确认的接入标高标待核。',
    blockedBy: 'space-model/v1 还没有点位数据（插座 / 水位 / 回路），需要先扩数据契约'
  },
  {
    id: 'doc.furniture',
    stage: 'delivery',
    title: '定制家具图',
    description: '定制家具立面与内部格局，柜顶关联有效顶面。',
    blockedBy: '缺 detail（层板 / 抽屉 / 挂衣区）的字段约定；轮廓、高度与柜顶有效顶面已能算'
  },
  {
    id: 'render.interior',
    stage: 'delivery',
    title: '室内效果图',
    description: '固定机位效果图，基础图锁几何、风格图只管材质光线。',
    blockedBy: '需要栅格渲染器（Blender / three 离屏），不属于确定性 SVG 链'
  }
];

export const PLANNED_IDS = PLANNED_CAPABILITIES.map(p => p.id);

export function validatePlanned(entry) {
  const problems = [];
  if (!entry || typeof entry !== 'object') return ['计划项必须是对象'];
  for (const field of PLANNED_FIELDS) if (!(field in entry)) problems.push(`计划项 ${entry?.id || '?'} 缺少 ${field}`);
  if (!CAPABILITY_ID.test(String(entry.id || ''))) problems.push(`计划项 id 需为「域.动词」形式：${entry.id}`);
  if (!STAGE_IDS.includes(entry.stage)) problems.push(`计划项 ${entry.id} 的 stage 不合法`);
  if (typeof entry.description !== 'string' || !entry.description.trim()) problems.push(`计划项 ${entry.id} 缺少说明`);
  if (typeof entry.blockedBy !== 'string' || !entry.blockedBy.trim()) problems.push(`计划项 ${entry.id} 缺少阻塞原因`);
  if ('run' in entry) problems.push(`计划项 ${entry.id} 不能带实现`);
  return problems;
}

export function validatePlannedRegistry(planned) {
  const problems = [];
  const seen = new Set();
  for (const entry of planned) {
    problems.push(...validatePlanned(entry));
    if (seen.has(entry.id)) problems.push(`重复的计划项：${entry.id}`);
    seen.add(entry.id);
  }
  return problems;
}

export function validateRegistry(caps) {
  const problems = [];
  const seen = new Map();
  for (const cap of caps) {
    problems.push(...validateCapability(cap));
    if (seen.has(cap.id)) problems.push(`重复的能力标识：${cap.id}`);
    seen.set(cap.id, cap);
  }
  return problems;
}

export function capabilityMeta(cap) {
  const {run, ...meta} = cap;
  return meta;
}

export function declaredErrors(cap) {
  return [...new Set(cap.errors)];
}

// 工作台按声明禁用按钮：缺依赖或需要确认时不在界面上假装可点。
export function capabilityAvailability(cap, env = {}) {
  const missing = cap.requires.filter(r => {
    const [kind, name] = r.split(':');
    if (kind === 'node') return false;
    return !env[kind];
  });
  return {available: missing.length === 0, missing, needsConfirm: cap.sideEffects.includes('write:data')};
}
