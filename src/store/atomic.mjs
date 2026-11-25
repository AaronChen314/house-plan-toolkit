// L2 存储：原子写入与读写工具。临时文件与目标同目录，改名提交；
// 中断只会留下可清理的临时文件，不会留下半截目标文件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TEMP_PREFIX = '.tmp-';

export function ensureDir(dir) {
  fs.mkdirSync(dir, {recursive: true});
  return dir;
}

export function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

export function readJson(file) {
  return JSON.parse(readText(file));
}

export function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// 同目录临时文件 + fsync + rename。失败时清掉临时文件，目标保持原样。
export function writeFileAtomic(file, content) {
  const dir = ensureDir(path.dirname(file));
  const tmp = path.join(dir, `${TEMP_PREFIX}${path.basename(file)}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o644);
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    return file;
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.rmSync(tmp, {force: true}); } catch {}
    throw e;
  }
}

export function writeJsonAtomic(file, value, {pretty = true} = {}) {
  return writeFileAtomic(file, JSON.stringify(value, null, pretty ? 2 : 0) + (pretty ? '\n' : ''));
}

// 扫描残留临时文件：正常结束后应为空，verify 会报告并允许清理。
export function tempLeftovers(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      tempLeftovers(abs, out);
    } else if (e.name.startsWith(TEMP_PREFIX)) {
      out.push(abs);
    }
  }
  return out;
}

export function removeQuietly(file) {
  try { fs.rmSync(file, {force: true}); } catch {}
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

export function walkFiles(dir, base = dir, out = [], {skip = []} = {}) {
  let entries;
  try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (skip.includes(e.name)) continue;
      walkFiles(path.join(dir, e.name), base, out, {skip});
    } else if (e.isFile()) {
      out.push(toPosix(path.relative(base, path.join(dir, e.name))));
    }
  }
  return out;
}
