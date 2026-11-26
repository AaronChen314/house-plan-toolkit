// L2 索引：解析缓存。键 = 源文件哈希 + 解析器标识与版本 + 参数；
// 命中直接读缓存，不重跑解析。缓存文件是派生物，写在 .space/cache/。
import fs from 'node:fs';
import path from 'node:path';
import {sha256, writeFileAtomic} from '../store/atomic.mjs';

// 改了 read.py 的输出行为就升 version：缓存键包含它，旧产物自动失效。
export const PARSER = {id: 'cad.read', version: '3'};

export function cacheKey({sourceSha256, parser = PARSER, params = {}}) {
  if (!/^[0-9a-f]{64}$/.test(String(sourceSha256))) throw new Error('sourceSha256 格式不合法');
  const normalizedParams = Object.keys(params).sort().reduce((acc, key) => {
    acc[key] = params[key];
    return acc;
  }, {});
  return sha256(JSON.stringify({schema: 'space-parse-cache/v1', source: sourceSha256, parser, params: normalizedParams}));
}

export function cacheFile(derived, key) {
  return path.join(derived.path, `${key}.json`);
}

export function readParseCache(derived, key) {
  const file = cacheFile(derived, key);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data?.schema === 'space-parse-cache/v1' ? data : null;
  } catch {
    return null;
  }
}

export function writeParseCache(derived, key, payload) {
  const record = {
    schema: 'space-parse-cache/v1',
    key,
    parser: payload.parser || PARSER,
    params: payload.params || {},
    sourceSha256: payload.sourceSha256,
    parsedAt: new Date().toISOString(),
    data: payload.data
  };
  writeFileAtomic(cacheFile(derived, key), JSON.stringify(record));
  return {file: cacheFile(derived, key), key, entities: record.data?.entities?.length ?? 0};
}

export function pruneCache(derived, {keep = 20} = {}) {
  let entries;
  try { entries = fs.readdirSync(derived.path); } catch { return {removed: 0}; }
  const files = entries
    .filter(name => name.endsWith('.json') && /^[0-9a-f]{64}\.json$/.test(name))
    .map(name => ({name, at: fs.statSync(path.join(derived.path, name)).mtimeMs}))
    .sort((a, b) => b.at - a.at);
  let removed = 0;
  for (const f of files.slice(keep)) {
    fs.rmSync(path.join(derived.path, f.name), {force: true});
    removed += 1;
  }
  return {removed};
}
