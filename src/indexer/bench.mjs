#!/usr/bin/env node
// 索引验收基准：把 roadmap 里的数字变成可复现的命令，而不是靠一次性的手测。
// 用法：npm run bench:index（退出码 1 表示没达标）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from '../store/index.mjs';
import {writeFileAtomic} from '../store/atomic.mjs';
import {buildIndex, closeReadHandles, queryIndex} from './index.mjs';

const COUNT = Number(process.env.SPACE_BENCH_ENTITIES || 50000);
const PAGE = 5000;
const LIMITS = {cacheParseMs: 50, queryP50Ms: 5};

function synthetic(count) {
  const entities = [];
  for (let i = 0; i < count; i++) {
    const x = (i % 250) * 1000, y = Math.floor(i / 250) * 1000;
    entities.push({id: `E${i}`, type: i % 3 ? 'LINE' : 'TEXT', layer: ['WALL', 'DIM', 'FURN'][i % 3], points: [[x, y], [x + 900, y + 400]]});
  }
  return entities;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'space-bench-index-'));
  const projectFile = path.join(dir, 'project.json');
  writeFileAtomic(projectFile, JSON.stringify({schema: 'space-project/v1', id: 'bench-index', output: 'output'}, null, 2));
  fs.mkdirSync(path.join(dir, 'source/drawings'), {recursive: true});
  writeFileAtomic(path.join(dir, 'source/drawings/bench.dxf'), 'synthetic-dxf');
  const store = openStore(projectFile);

  const entities = synthetic(COUNT);
  let parses = 0;
  const parse = async () => {
    parses += 1;
    return {schema: 'cad-source/v1', source: {file: 'bench.dxf'}, entities, issues: []};
  };

  const rows = [];
  try {
    const first = await buildIndex(store, {source: 'source/drawings/bench.dxf', parse});
    rows.push(['首次构建（解析 + 建索引）', `${first.ms}ms`, `解析 ${first.parseMs}ms · 索引 ${first.indexMs}ms`, '参考值']);

    const cached = await buildIndex(store, {source: 'source/drawings/bench.dxf', parse});
    rows.push(['解析缓存命中', `${cached.parseMs}ms`, `解析调用 ${parses} 次`, `< ${LIMITS.cacheParseMs}ms`]);

    const query = {dataset: first.dataset, box: [0, 0, 250000, 20000], limit: PAGE};
    for (let i = 0; i < 3; i++) await queryIndex(store, query); // 预热：开库、准备语句、page cache
    const samples = [], totals = [];
    for (let i = 0; i < 25; i++) {
      const started = performance.now();
      const page = await queryIndex(store, query);
      samples.push(performance.now() - started);
      totals.push(page.rows.length);
    }
    if (!totals.every(n => n === PAGE)) throw new Error(`查询返回 ${totals[0]} 条，预期 ${PAGE} 条`);
    rows.push([`包围盒查询 ${PAGE} 条`, `p50 ${median(samples).toFixed(2)}ms`, `p95 ${p95(samples).toFixed(2)}ms`, `< ${LIMITS.queryP50Ms}ms（p50）`]);

    // 删掉索引文件，重建不应重新解析
    for (const name of fs.readdirSync(path.join(dir, '.space'))) {
      if (name.startsWith('project.sqlite')) fs.rmSync(path.join(dir, '.space', name), {force: true});
    }
    closeReadHandles();
    const rebuilt = await buildIndex(store, {source: 'source/drawings/bench.dxf', parse});
    rows.push(['删索引后重建', `${rebuilt.ms}ms`, `命中缓存 ${rebuilt.cacheHit} · 解析调用 ${parses} 次`, '不重新解析']);
  } finally {
    closeReadHandles();
    fs.rmSync(dir, {recursive: true, force: true});
  }

  const width = Math.max(...rows.map(r => r[0].length));
  console.log(`索引基准：${COUNT} 个图元\n`);
  for (const [name, value, detail, limit] of rows) {
    console.log(`  ${name.padEnd(width)}  ${value.padEnd(14)} ${detail.padEnd(28)} ${limit}`);
  }

  const failures = [];
  const cacheRow = rows.find(r => r[0] === '解析缓存命中');
  if (Number.parseFloat(cacheRow[1]) >= LIMITS.cacheParseMs) failures.push(`解析缓存命中 ${cacheRow[1]} ≥ ${LIMITS.cacheParseMs}ms`);
  const queryRow = rows.find(r => r[0].startsWith('包围盒查询'));
  if (Number.parseFloat(queryRow[1].replace('p50 ', '')) >= LIMITS.queryP50Ms) failures.push(`包围盒查询 ${queryRow[1]} ≥ ${LIMITS.queryP50Ms}ms`);
  if (parses !== 1) failures.push(`解析被调用 ${parses} 次，应只解析一次`);

  if (failures.length) {
    console.log('\n未达标：');
    for (const f of failures) console.log('  ' + f);
    process.exitCode = 1;
    return;
  }
  console.log('\n达标。');
}

main().catch(e => {
  console.error('基准失败：' + e.message);
  process.exitCode = 1;
});
