// M2 设计版本能力：版本链、复制、状态机与写入纪律。
// 临时项目用 fs 造；项目内的权威数据一律经 store.writeData 写入。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {capabilities, parseForkFrom} from '../src/capabilities/design.mjs';
import {createContext} from '../src/capabilities/context.mjs';
import {validateRegistry} from '../src/contracts/capability.mjs';
import {datasetFile, designVersionFile} from '../src/contracts/graph.mjs';
import {emptyDataset, validateDesign, validateDesignVersion} from '../src/contracts/datasets.mjs';
import {openStore} from '../src/store/index.mjs';

const designFileOf = (scheme) => `data/designs/${scheme}/design.json`;

function tempProject(datasets = ['d1']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-design-'));
  const file = path.join(dir, 'project.json');
  fs.writeFileSync(file, JSON.stringify({schema: 'space-project/v1', id: 'design-demo', output: 'output'}, null, 2));
  const store = openStore(file);
  for (const id of datasets) {
    store.writeData(datasetFile(id), emptyDataset({id, sources: [{file: 'source/drawings/plan.dxf'}]}), {baseHash: null, confirm: true});
  }
  return {dir, file, store};
}

const byId = new Map(capabilities.map(c => [c.id, c]));
function cap(id) {
  const found = byId.get(id);
  assert.ok(found, `未找到能力 ${id}`);
  return found;
}

// 与 runCapability 同样的调用方式：createContext + store.scope(cap.id) + cap.run。
async function call(ctx, id, params = {}) {
  const c = cap(id);
  const scoped = ctx.store.scope(c.id);
  const result = await c.run({...ctx, store: scoped}, params);
  return {result, scoped};
}

function writePaths(store, since = 0) {
  return store.events().slice(since).filter(e => e.type === 'write').map(e => e.path);
}

test('五个能力的契约字段齐备，且都声明 write:data', () => {
  assert.deepEqual(validateRegistry(capabilities), []);
  assert.deepEqual(capabilities.map(c => c.id), [
    'design.create', 'design.version', 'design.fork', 'design.confirm', 'design.stale'
  ]);
  for (const c of capabilities) {
    assert.equal(c.stage, 'design', `${c.id} 属于设计阶段`);
    assert.deepEqual(c.sideEffects, ['write:data']);
    assert.deepEqual(c.requires, []);
    assert.equal(typeof c.idempotent, 'boolean');
  }
  assert.deepEqual(parseForkFrom('a#2'), {scheme: 'a', seq: 2});
  assert.deepEqual(parseForkFrom({scheme: 'a', seq: 2}), {scheme: 'a', seq: 2});
});

test('create → version：parent 链正确、seq 递增、设计文件都在 data/designs 下', async () => {
  const {file} = tempProject();
  const ctx = createContext(file);
  const since = ctx.store.events().length;

  const {result: created} = await call(ctx, 'design.create', {scheme: 'a', dataset: 'd1'});
  assert.equal(created.data.seq, 1);
  assert.equal(created.data.status, 'draft');
  assert.equal(created.data.versionFile, designVersionFile('a', 1));

  const design1 = ctx.store.readJson(designFileOf('a'));
  assert.deepEqual(validateDesign(design1), []);
  assert.equal(design1.dataset, 'd1');
  assert.deepEqual(design1.versions.map(v => [v.seq, v.status]), [[1, 'draft']]);

  const v1 = ctx.store.readJson(designVersionFile('a', 1));
  assert.deepEqual(validateDesignVersion(v1), []);
  assert.equal(v1.parent, null, '第一版没有父版本');
  assert.equal(v1.forkedFrom, null, '新方案不是复制来的');

  const {result: second} = await call(ctx, 'design.version', {scheme: 'a', note: '改墙'});
  assert.equal(second.data.seq, 2);
  assert.equal(second.data.parent, 1, 'parent 取当前最大 seq');
  assert.equal(second.data.dataset, 'd1', '数据集沿用方案');

  const {result: third} = await call(ctx, 'design.version', {scheme: 'a'});
  assert.equal(third.data.seq, 3);
  assert.equal(third.data.parent, 2);

  for (const [seq, parent] of [[1, null], [2, 1], [3, 2]]) {
    const version = ctx.store.readJson(designVersionFile('a', seq));
    assert.deepEqual(validateDesignVersion(version), [], ` versions/${seq} 应通过校验`);
    assert.equal(version.parent, parent);
    assert.equal(version.seq, seq);
    assert.equal(version.status, 'draft');
  }
  const v2 = ctx.store.readJson(designVersionFile('a', 2));
  assert.equal(v2.note, '改墙');

  const design = ctx.store.readJson(designFileOf('a'));
  assert.deepEqual(validateDesign(design), []);
  assert.deepEqual(design.versions.map(v => v.seq), [1, 2, 3]);

  // 写入纪律：文件都落在 data/designs/ 下，登记与磁盘一致。
  const paths = writePaths(ctx.store, since);
  assert.equal(paths.length, 6, '三次操作各写清单与版本文件');
  for (const p of paths) assert.ok(p.startsWith('data/designs/'), `不应写到别处：${p}`);
  const report = ctx.store.verify();
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.modified, []);
  assert.deepEqual(report.leftovers, []);
  assert.equal(report.ok, true);
});

test('fork：只记录来源、不写边，原方案后续改动不影响副本', async () => {
  const {file} = tempProject();
  const ctx = createContext(file);
  await call(ctx, 'design.create', {scheme: 'a', dataset: 'd1'});
  await call(ctx, 'design.version', {scheme: 'a'});

  const before = ctx.store.events().length;
  const {result: forked, scoped} = await call(ctx, 'design.fork', {from: 'a#2', scheme: 'b'});
  assert.deepEqual(forked.data.forkedFrom, {scheme: 'a', seq: 2});
  assert.equal(forked.data.seq, 1, '复制出来的方案从 001 重新开始');

  // 复制只写两份文件，不写 edge（设计之间也不能派生）。
  assert.equal(scoped.writes, 2);
  assert.deepEqual(writePaths(ctx.store, before).sort(), [designFileOf('b'), designVersionFile('b', 1)]);
  assert.equal(
    ctx.store.events().slice(before).some(e => /edge|derived|graph/.test(`${e.op} ${e.path}`)),
    false,
    'design.fork 不写派生边'
  );

  const b1 = ctx.store.readJson(designVersionFile('b', 1));
  assert.deepEqual(validateDesignVersion(b1), []);
  assert.deepEqual(b1.forkedFrom, {scheme: 'a', seq: 2});
  assert.equal(b1.parent, null, '副本自己开链，parent 为 null');
  assert.equal(b1.status, 'draft');
  assert.equal(b1.dataset, 'd1');

  // {scheme, seq} 形状与字符串等价
  const {result: forked2} = await call(ctx, 'design.fork', {from: {scheme: 'a', seq: 2}, scheme: 'c'});
  assert.deepEqual(forked2.data.forkedFrom, {scheme: 'a', seq: 2});
  // 解析失败
  for (const bad of ['a##2', 'a2', 'a#0', '']) {
    await assert.rejects(() => call(ctx, 'design.fork', {from: bad, scheme: 'd'}), e => e.code === 'E_EXEC_PARAM', `${bad} 应被拒`);
  }
  await assert.rejects(() => call(ctx, 'design.fork', {from: 'a#9', scheme: 'd'}), e => e.code === 'E_DATA_REFERENCE');

  // 改原方案：加版本 + 改状态
  await call(ctx, 'design.version', {scheme: 'a', note: '原方案继续'});
  await call(ctx, 'design.confirm', {scheme: 'a', seq: 1});

  const a1 = ctx.store.readJson(designVersionFile('a', 1));
  assert.equal(a1.status, 'confirmed');
  assert.equal(ctx.store.readJson(designFileOf('a')).versions.length, 3);

  // 副本纹丝不动
  const b1After = ctx.store.readJson(designVersionFile('b', 1));
  assert.deepEqual(b1After, b1, '原方案变化不传播到副本');
  assert.equal(ctx.store.readJson(designFileOf('b')).versions.length, 1);
  assert.equal(ctx.store.exists(designVersionFile('b', 2)), false);
  assert.deepEqual(ctx.store.verify().modified, []);
});

test('create：数据集缺失或未通过校验都被拒，且不落任何设计文件', async () => {
  const {file} = tempProject(['d1']);
  const ctx = createContext(file);

  await assert.rejects(
    () => call(ctx, 'design.create', {scheme: 'x', dataset: 'nope'}),
    e => e.code === 'E_DATA_REFERENCE'
  );

  // 文件在但不合法：没有来源
  ctx.store.writeData(datasetFile('bad'), {schema: 'space-dataset/v1', id: 'bad', status: 'draft', sources: []}, {baseHash: null, confirm: true});
  await assert.rejects(
    () => call(ctx, 'design.create', {scheme: 'y', dataset: 'bad'}),
    e => e.code === 'E_DATA_INVALID'
  );

  // schema 对不上按契约问题报
  ctx.store.writeData(datasetFile('old'), {schema: 'space-dataset/v0', id: 'old', status: 'draft', sources: [{file: 'a.dxf'}]}, {baseHash: null, confirm: true});
  await assert.rejects(
    () => call(ctx, 'design.create', {scheme: 'z', dataset: 'old'}),
    e => e.code === 'E_DATA_SCHEMA'
  );

  // 非法 id 不许拼出项目外路径
  await assert.rejects(
    () => call(ctx, 'design.create', {scheme: '../escape', dataset: 'd1'}),
    e => e.code === 'E_EXEC_PARAM'
  );

  assert.equal(ctx.store.exists(designFileOf('x')), false);
  assert.equal(ctx.store.exists(designFileOf('y')), false);
  assert.equal(ctx.store.exists(designFileOf('z')), false);
});

test('状态机：superseded 不能回到 confirmed，draft 不能直接 stale', async () => {
  const {file} = tempProject();
  const ctx = createContext(file);

  // 正常链路：draft → confirmed → stale → confirmed，design.json 目录同步
  await call(ctx, 'design.create', {scheme: 'a', dataset: 'd1'});
  const {result: confirmed} = await call(ctx, 'design.confirm', {scheme: 'a', seq: 1});
  assert.equal(confirmed.data.status, 'confirmed');
  assert.equal(ctx.store.readJson(designVersionFile('a', 1)).status, 'confirmed');
  assert.equal(ctx.store.readJson(designFileOf('a')).versions[0].status, 'confirmed', '目录项跟着权威走');

  const {result: staled} = await call(ctx, 'design.stale', {scheme: 'a', seq: 1});
  assert.equal(staled.data.status, 'stale');
  assert.equal(ctx.store.readJson(designVersionFile('a', 1)).statusChangedAt !== undefined, true);

  await call(ctx, 'design.confirm', {scheme: 'a', seq: 1});
  assert.equal(ctx.store.readJson(designVersionFile('a', 1)).status, 'confirmed');

  // 草稿不能直接标待复核
  await call(ctx, 'design.create', {scheme: 'b', dataset: 'd1'});
  await assert.rejects(
    () => call(ctx, 'design.stale', {scheme: 'b', seq: 1}),
    e => e.code === 'E_DATA_RULE'
  );
  assert.equal(ctx.store.readJson(designVersionFile('b', 1)).status, 'draft', '被拒时不改文件');

  // superseded 是终点（没有能力产生它，测试里直接写状态）
  await call(ctx, 'design.create', {scheme: 'c', dataset: 'd1'});
  const rel = designVersionFile('c', 1);
  const current = ctx.store.readJson(rel);
  ctx.store.writeData(rel, {...current, status: 'superseded'}, {baseHash: ctx.store.hashOf(rel), confirm: true});
  await assert.rejects(
    () => call(ctx, 'design.confirm', {scheme: 'c', seq: 1}),
    e => e.code === 'E_DATA_RULE'
  );
  assert.equal(ctx.store.readJson(rel).status, 'superseded');
  assert.equal(ctx.store.readJson(designFileOf('c')).versions[0].status, 'draft', '被拒时目录项也不动');

  await assert.rejects(() => call(ctx, 'design.confirm', {scheme: 'c', seq: 7}), e => e.code === 'E_DATA_REFERENCE');
  assert.deepEqual(ctx.store.verify().modified, []);
});

test('读-改-写 design.json 带 baseHash：并发改动暴露成 E_STORE_CONFLICT', async () => {
  const {file} = tempProject();
  const ctx = createContext(file);
  await call(ctx, 'design.create', {scheme: 'a', dataset: 'd1'});

  const rel = designFileOf('a');
  // 模拟另一个写入者：本能力读到设计文件之后、写入之前，磁盘被别人改过。
  let raced = false;
  const scoped = ctx.store.scope('design.version');
  const realRead = ctx.store.readJson.bind(ctx.store);
  scoped.readJson = (r) => {
    const value = realRead(r);
    if (r === rel && !raced) {
      raced = true;
      ctx.store.writeData(rel, {...value, versions: [...value.versions, {seq: 9, status: 'draft', at: new Date().toISOString()}]}, {
        baseHash: ctx.store.hashOf(rel),
        confirm: true
      });
    }
    return value;
  };

  await assert.rejects(
    () => cap('design.version').run({...ctx, store: scoped}, {scheme: 'a'}),
    e => e.code === 'E_STORE_CONFLICT'
  );
  assert.equal(raced, true);
  assert.equal(ctx.store.exists(designVersionFile('a', 2)), false, '冲突时不留半截版本文件');
  assert.deepEqual(ctx.store.verify().modified, []);
});
