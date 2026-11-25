// L2 存储：推导图的索引投影层。
// 权威在文件：data/datasets/<id>/dataset.json 与 data/designs/<方案>/versions/<seq>.json
// 里的 status 才是结论；node/edge/fork 只是索引投影，删掉 .space/project.sqlite
// 之后用 projectFromFiles 从文件重建，结论不会丢。
//
// 写入分工：三张图表的写入只在这里（docs/storage.md 的「lane 边界」），
// 数据库句柄来自 store.derived('index')，一次同步只留一条汇总事件，不进文件登记。
import fs from 'node:fs';
import path from 'node:path';
import {fail} from '../contracts/errors.mjs';
import {datasetFile, designFile, designVersionFile, validateGraph} from '../contracts/graph.mjs';
import {validateDataset, validateDesign, validateDesignVersion, currentVersion} from '../contracts/datasets.mjs';
import {planStale} from '../domain/graph.mjs';
import {closeIndex, openIndex, openIndexRead} from '../indexer/db.mjs';
import {applySchema} from '../indexer/schema.mjs';
import {listNodes, registerNode} from '../indexer/entities.mjs';

const DATASET_DIR = 'data/datasets';
const DESIGN_DIR = 'data/designs';

function subdirs(abs) {
  try {
    return fs.readdirSync(abs, {withFileTypes: true})
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();
  } catch {
    return [];
  }
}

// 只读扫描：项目内的文件用存储层读（路径越界会被拒），缺文件当不存在处理。
function readJsonIfPresent(store, rel) {
  if (!store.exists(rel)) return null;
  return store.readJson(rel);
}

function sameEdge(a, b) {
  return a.src === b.src && a.dst === b.dst && a.role === b.role;
}

// 复制在契约里要留两处痕迹：fork(node, copied_from) 与 edge(role='fork')。
// 调用方只给 forks 时补出边，校验与写入都看同一份边清单。
function mergeForkEdges(edges, forks) {
  const merged = [...edges];
  for (const fork of forks) {
    if (!fork?.node || !fork?.copiedFrom) continue;
    const edge = {src: fork.copiedFrom, dst: fork.node, role: 'fork'};
    if (!merged.some(e => sameEdge(e, edge))) merged.push(edge);
  }
  return merged;
}

// 索引写入前的一次性校验：节点类型/状态、边方向、成环、复制唯一。
// 契约要求（设计不能派生设计、只有设计之间能复制）由 validateGraph 兜住。
function validateProjection({nodes, edges, forks}) {
  const mergedEdges = mergeForkEdges(edges, forks);
  const problems = validateGraph({nodes, edges: mergedEdges});
  const nodeIds = new Set();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) problems.push(`节点重复登记：${node.id}`);
    nodeIds.add(node.id);
  }
  const seen = new Set();
  for (const fork of forks) {
    if (!fork?.node || !fork?.copiedFrom) {
      problems.push('复制记录需要 node 与 copiedFrom');
      continue;
    }
    if (seen.has(fork.node)) problems.push(`同一个方案登记了多次复制：${fork.node}`);
    seen.add(fork.node);
  }
  return {problems, edges: mergedEdges};
}

function sortedNodes(nodes) {
  return [...nodes].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function sortedEdges(edges) {
  return [...edges].sort((a, b) =>
    String(a.src).localeCompare(String(b.src))
    || String(a.dst).localeCompare(String(b.dst))
    || String(a.role).localeCompare(String(b.role)));
}

// 把节点/边/复制写进 .space/project.sqlite 的 node / edge / fork 三张表。
// 整表重建：同一份输入重复同步结果一致，节点不会翻倍。
// node_version 不在这里清空——版本链由各自的 lane 维护。
export async function syncGraph(store, {nodes = [], edges = [], forks = []} = {}) {
  const {problems, edges: mergedEdges} = validateProjection({nodes, edges, forks});
  if (problems.length) {
    throw fail('E_DATA_RULE', `推导图不合法：${problems.join('；')}`, {problems});
  }

  const index = store.derived('index');
  const db = await openIndex(index);
  const written = {nodes: nodes.length, edges: mergedEdges.length, forks: forks.length};
  try {
    applySchema(db);
    db.exec('BEGIN IMMEDIATE');
    try {
      // 先清边再清节点：顺序固定，失败回滚后索引仍是上一份完整投影。
      db.exec('DELETE FROM edge');
      db.exec('DELETE FROM fork');
      db.exec('DELETE FROM node');
      for (const node of sortedNodes(nodes)) {
        registerNode(db, {
          id: node.id,
          kind: node.kind,
          label: node.label ?? null,
          status: node.status || 'draft',
          projectId: node.projectId ?? store.projectId ?? null
        });
      }
      const insertEdge = db.prepare('INSERT OR IGNORE INTO edge (src, dst, role) VALUES (?, ?, ?)');
      for (const edge of sortedEdges(mergedEdges)) insertEdge.run(edge.src, edge.dst, edge.role);
      const insertFork = db.prepare('INSERT INTO fork (node, copied_from, at) VALUES (?, ?, ?)');
      const at = new Date().toISOString();
      for (const fork of [...forks].sort((a, b) => String(a.node).localeCompare(String(b.node)))) {
        insertFork.run(fork.node, fork.copiedFrom, fork.at ?? at);
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  } finally {
    closeIndex(db);
  }

  // 只留一条汇总事件：位置、大小、计数，不逐行记录。
  const event = index.commit({op: 'graph.sync', summary: {...written}});
  return {...written, event};
}

function rowsOrEmpty(read) {
  try {
    return read();
  } catch {
    // 空库、旧库或别的工具建的库：按「没有投影」处理，读路径不抛错。
    return [];
  }
}

// 读回投影。索引不存在时返回空结构，调用方据此降级到「从文件重建」。
export async function readGraph(store) {
  const empty = {nodes: [], edges: [], forks: [], versions: []};
  const handle = await openIndexRead(store.derived('index'));
  if (!handle) return empty;
  const {db} = handle;
  return {
    nodes: rowsOrEmpty(() => listNodes(db)),
    edges: rowsOrEmpty(() => db.prepare('SELECT src, dst, role FROM edge ORDER BY src, dst, role').all()),
    forks: rowsOrEmpty(() => db.prepare('SELECT node, copied_from AS copiedFrom, at FROM fork ORDER BY node').all()),
    versions: rowsOrEmpty(() => db.prepare(`
      SELECT node, seq, parent_seq AS parentSeq, input_hash AS inputHash, op, op_version AS opVersion, payload_path AS payloadPath
      FROM node_version ORDER BY node, seq
    `).all())
  };
}

// 从文件重建投影：只读扫描 data/ 下的数据集、设计方案与设计版本，状态只从文件来。
// 索引不可用时也可以先算出图，再决定要不要 syncGraph。
export async function projectFromFiles(store) {
  const problems = [];
  // 契约校验的失败分两类：文件 schema 不对是 E_DATA_SCHEMA，其余是 E_DATA_RULE。
  const schemaProblems = [];
  const pushProblems = (rel, list) => {
    for (const problem of list) {
      const text = `${rel}: ${problem}`;
      if (/schema/i.test(problem)) schemaProblems.push(text);
      else problems.push(text);
    }
  };
  const nodes = [];
  const edges = [];
  const forks = [];
  const nodeIds = new Set();

  const addNode = (node) => {
    if (!node?.id) { problems.push('节点缺少 id'); return; }
    if (nodeIds.has(node.id)) { problems.push(`节点重复登记：${node.id}`); return; }
    nodeIds.add(node.id);
    nodes.push(node);
  };
  const addEdge = (src, dst, role) => {
    if (!edges.some(e => e.src === src && e.dst === dst && e.role === role)) edges.push({src, dst, role});
  };

  // 数据集：状态与来源以 dataset.json 为准。
  const datasets = [];
  for (const name of subdirs(path.join(store.dir, DATASET_DIR))) {
    try {
      const rel = datasetFile(name);
      const data = readJsonIfPresent(store, rel);
      if (!data) continue; // 只认 dataset.json，其他目录内容交给 layout 检查
      const bad = validateDataset(data);
      if (bad.length) { pushProblems(rel, bad); continue; }
      datasets.push({rel, dir: name, data});
    } catch (e) {
      problems.push(`${DATASET_DIR}/${name}: ${e.message}`);
    }
  }
  for (const {data, dir} of datasets) {
    const id = data.id || dir;
    addNode({id, kind: 'dataset', label: id, status: data.status});
    // 校正产生新数据集：新数据集派生自被校正的那份。
    for (const [i, correction] of (data.corrections || []).entries()) {
      if (!correction?.from) continue;
      if (typeof correction.from !== 'string') {
        problems.push(`${DATASET_DIR}/${dir}/dataset.json: corrections[${i}].from 需要数据集 id`);
        continue;
      }
      addEdge(correction.from, id, 'derived');
    }
  }

  // 设计方案：design.json 引用一个数据集；版本文件记录状态与复制来源。
  const designs = [];
  for (const scheme of subdirs(path.join(store.dir, DESIGN_DIR))) {
    const manifestRel = designFile(scheme);
    let manifest;
    try {
      manifest = readJsonIfPresent(store, manifestRel);
    } catch (e) {
      problems.push(`${manifestRel}: ${e.message}`);
      continue;
    }
    if (!manifest) {
      const seqs = versionSeqs(store, scheme);
      if (seqs.length) problems.push(`${manifestRel}: 缺少 design.json（有 ${seqs.length} 个版本文件）`);
      continue;
    }
    const bad = validateDesign(manifest);
    if (bad.length) { pushProblems(manifestRel, bad); continue; }
    if (manifest.scheme !== scheme) problems.push(`${manifestRel}: 方案 id 与目录不一致（目录为 ${scheme}）`);

    const versions = [];
    for (const seq of versionSeqs(store, scheme)) {
      const rel = designVersionFile(scheme, seq);
      let data;
      try {
        data = readJsonIfPresent(store, rel);
      } catch (e) {
        problems.push(`${rel}: ${e.message}`);
        continue;
      }
      if (!data) continue;
      const badVersion = validateDesignVersion(data);
      if (badVersion.length) { pushProblems(rel, badVersion); continue; }
      if (data.scheme !== manifest.scheme) problems.push(`${rel}: 方案 id 与 design.json 不一致`);
      if (data.seq !== seq) problems.push(`${rel}: 版本号与文件名不一致（文件名为 ${seq}）`);
      versions.push({seq, rel, data});
    }
    designs.push({scheme: manifest.scheme, manifest, versions});
  }

  for (const {scheme, manifest, versions} of designs) {
    // 设计方案的状态取当前（最大 seq）版本；没有版本文件时退回清单里的状态。
    const latestFile = versions.map(v => v.data).sort((a, b) => a.seq - b.seq).at(-1);
    const status = latestFile?.status || currentVersion(manifest)?.status || manifest.status || 'draft';
    addNode({id: scheme, kind: 'design', label: scheme, status});
    if (manifest.dataset) addEdge(manifest.dataset, scheme, 'derived');
    for (const {data} of versions) {
      if (!data.forkedFrom) continue;
      // 复制只在设计之间，且每条复制只登记一次（记录来源，之后互不影响）。
      if (!forks.some(f => f.node === scheme)) {
        forks.push({node: scheme, copiedFrom: data.forkedFrom.scheme});
      }
      addEdge(data.forkedFrom.scheme, scheme, 'fork');
    }
  }

  const {problems: graphIssues} = validateProjection({nodes, edges, forks});
  const all = [...problems, ...graphIssues];
  if (schemaProblems.length) {
    const detail = [...schemaProblems, ...all];
    throw fail('E_DATA_SCHEMA', `数据文件不符合契约：${schemaProblems.join('；')}`, {problems: detail});
  }
  if (all.length) {
    throw fail('E_DATA_RULE', `推导图不合法：${all.join('；')}`, {problems: all});
  }
  return syncGraph(store, {nodes, edges, forks});
}

function versionSeqs(store, scheme) {
  const dir = path.join(store.dir, DESIGN_DIR, scheme, 'versions');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map(name => /^(\d+)\.json$/.exec(name))
    .filter(Boolean)
    .map(m => Number(m[1]))
    .filter(seq => Number.isInteger(seq) && seq >= 1)
    .sort((a, b) => a - b);
}

// 只改索引里的投影状态，不动任何文件。
//
// 注意：这不是 markStale 的实现。权威状态在 data/ 下的 dataset.json 与设计版本文件里，
// 标「待复核」必须由能力层写文件（带 baseHash 与确认）；这里只是把文件里的结论投影到
// `.space/project.sqlite` 的 node.status 上，让工作台查询，不产生任何权威数据。
// 索引不存在时直接返回，绝不因为一次投影而「创造」索引。
export async function markStaleProjection(store, ids = []) {
  const requested = [...new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean))];
  if (!requested.length) return {updated: 0, stale: [], skipped: []};

  const index = store.derived('index');
  if (!index.exists()) {
    return {updated: 0, stale: [], skipped: requested.map(id => ({id, reason: '索引不存在'}))};
  }

  const db = await openIndex(index);
  let plan;
  try {
    applySchema(db);
    const known = listNodes(db).filter(row => requested.includes(row.id));
    const knownIds = new Set(known.map(row => row.id));
    // 状态机由领域层判定：草稿无需标记，已作废保持，已待复核不重复标。
    plan = planStale({affected: known.map(row => row.id), nodes: known});
    for (const id of requested) {
      if (!knownIds.has(id)) plan.skipped.push({id, reason: '索引里未登记'});
    }
    db.exec('BEGIN');
    try {
      const update = db.prepare('UPDATE node SET status = ? WHERE id = ?');
      let changed = 0;
      for (const item of plan.stale) changed += Number(update.run(item.to, item.id).changes || 0);
      plan.updated = changed;
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  } finally {
    closeIndex(db);
  }

  const updated = plan.updated ?? plan.stale.length;
  index.commit({op: 'graph.markStale', summary: {updated, requested: requested.length}});
  return {updated, stale: plan.stale, skipped: plan.skipped};
}
