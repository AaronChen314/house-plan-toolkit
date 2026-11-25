// L2 索引：图元写入与包围盒查询。只存包围盒，完整几何仍以 cad-source JSON 为准。
import {fail} from '../contracts/errors.mjs';
import {pageOf, normalizeQuery} from '../contracts/index-query.mjs';

export function entityBox(entity) {
  if (entity && ['minx', 'miny', 'maxx', 'maxy'].every(k => Number.isFinite(entity[k]))) {
    return [entity.minx, entity.miny, entity.maxx, entity.maxy];
  }
  const points = entity?.points?.filter(p => Array.isArray(p) && p.length >= 2 && p.every(v => Number.isFinite(v)));
  if (!points?.length) return null;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of points) {
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
  }
  return [minx, miny, maxx, maxy];
}

export function clearDataset(db, dataset) {
  db.exec('BEGIN');
  try {
    // 一条语句清 rtree 再清实体；逐行删除在五万图元上要慢两个数量级。
    db.prepare('DELETE FROM entity_rtree WHERE id IN (SELECT id FROM entity WHERE dataset = ?)').run(dataset);
    const removed = db.prepare('DELETE FROM entity WHERE dataset = ?').run(dataset);
    db.exec('COMMIT');
    return {removed: Number(removed.changes || 0)};
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

// 一个数据集一次事务批量写入；包围盒同时进 rtree。
export function insertEntities(db, {dataset, entities}) {
  if (!dataset) throw fail('E_EXEC_PARAM', '写入索引需要 dataset');
  const insert = db.prepare('INSERT INTO entity (dataset, handle, type, layer, minx, miny, maxx, maxy, geom) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)');
  const rtree = db.prepare('INSERT INTO entity_rtree (id, minx, maxx, miny, maxy) VALUES (?, ?, ?, ?, ?)');
  let written = 0, skipped = 0;

  db.exec('BEGIN');
  try {
    for (const entity of entities) {
      const box = entityBox(entity);
      if (!box) { skipped += 1; continue; }
      const info = insert.run(dataset, entity.handle ?? entity.id ?? null, entity.type ?? null, entity.layer ?? null, box[0], box[1], box[2], box[3]);
      rtree.run(info.lastInsertRowid, box[0], box[2], box[1], box[3]);
      written += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
  return {written, skipped};
}

// 语句缓存：工作台连续取视口时，同一条 SQL 不必每次重新 prepare。
const stmtCache = new WeakMap();

function prepare(db, sql) {
  let cache = stmtCache.get(db);
  if (!cache) { cache = new Map(); stmtCache.set(db, cache); }
  let stmt = cache.get(sql);
  if (!stmt) { stmt = db.prepare(sql); cache.set(sql, stmt); }
  return stmt;
}

export function queryEntities(db, rawQuery = {}) {
  const q = normalizeQuery(rawQuery);
  if (q.problems.length) throw fail('E_EXEC_PARAM', q.problems.join('；'));

  const where = [];
  const params = [];
  if (q.dataset) { where.push('e.dataset = ?'); params.push(q.dataset); }
  if (q.box) {
    where.push('r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?');
    params.push(q.box[0], q.box[2], q.box[1], q.box[3]);
  }
  if (q.layers.length) { where.push(`e.layer IN (${q.layers.map(() => '?').join(', ')})`); params.push(...q.layers); }
  if (q.types.length) { where.push(`e.type IN (${q.types.map(() => '?').join(', ')})`); params.push(...q.types); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // 多取一行判断还有没有下一页；总数只在显式要 count 时才算。
  const probe = prepare(db, `
    SELECT e.handle, e.type, e.layer, e.minx, e.miny, e.maxx, e.maxy
    FROM entity e JOIN entity_rtree r ON r.id = e.id
    ${clause}
    ORDER BY e.id
    LIMIT ? OFFSET ?
  `).all(...params, q.limit + 1, q.offset);

  const hasMore = probe.length > q.limit;
  if (hasMore) probe.pop();
  const total = q.count
    ? Number(prepare(db, `SELECT COUNT(*) AS n FROM entity e JOIN entity_rtree r ON r.id = e.id ${clause}`).get(...params).n)
    : null;

  // node:sqlite 直接返回普通对象，不再逐行复制。
  return {...pageOf(probe, {limit: q.limit, offset: q.offset, total, hasMore}), dataset: q.dataset};
}

// M1 最小节点登记：数据集先进 node 表，M2 的校正/设计才有地方挂边。
export function registerNode(db, {id, kind, label, status = 'draft', projectId = null}) {
  if (!id || !kind) throw fail('E_EXEC_PARAM', '登记节点需要 id 与 kind');
  db.prepare(`
    INSERT INTO node (id, project_id, kind, label, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, kind = excluded.kind, label = excluded.label, status = excluded.status
  `).run(id, projectId, kind, label ?? null, status, new Date().toISOString());
  return {id, kind, label, status};
}

export function listNodes(db, {kind} = {}) {
  const where = kind ? 'WHERE kind = ?' : '';
  return db.prepare(`SELECT id, project_id, kind, label, status, created_at FROM node ${where} ORDER BY kind, id`)
    .all(...(kind ? [kind] : []));
}

export function nodeCounts(db) {
  const rows = db.prepare('SELECT kind, COUNT(*) AS n FROM node GROUP BY kind').all();
  return Object.fromEntries(rows.map(r => [r.kind, Number(r.n)]));
}

export function statIndex(db, {dataset} = {}) {
  const where = dataset ? 'WHERE dataset = ?' : '';
  const params = dataset ? [dataset] : [];
  const entities = db.prepare(`SELECT COUNT(*) AS n FROM entity ${where}`).get(...params).n;
  const layers = db.prepare(`SELECT COUNT(DISTINCT layer) AS n FROM entity ${where}`).get(...params).n;
  const types = db.prepare(`SELECT COUNT(DISTINCT type) AS n FROM entity ${where}`).get(...params).n;
  const bounds = db.prepare(`SELECT MIN(minx) AS minx, MIN(miny) AS miny, MAX(maxx) AS maxx, MAX(maxy) AS maxy FROM entity ${where}`).get(...params);
  return {
    entities: Number(entities),
    layers: Number(layers),
    types: Number(types),
    bounds: Number.isFinite(bounds?.minx) ? [bounds.minx, bounds.miny, bounds.maxx, bounds.maxy] : null,
    nodes: nodeCounts(db)
  };
}

export function layerNames(db, {dataset} = {}) {
  const where = dataset ? 'WHERE dataset = ?' : '';
  return db.prepare(`SELECT layer, COUNT(*) AS n FROM entity ${where} GROUP BY layer ORDER BY n DESC`).all(...(dataset ? [dataset] : [])).map(r => ({layer: r.layer, entities: Number(r.n)}));
}
