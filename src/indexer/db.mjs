// L2 索引：数据库连接。node:sqlite 在 Node 22.5+ 才可用；低版本不报死，
// 而是让调用方降级为「每次解析」，由 space doctor 提示升级。
import fs from 'node:fs';
import path from 'node:path';
import {fail} from '../contracts/errors.mjs';
import {ensureDir} from '../store/atomic.mjs';

// 索引依赖 node:sqlite；工具包本身仍支持 Node 20，索引需要 22.5+。
// 这个常量是唯一事实源，doctor、version 与报错信息都引用它。
export const INDEX_NODE_MIN = '22.5.0';

let loaded;

export async function loadSqlite() {
  if (loaded !== undefined) return loaded;
  try {
    const mod = await import('node:sqlite');
    loaded = typeof mod?.DatabaseSync === 'function' ? mod : null;
  } catch {
    loaded = null;
  }
  return loaded;
}

export async function sqliteAvailable() {
  return (await loadSqlite()) !== null;
}

// 打开索引：文件由派生存储提供位置，这里只负责建库与 PRAGMA。
export async function openIndex(derived, {create = true} = {}) {
  const mod = await loadSqlite();
  if (!mod) {
    throw fail('E_EXEC_DEPENDENCY', `几何索引需要 Node ${INDEX_NODE_MIN} 以上（node:sqlite）`, {node: process.versions.node, indexNodeMin: INDEX_NODE_MIN, fix: '升级 Node，或按「不支持索引」继续使用每次解析'});
  }
  if (!create && !fs.existsSync(derived.path)) return null;
  ensureDir(path.dirname(derived.path));
  const db = new mod.DatabaseSync(derived.path);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  return db;
}

export function closeIndex(db) {
  try { db?.close(); } catch {}
}

// 读句柄复用：工作台连续取视口时不必每次开库、每次准备语句。
// 键里带 mtime/size/inode，重建或删除索引后自动换新句柄，不会读到旧数据。
const readHandles = new Map();

async function connect(file) {
  const mod = await loadSqlite();
  if (!mod) return null;
  const db = new mod.DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  return db;
}

export async function openIndexRead(derived) {
  const file = derived.path;
  let key;
  try {
    const st = fs.statSync(file);
    key = `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    const cached = readHandles.get(file);
    if (cached) { closeIndex(cached.db); readHandles.delete(file); }
    return null;
  }
  const cached = readHandles.get(file);
  if (cached?.key === key) return {db: cached.db, reused: true};
  if (cached) { closeIndex(cached.db); readHandles.delete(file); }
  const db = await connect(file);
  if (!db) return null;
  readHandles.set(file, {key, db});
  return {db, reused: false};
}

export function closeReadHandles() {
  for (const [, {db}] of readHandles) closeIndex(db);
  readHandles.clear();
}

export function fileBytes(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}
