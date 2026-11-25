// L2 索引：只读全局索引（跨项目摘要）。
// 位置在项目之外（默认 ~/.cache/house-plan/index.sqlite），只存计数与路径，
// 不复制几何；删掉可重建，也不参与发布物。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fail} from '../contracts/errors.mjs';
import {globalRecord, normalizeQuery, validateGlobalRecord} from '../contracts/global-index.mjs';
import {VERSION} from '../root.mjs';
import {ensureDir} from '../store/atomic.mjs';
import {loadSqlite} from './db.mjs';
import {statIndexFor} from './build.mjs';

export function globalIndexFile({override = process.env.SPACE_GLOBAL_INDEX, home = os.homedir()} = {}) {
  return override ? path.resolve(override) : path.join(home, '.cache', 'house-plan', 'index.sqlite');
}

const DDL = `
CREATE TABLE IF NOT EXISTS project (
  project_id TEXT PRIMARY KEY,
  name TEXT,
  path TEXT NOT NULL,
  toolkit TEXT,
  entities INTEGER NOT NULL DEFAULT 0,
  layers INTEGER NOT NULL DEFAULT 0,
  datasets INTEGER NOT NULL DEFAULT 0,
  designs INTEGER NOT NULL DEFAULT 0,
  documents INTEGER NOT NULL DEFAULT 0,
  renders INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS project_name ON project(name);
`;

let handle;

export async function openGlobal({create = true, file = globalIndexFile()} = {}) {
  const mod = await loadSqlite();
  if (!mod) return {available: false, reason: 'node:sqlite 不可用（需要 Node 22.5+）', file};
  if (!create && !fs.existsSync(file)) return {available: false, reason: '全局索引尚未建立', file};
  ensureDir(path.dirname(file));
  if (!handle || handle.file !== file) {
    try { handle?.db.close(); } catch {}
    const db = new mod.DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(DDL);
    handle = {file, db};
  }
  return {available: true, db: handle.db, file};
}

export function closeGlobal() {
  try { handle?.db.close(); } catch {}
  handle = undefined;
}

function counts(store) {
  const files = Object.keys(store.files().files || {});
  const count = (re) => files.filter(rel => re.test(rel)).length;
  return {
    datasets: count(/^data\/datasets\/[^/]+\/dataset\.json$/),
    designs: count(/^data\/designs\/[^/]+\/design\.json$/),
    documents: count(/^output\/doc\/[^/]+\/[^/]+\.svg$/),
    renders: count(/^output\/render\/[^/]+\/[^/]+\.svg$/)
  };
}

// 同步一个项目：从项目内索引与文件登记里取摘要，不读几何。
export async function syncGlobal(store) {
  const opened = await openGlobal();
  if (!opened.available) throw fail('E_EXEC_DEPENDENCY', opened.reason, {file: opened.file});
  const stat = await statIndexFor(store);
  const record = globalRecord({
    projectId: store.projectId,
    name: store.project?.name ?? null,
    path: store.dir,
    toolkit: VERSION,
    updatedAt: new Date().toISOString(),
    entities: stat.present ? stat.entities : 0,
    layers: stat.present ? stat.layers : 0,
    ...counts(store)
  });
  const problems = validateGlobalRecord(record);
  if (problems.length) throw fail('E_DATA_INVALID', problems.join('；'), {problems});
  opened.db.prepare(`
    INSERT INTO project (project_id, name, path, toolkit, entities, layers, datasets, designs, documents, renders, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      name = excluded.name, path = excluded.path, toolkit = excluded.toolkit,
      entities = excluded.entities, layers = excluded.layers, datasets = excluded.datasets,
      designs = excluded.designs, documents = excluded.documents, renders = excluded.renders,
      updated_at = excluded.updated_at
  `).run(record.projectId, record.name, record.path, record.toolkit, record.entities, record.layers,
    record.datasets, record.designs, record.documents, record.renders, record.updatedAt);
  return {record, file: opened.file};
}

export async function listGlobal({q = '', limit = 50} = {}) {
  const opened = await openGlobal({create: false});
  if (!opened.available) return {available: false, reason: opened.reason, rows: []};
  const term = `%${normalizeQuery(q)}%`;
  const rows = opened.db.prepare(`
    SELECT project_id AS projectId, name, path, toolkit, entities, layers, datasets, designs, documents, renders, updated_at AS updatedAt
    FROM project
    WHERE project_id LIKE ? OR IFNULL(name, '') LIKE ? OR path LIKE ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(term, term, term, Math.max(1, Math.min(500, Number(limit) || 50)));
  return {available: true, file: opened.file, rows};
}

export async function statGlobal() {
  const opened = await openGlobal({create: false});
  if (!opened.available) return {available: false, reason: opened.reason, file: opened.file, projects: 0};
  const row = opened.db.prepare('SELECT COUNT(*) AS n, SUM(entities) AS entities, MAX(updated_at) AS updatedAt FROM project').get();
  return {
    available: true,
    file: opened.file,
    projects: Number(row.n || 0),
    entities: Number(row.entities || 0),
    updatedAt: row.updatedAt || null
  };
}
