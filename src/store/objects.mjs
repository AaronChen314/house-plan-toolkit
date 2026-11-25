// L2 存储：内容寻址。解析产物与导出包按哈希保存，可去重、可校验、可重建。
import fs from 'node:fs';
import path from 'node:path';
import {ensureDir, sha256, writeFileAtomic} from './atomic.mjs';

export function objectsDir(dir) {
  return path.join(dir, '.space', 'objects');
}

export function objectPath(dir, digest) {
  if (!/^[0-9a-f]{64}$/.test(String(digest))) throw new Error('对象哈希格式不合法：' + digest);
  return path.join(objectsDir(dir), digest.slice(0, 2), digest);
}

export function putObject(dir, buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8');
  const digest = sha256(buf);
  const file = objectPath(dir, digest);
  if (fs.existsSync(file)) return {sha256: digest, rel: relOf(dir, file), deduped: true};
  ensureDir(path.dirname(file));
  writeFileAtomic(file, buf);
  return {sha256: digest, rel: relOf(dir, file), deduped: false};
}

export function getObject(dir, digest) {
  const file = objectPath(dir, digest);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

export function objectStats(dir) {
  const base = objectsDir(dir);
  let count = 0, bytes = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, {withFileTypes: true}); } catch { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else { count++; try { bytes += fs.statSync(abs).size; } catch {} }
    }
  };
  walk(base);
  return {count, bytes};
}

export function relOf(dir, abs) {
  return path.relative(dir, abs).split(path.sep).join('/');
}
