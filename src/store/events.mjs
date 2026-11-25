// L2 存储：事件日志。只追加，不重写；一次写入一条记录。
import fs from 'node:fs';
import path from 'node:path';
import {ensureDir, readText, writeJsonAtomic} from './atomic.mjs';

const MAX_TAIL_BYTES = 256 * 1024;

export function eventFile(dir) {
  return path.join(dir, '.space', 'events.jsonl');
}

export function registryFile(dir) {
  return path.join(dir, '.space', 'files.json');
}

function lastSeq(file) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (Number.isFinite(e.seq)) return e.seq;
      } catch {}
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// 项目锁：同一项目串行写。进程异常退出留下的锁超过 staleMs 视为可回收。
export function withProjectLock(dir, fn, {staleMs = 60_000} = {}) {
  const lock = path.join(dir, '.space', 'write.lock');
  ensureDir(path.dirname(lock));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, JSON.stringify({pid: process.pid, at: new Date().toISOString()}));
      fs.closeSync(fd);
      try { return fn(); } finally { try { fs.rmSync(lock, {force: true}); } catch {} }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try { stale = Date.now() - fs.statSync(lock).mtimeMs > staleMs; } catch { stale = true; }
      if (!stale || attempt === 1) {
        const err = new Error('同一项目有未完成的写入');
        err.code = 'E_STORE_BUSY';
        throw err;
      }
      try { fs.rmSync(lock, {force: true}); } catch {}
    }
  }
  throw new Error('无法获得项目写锁');
}

export function appendEvent(dir, event) {
  const file = eventFile(dir);
  ensureDir(path.dirname(file));
  const seq = lastSeq(file) + 1;
  const record = {schema: 'space-events/v1', ...event, seq, at: event.at || new Date().toISOString()};
  const line = JSON.stringify(record) + '\n';
  const fd = fs.openSync(file, 'a');
  try { fs.writeSync(fd, line); } finally { fs.closeSync(fd); }
  return record;
}

export function readEvents(dir, {limit} = {}) {
  const file = eventFile(dir);
  if (!fs.existsSync(file)) return [];
  const lines = readText(file).split('\n').filter(Boolean);
  const picked = Number.isFinite(limit) && limit > 0 ? lines.slice(-limit) : lines;
  const out = [];
  for (const line of picked) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

export function writeRegistry(dir, registry) {
  return writeJsonAtomic(registryFile(dir), registry);
}

export function emptyRegistry(projectId) {
  return {schema: 'space-files/v1', project: projectId || null, updatedAt: new Date().toISOString(), files: {}};
}
