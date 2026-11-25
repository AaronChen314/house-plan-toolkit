// L2 索引：SQLite schema。索引是派生数据，删掉能重建，不进文件登记。
// 与 docs/architecture.md 的示意一致，唯一差异是 entity 增加了整数主键 id：
// rtree 虚表需要整数 rowid，而业务主键仍是 (dataset, handle)。
export const INDEX_VERSION = 1;

export const DDL = [
  'PRAGMA journal_mode=WAL',
  'PRAGMA foreign_keys=ON',

  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS node (
     id TEXT PRIMARY KEY,
     project_id TEXT,
     kind TEXT NOT NULL,
     label TEXT,
     status TEXT NOT NULL DEFAULT 'draft',
     created_at TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS edge (
     src TEXT NOT NULL,
     dst TEXT NOT NULL,
     role TEXT NOT NULL,
     PRIMARY KEY (src, dst, role)
   )`,

  `CREATE TABLE IF NOT EXISTS node_version (
     node TEXT NOT NULL,
     seq INTEGER NOT NULL,
     parent_seq INTEGER,
     input_hash TEXT,
     op TEXT,
     op_version TEXT,
     payload_path TEXT,
     PRIMARY KEY (node, seq)
   )`,

  `CREATE TABLE IF NOT EXISTS fork (
     node TEXT PRIMARY KEY,
     copied_from TEXT NOT NULL,
     at TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS entity (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     dataset TEXT NOT NULL,
     handle TEXT,
     type TEXT,
     layer TEXT,
     minx REAL NOT NULL,
     maxx REAL NOT NULL,
     miny REAL NOT NULL,
     maxy REAL NOT NULL,
     geom BLOB
   )`,

  'CREATE INDEX IF NOT EXISTS entity_dataset ON entity(dataset)',
  'CREATE INDEX IF NOT EXISTS entity_layer ON entity(dataset, layer)',
  'CREATE INDEX IF NOT EXISTS entity_handle ON entity(dataset, handle)',

  `CREATE VIRTUAL TABLE IF NOT EXISTS entity_rtree USING rtree(id, minx, maxx, miny, maxy)`,

  `CREATE TABLE IF NOT EXISTS event (
     id INTEGER PRIMARY KEY,
     at TEXT,
     op TEXT,
     node TEXT,
     params TEXT,
     inputs TEXT,
     outputs TEXT,
     actor TEXT
   )`
];

export function applySchema(db) {
  for (const sql of DDL) db.exec(sql);
  const current = schemaVersion(db);
  if (current === null) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('index_version', String(INDEX_VERSION));
  } else if (current > INDEX_VERSION) {
    const err = new Error(`索引由更新版本的工具包创建（${current} > ${INDEX_VERSION}）`);
    err.code = 'E_DATA_SCHEMA';
    throw err;
  }
  return {version: schemaVersion(db), created: current === null};
}

// 整表重建比逐行删除快一个数量级：rtree 的逐行删除在五万图元上要 200ms+。
export function recreateEntityTables(db) {
  db.exec('DROP TABLE IF EXISTS entity_rtree');
  db.exec('DROP TABLE IF EXISTS entity');
  for (const sql of DDL) {
    if (/CREATE (TABLE|INDEX|VIRTUAL TABLE)[^;]*\b(entity|entity_rtree)\b/.test(sql)) db.exec(sql);
  }
}

export function datasetNames(db) {
  return db.prepare('SELECT DISTINCT dataset FROM entity').all().map(r => r.dataset);
}

export function schemaVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'index_version'").get();
    return row ? Number(row.value) : null;
  } catch {
    return null; // 空库或旧库：交给 applySchema 建立
  }
}
