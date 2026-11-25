// L3 能力注册表：按域聚合。新增能力 = 新增本目录下的域文件 + 这里加一个展开项。
// 契约字段由 L0 定义与校验；能力实现只经 ctx.store 写入。
import fs from 'node:fs';
import path from 'node:path';
import {lintProject} from '../checks/layout.mjs';
import {
  STAGES, capabilityMeta, validateRegistry, validatePlannedRegistry,
  PLANNED_CAPABILITIES, PLANNED_IDS
} from '../contracts/capability.mjs';
import {fail, isSpaceError} from '../contracts/errors.mjs';
import {capabilities as sourceCapabilities} from './source.mjs';
import {capabilities as convertCapabilities} from './convert.mjs';
import {capabilities as vectorCapabilities} from './vector.mjs';
import {capabilities as dataCapabilities} from './data.mjs';
import {capabilities as designCapabilities} from './design.mjs';
import {capabilities as programCapabilities} from './program.mjs';
import {capabilities as docCapabilities} from './documents.mjs';
import {capabilities as renderCapabilities} from './render.mjs';
import {capabilities as bundleCapabilities} from './bundle.mjs';
import {capabilities as modelCapabilities} from './model.mjs';
import {createContext, resolveInside} from './context.mjs';

export {STAGES, createContext, resolveInside};
export {relOf} from './context.mjs';

export const capabilities = [
  ...sourceCapabilities,
  ...convertCapabilities,
  ...vectorCapabilities,
  ...dataCapabilities,
  ...designCapabilities,
  ...programCapabilities,
  ...docCapabilities,
  ...renderCapabilities,
  ...bundleCapabilities,
  ...modelCapabilities
];

// 插件能力：默认空；initPlugins 之后与内置能力一起出现。
let pluginState = {enabled: false, loaded: [], capabilities: [], problems: []};

export async function initPlugins({projectDir, home, enabled} = {}) {
  const {loadPlugins} = await import('./plugins.mjs');
  pluginState = await loadPlugins({
    projectDir,
    home,
    enabled,
    builtinIds: capabilities.map(c => c.id),
    plannedIds: PLANNED_IDS
  });
  return pluginState;
}

export function pluginSummary() {
  return {
    enabled: pluginState.enabled,
    plugins: pluginState.loaded.map(p => ({id: p.id, name: p.name, version: p.version, capabilities: pluginState.capabilities.filter(c => c.plugin?.id === p.id).map(c => c.id)})),
    problems: [...pluginState.problems]
  };
}

export function pluginCapabilities() {
  return [...pluginState.capabilities];
}

export function listCapabilities() {
  return [...capabilities, ...pluginState.capabilities].map(capabilityMeta);
}

export function listPlanned() {
  return PLANNED_CAPABILITIES.map(entry => ({...entry, planned: true}));
}

// 门面用：已实现 + 计划中，一次性给 CLI 与工作台。
export function capabilityCatalog() {
  return {implemented: listCapabilities(), planned: listPlanned()};
}

export function checkCapabilities() {
  const problems = [
    ...validateRegistry(capabilities),
    ...validateRegistry(pluginState.capabilities),
    ...validatePlannedRegistry(PLANNED_CAPABILITIES),
    ...pluginState.problems
  ];
  for (const id of PLANNED_IDS) {
    if (capabilities.some(c => c.id === id)) problems.push(`计划项与已实现能力重名：${id}`);
  }
  const allIds = new Set();
  for (const cap of [...capabilities, ...pluginState.capabilities]) {
    if (PLANNED_IDS.includes(cap.id)) problems.push(`已实现能力不能同时标为计划：${cap.id}`);
    if (allIds.has(cap.id)) problems.push(`能力 id 重复：${cap.id}`);
    allIds.add(cap.id);
  }
  return problems;
}

export function getCapability(id) {
  const cap = [...capabilities, ...pluginState.capabilities].find(c => c.id === id);
  if (!cap) throw fail('E_EXEC_UNKNOWN_CAPABILITY', `未知能力：${id}`);
  return cap;
}

// 写权威数据的能力会从文件重建推导图投影，避免下一次校正预演读到过期状态。
// 投影是派生数据：失败只记日志，不影响能力本身的成功。
async function refreshProjection(ctx, cap) {
  if (!cap.sideEffects.includes('write:data')) return null;
  try {
    const {projectFromFiles} = await import('../store/graph.mjs');
    const r = await projectFromFiles(ctx.store);
    ctx.log(`推导图投影已刷新：${r.nodes} 个节点 / ${r.edges} 条边 / ${r.forks} 条复制`);
    return r;
  } catch (e) {
    ctx.log(`推导图投影未刷新（${e.code || 'error'}）：${e.message}；可稍后运行 space graph sync`);
    return null;
  }
}

// 无头执行：能力本身不知道宿主存在，只在结果里给出摘要、产物与数据。
export async function runCapability({project, capability, params = {}, log = () => {}, actor}) {
  const planned = PLANNED_CAPABILITIES.find(p => p.id === capability);
  if (planned) throw fail('E_EXEC_NOT_IMPLEMENTED', `${capability} 还没有实现——${planned.blockedBy}`, {capability, blockedBy: planned.blockedBy});
  const ctx = createContext(project, {log, actor});
  const cap = getCapability(capability);
  const scoped = ctx.store.scope(cap.id);
  const started = Date.now();
  try {
    const result = await cap.run({...ctx, store: scoped}, params);
    const graph = await refreshProjection(ctx, cap);
    ctx.store.operation({op: cap.id, status: 'done', ms: Date.now() - started, writes: scoped.writes || 0, params, ...(graph ? {graph: {nodes: graph.nodes, edges: graph.edges, forks: graph.forks}} : {})});
    return {capability: cap.id, title: cap.title, ...result, ...(graph ? {graph: {nodes: graph.nodes, edges: graph.edges, forks: graph.forks}} : {}), logs: ctx.logs || []};
  } catch (e) {
    ctx.store.operation({op: cap.id, status: 'failed', ms: Date.now() - started, params, error: e.code || 'E_EXEC_PROCESS', message: e.message});
    if (isSpaceError(e)) throw e;
    const wrapped = fail('E_EXEC_PROCESS', e.message);
    wrapped.logs = ctx.logs;
    throw wrapped;
  }
}

export function projectOverview(projectFile) {
  const ctx = createContext(projectFile);
  const lint = lintProject(ctx.file);
  const files = [];
  for (const dir of ['source', 'data', 'output', 'docs', 'scripts', 'checks']) {
    const base = path.join(ctx.dir, dir);
    if (!fs.existsSync(base)) continue;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, {withFileTypes: true})) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'history') continue;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) walk(abs);
        else if (files.length < 400) files.push(path.relative(ctx.dir, abs).split(path.sep).join('/'));
      }
    };
    walk(base);
  }
  return {file: ctx.file, dir: ctx.dir, project: ctx.project, lint, files, store: ctx.store.verify()};
}
