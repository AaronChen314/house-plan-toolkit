import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from '../src/store/index.mjs';
import {
  buildIndex, queryIndex, statIndexFor, layersIndex, datasetIdFor,
  sqliteAvailable, openIndex, applySchema, schemaVersion, INDEX_VERSION,
  insertEntities, queryEntities, entityBox, cacheKey, PARSER
} from '../src/indexer/index.mjs';

const available = await sqliteAvailable();
const skip = available ? false : 'node:sqlite 不可用（需要 Node 22.5+）';

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-index-'));
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({schema: 'space-project/v1', id: 'index-demo', output: 'output'}, null, 2));
  fs.mkdirSync(path.join(dir, 'source/drawings'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'source/drawings/plan.dxf'), 'synthetic-dxf');
  return {dir, store: openStore(path.join(dir, 'project.json'))};
}

// 合成图元：250 列 × 200 行 = 50000 条，包围盒 900×400mm。
function synthetic(count = 50000) {
  const entities = [];
  for (let i = 0; i < count; i++) {
    const x = (i % 250) * 1000, y = Math.floor(i / 250) * 1000;
    entities.push({id: `E${i}`, type: i % 3 ? 'LINE' : 'TEXT', layer: ['WALL', 'DIM', 'FURN'][i % 3], points: [[x, y], [x + 900, y + 400]]});
  }
  return entities;
}

function parserFor(entities, counter) {
  return async () => {
    if (counter) counter.calls += 1;
    return {schema: 'cad-source/v1', source: {file: 'plan.dxf'}, entities, issues: []};
  };
}

test('SQLite 可用性可自检，不可用时降级而不是崩溃', async () => {
  assert.equal(typeof available, 'boolean');
  const {store} = tempProject();
  const stat = await statIndexFor(store);
  assert.equal(stat.available, available);
  const q = await queryIndex(store, {box: [0, 0, 10, 10]});
  assert.equal(q.available, false, '没有索引时查询返回不可用');
  assert.deepEqual(q.rows, []);
});

test('索引 schema：版本写入 meta，重复应用幂等', {skip}, async () => {
  const {store} = tempProject();
  const db = await openIndex(store.derived('index'));
  try {
    assert.equal(schemaVersion(db), null);
    assert.deepEqual(applySchema(db), {version: INDEX_VERSION, created: true});
    assert.equal(schemaVersion(db), INDEX_VERSION);
    assert.equal(applySchema(db).created, false, '第二次应用不应重建');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual table')").all().map(r => r.name);
    for (const name of ['entity', 'entity_rtree', 'node', 'edge', 'node_version', 'fork', 'event', 'meta']) assert.ok(tables.includes(name), `缺少表 ${name}`);
  } finally {
    db.close();
  }
});

test('包围盒提取：显式包围盒优先，点集退化为包围盒，无坐标跳过', {skip}, () => {
  assert.deepEqual(entityBox({minx: 0, miny: 1, maxx: 2, maxy: 3}), [0, 1, 2, 3]);
  assert.deepEqual(entityBox({points: [[0, 0], [10, 5], [-5, 20]]}), [-5, 0, 10, 20]);
  assert.equal(entityBox({points: []}), null);
  assert.equal(entityBox({}), null);
  assert.equal(entityBox({points: [['a', 1]]}), null);
});

test('解析缓存键：同源同参数稳定，解析器或参数变化即不同', () => {
  const sha = 'a'.repeat(64);
  const k1 = cacheKey({sourceSha256: sha, params: {box: [0, 0, 1, 1]}});
  const k2 = cacheKey({sourceSha256: sha, params: {box: [0, 0, 1, 1]}});
  const k3 = cacheKey({sourceSha256: sha, params: {box: [0, 0, 2, 2]}});
  const k4 = cacheKey({sourceSha256: sha, parser: {id: PARSER.id, version: '2'}});
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
  assert.notEqual(k1, k4);
  assert.throws(() => cacheKey({sourceSha256: 'nope'}), /格式不合法/);
});

test('构建索引：写入、缓存命中、不重复解析', {skip}, async () => {
  const {store} = tempProject();
  const counter = {calls: 0};
  const entities = synthetic(1000);
  const first = await buildIndex(store, {source: 'source/drawings/plan.dxf', parse: parserFor(entities, counter)});
  assert.equal(first.entities, 1000);
  assert.equal(first.cacheHit, false);
  assert.equal(counter.calls, 1);
  assert.equal(first.dataset, datasetIdFor(first.sourceSha256));

  const second = await buildIndex(store, {source: 'source/drawings/plan.dxf', parse: parserFor(entities, counter)});
  assert.equal(second.cacheHit, true);
  assert.equal(counter.calls, 1, '命中缓存后不应再解析');
  assert.equal(second.entities, 1000);
  assert.equal(second.skipped, 0);

  const events = store.events().filter(e => e.type === 'derived');
  assert.equal(events.length, 2, '每次重建一条汇总事件');
  assert.equal(events.at(-1).summary.cacheHit, true);
  assert.equal(store.files().files['.space/project.sqlite'], undefined, '索引不进文件登记');
  assert.equal(store.verify().ok, true);
});

test('无坐标图元被跳过并记录数量', {skip}, async () => {
  const {store} = tempProject();
  const entities = [{id: 'A', points: [[0, 0], [1, 1]]}, {id: 'B'}, {id: 'C', points: []}];
  const r = await buildIndex(store, {source: 'source/drawings/plan.dxf', parse: parserFor(entities)});
  assert.equal(r.entities, 1);
  assert.equal(r.skipped, 2);
});

test('包围盒查询：命中范围、分页游标、图层与类型过滤', {skip}, async () => {
  const {store} = tempProject();
  const entities = synthetic(1000);
  const built = await buildIndex(store, {source: 'source/drawings/plan.dxf', parse: parserFor(entities)});

  const page = await queryIndex(store, {dataset: built.dataset, box: [0, 0, 2500, 1000], limit: 5});
  assert.equal(page.available, true);
  assert.equal(page.rows.length, 5);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 5);
  assert.equal(page.total, null, '默认不数总数');
  for (const row of page.rows) {
    assert.ok(row.minx <= 2500 && row.maxx >= 0 && row.miny <= 1000 && row.maxy >= 0);
    assert.deepEqual(Object.keys(row).sort(), ['handle', 'layer', 'maxx', 'maxy', 'minx', 'miny', 'type']);
  }

  const inBox = entities.filter(e => {
    const b = entityBox(e);
    return b[2] >= 0 && b[0] <= 2500 && b[3] >= 0 && b[1] <= 1000;
  }).map(e => e.id);
  assert.deepEqual(page.rows.map(r => r.handle), inBox.slice(0, 5));

  const second = await queryIndex(store, {dataset: built.dataset, box: [0, 0, 2500, 1000], limit: 5, offset: 5});
  assert.deepEqual(second.rows.map(r => r.handle), inBox.slice(5, 10));
  assert.notDeepEqual(second.rows.map(r => r.handle), page.rows.map(r => r.handle));

  const counted = await queryIndex(store, {dataset: built.dataset, box: [0, 0, 2500, 1000], limit: 5, count: true});
  assert.equal(counted.total, inBox.length, '显式要总数时才计算');
  assert.ok(counted.total > 5);

  const walls = await queryIndex(store, {dataset: built.dataset, layers: ['WALL'], limit: 100});
  assert.ok(walls.rows.length > 0);
  assert.ok(walls.rows.every(r => r.layer === 'WALL'));

  const texts = await queryIndex(store, {dataset: built.dataset, types: ['TEXT'], limit: 100});
  assert.ok(texts.rows.every(r => r.type === 'TEXT'));

  const none = await queryIndex(store, {dataset: built.dataset, box: [-5000, -5000, -1000, -1000]});
  assert.equal(none.rows.length, 0);
  assert.equal(none.hasMore, false);

  await assert.rejects(() => queryIndex(store, {box: [1, 2, 3]}), /box/);
  await assert.rejects(() => queryIndex(store, {limit: 999999}), /limit/);
});

test('图层清单与索引摘要', {skip}, async () => {
  const {store} = tempProject();
  await buildIndex(store, {source: 'source/drawings/plan.dxf', parse: parserFor(synthetic(900))});
  const layers = await layersIndex(store);
  assert.equal(layers.available, true);
  assert.deepEqual(layers.layers.map(l => l.layer).sort(), ['DIM', 'FURN', 'WALL']);
  assert.equal(layers.layers.reduce((n, l) => n + l.entities, 0), 900);
  const stat = await statIndexFor(store);
  assert.equal(stat.entities, 900);
  assert.equal(stat.layers, 3);
  assert.equal(stat.types, 2);
  assert.ok(stat.bounds[2] > stat.bounds[0]);
  assert.ok(stat.bytes > 0);
});

test('删掉索引文件后重建：不重新解析；删掉整个 .space 后从项目产物重建', {skip}, async () => {
  const {dir, store} = tempProject();
  const counter = {calls: 0};
  const entities = synthetic(500);
  const parse = parserFor(entities, counter);
  await buildIndex(store, {source: 'source/drawings/plan.dxf', parse});
  assert.equal(counter.calls, 1);

  for (const name of fs.readdirSync(path.join(dir, '.space'))) {
    if (name.startsWith('project.sqlite')) fs.rmSync(path.join(dir, '.space', name), {force: true});
  }
  const rebuilt = await buildIndex(store, {source: 'source/drawings/plan.dxf', parse});
  assert.equal(rebuilt.cacheHit, true, '删索引后仍命中解析缓存');
  assert.equal(counter.calls, 1, '重建不重新解析源文件');
  assert.equal(rebuilt.entities, 500);

  // 项目内的 cad-source 产物是权威派生物：删掉整个 .space 也能不解析地重建
  fs.mkdirSync(path.join(dir, 'output/cad'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'output/cad/source.json'), JSON.stringify({schema: 'cad-source/v1', source: {file: 'plan.dxf'}, entities, issues: []}));
  fs.rmSync(path.join(dir, '.space'), {recursive: true, force: true});
  const fromArtifact = await buildIndex(store, {source: 'output/cad/source.json', parse});
  assert.equal(counter.calls, 1, '从索引产物重建不解析 DXF');
  assert.equal(fromArtifact.entities, 500);
  assert.equal(fromArtifact.cacheHit, false, '不是解析缓存命中，而是直接读索引产物');
});

test('多数据集：后建的数据集不影响先建的数据集', {skip}, async () => {
  const {store} = tempProject();
  fs.writeFileSync(path.join(store.dir, 'source/drawings/b.dxf'), 'second');
  const a = await buildIndex(store, {source: 'source/drawings/plan.dxf', dataset: 'A', parse: parserFor(synthetic(10))});
  const b = await buildIndex(store, {source: 'source/drawings/b.dxf', dataset: 'B', parse: parserFor(synthetic(3))});
  assert.equal(a.dataset, 'A');
  assert.equal(b.dataset, 'B');
  assert.equal((await queryIndex(store, {dataset: 'A'})).rows.length, 10);
  assert.equal((await queryIndex(store, {dataset: 'B'})).rows.length, 3);
  assert.equal((await statIndexFor(store)).entities, 13);
});

test('性能：五万图元索引、5000 条包围盒查询、解析缓存命中', {skip, timeout: 120000}, async () => {
  const {store} = tempProject();
  const entities = synthetic(50000);
  const counter = {calls: 0};
  const parse = parserFor(entities, counter);

  const built = await buildIndex(store, {source: 'source/drawings/plan.dxf', parse});
  assert.equal(built.entities, 50000);

  const cached = await buildIndex(store, {source: 'source/drawings/plan.dxf', parse});
  assert.equal(cached.cacheHit, true);
  assert.equal(counter.calls, 1);
  assert.ok(cached.parseMs < 50, `解析缓存命中 ${cached.parseMs}ms，应低于 50ms`);

  const query = {dataset: built.dataset, box: [0, 0, 250000, 20000], limit: 5000};
  const warm = await queryIndex(store, query);
  assert.equal(warm.rows.length, 5000);
  // 单元测试只守住「不会退化成全表扫描」的量级；roadmap 的 5ms 指标由
  // npm run bench:index 在独占进程里验收。这里跑在并发测试进程里，阈值必须宽松，
  // 否则 CPU 抢占会造成假红。
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    await queryIndex(store, query);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const median = samples[2];
  assert.ok(median < 250, `包围盒查 5000 条中位 ${median.toFixed(2)}ms，超过 250ms 说明退化成全表扫描`);
});
