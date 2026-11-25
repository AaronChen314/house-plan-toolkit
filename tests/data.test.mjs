import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {capabilities} from '../src/capabilities/data.mjs';
import {createContext} from '../src/capabilities/index.mjs';
import {validateRegistry} from '../src/contracts/capability.mjs';
import {validateDataset} from '../src/contracts/datasets.mjs';
import {validateModel} from '../src/domain/model.mjs';

const [build, diff, correct] = capabilities;

const LINE = (handle, layer, points) => ({id: handle, handle, type: 'LINE', layer, points});
const TEXT = (handle, layer, text, at) => ({id: handle, handle, type: 'TEXT', layer, text, at, points: [at]});

const SOURCE_A = {
  schema: 'cad-source/v1',
  source: {file: 'plan-a.dxf', sha256: 'a'.repeat(64)},
  units: 'mm',
  entities: [
    LINE('H1', 'WALL', [[0, 0], [4000, 0]]),
    LINE('H2', 'WALL', [[0, 0], [0, 3000]]),
    TEXT('T1', 'DIM', '3600', [500, 500])
  ],
  issues: []
};

// H1 墙位变化、H2 消失、H3 新增，用来卡 added/removed/changed 三路。
const SOURCE_B = {
  schema: 'cad-source/v1',
  source: {file: 'plan-b.dxf', sha256: 'b'.repeat(64)},
  units: 'mm',
  entities: [
    LINE('H1', 'WALL', [[0, 0], [5000, 0]]),
    LINE('H3', 'WALL', [[0, 3000], [4000, 3000]]),
    TEXT('T1', 'DIM', '3600', [500, 500])
  ],
  issues: []
};

// 校正版：H1 变化、H2 保留、H3 新增。
const SOURCE_C = {
  schema: 'cad-source/v1',
  source: {file: 'plan-c.dxf', sha256: 'c'.repeat(64)},
  units: 'mm',
  entities: [
    LINE('H1', 'WALL', [[0, 0], [4500, 0]]),
    LINE('H2', 'WALL', [[0, 0], [0, 3000]]),
    LINE('H3', 'WALL', [[0, 3000], [4000, 3000]]),
    TEXT('T1', 'DIM', '3600', [500, 500])
  ],
  issues: []
};

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-data-'));
  const file = path.join(dir, 'project.json');
  fs.writeFileSync(file, JSON.stringify({
    schema: 'space-project/v1',
    id: 'data-demo',
    name: '数据集测试',
    output: 'output'
  }, null, 2));
  return {dir, file, ctx: createContext(file)};
}

function seedSource(ctx, rel, data) {
  ctx.store.writeArtifact(rel, data, {kind: 'cad-source'});
}

function run(cap, ctx, params) {
  return cap.run({...ctx, store: ctx.store.scope(cap.id)}, params);
}

function hashesOf(ctx) {
  const files = ctx.store.files().files;
  return Object.fromEntries(Object.keys(files).sort().map(rel => [rel, ctx.store.hashOf(rel)]));
}

test('能力契约字段齐全，且未注册不影响本地校验', () => {
  assert.deepEqual(validateRegistry(capabilities), []);
  assert.deepEqual(capabilities.map(c => c.id), ['dataset.build', 'dataset.diff', 'dataset.correct', 'annotation.confirm', 'annotation.trace']);
  assert.deepEqual(diff.sideEffects, ['none']);
  assert.deepEqual(correct.sideEffects, ['none']);
  assert.deepEqual(build.sideEffects, ['write:data']);
});

test('dataset.build：不带 confirm 被拒，且不产生权威数据', async () => {
  const {ctx} = tempProject();
  seedSource(ctx, 'output/cad/source-a.json', SOURCE_A);
  await assert.rejects(run(build, ctx, {source: 'output/cad/source-a.json', id: 'd1'}), (e) => {
    assert.equal(e.code, 'E_DATA_CONFIRM_REQUIRED');
    assert.match(e.message, /confirm/);
    return true;
  });
  assert.equal(ctx.store.exists('data/datasets/d1/dataset.json'), false);
  assert.equal(ctx.store.exists('data/datasets/d1/model.json'), false);
});

test('dataset.build：confirm 后登记两个文件，假设 basis 为 preview', async () => {
  const {ctx} = tempProject();
  seedSource(ctx, 'output/cad/source-a.json', SOURCE_A);

  const result = await run(build, ctx, {source: 'output/cad/source-a.json', id: 'd1', confirm: true});
  assert.match(result.summary, /3 条 trace/);
  assert.deepEqual(result.outputs.map(o => o.path), [
    'data/datasets/d1/dataset.json',
    'data/datasets/d1/model.json'
  ]);

  const files = ctx.store.files().files;
  for (const rel of ['data/datasets/d1/dataset.json', 'data/datasets/d1/model.json']) {
    assert.ok(files[rel], `${rel} 应登记`);
    assert.equal(files[rel].mode, 'data');
  }

  const dataset = ctx.store.readJson('data/datasets/d1/dataset.json');
  assert.deepEqual(validateDataset(dataset), []);
  assert.equal(dataset.id, 'd1');
  assert.equal(dataset.sources.length, 1);
  assert.equal(dataset.sources[0].file, 'output/cad/source-a.json');
  assert.match(dataset.sources[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(dataset.assumptions.length, 4);
  assert.ok(dataset.assumptions.every(a => a.basis === 'preview'));
  assert.ok(dataset.assumptions.some(a => a.field === 'clearHeight'));

  const model = ctx.store.readJson('data/datasets/d1/model.json');
  assert.equal(model.schema, 'space-model/v1');
  assert.equal(model.floors.length, 1);
  assert.equal(model.floors[0].id, 'ground');
  assert.equal(validateModel(model).passed, true);
  assert.deepEqual(model.floors[0].trace.map(t => t.handle), ['H1', 'H2', 'T1']);
  assert.equal(model.floors[0].trace.at(-1).kind, 'text');
  assert.equal(model.floors[0].trace.at(-1).text, '3600');
  assert.equal(ctx.store.verify().ok, true);
});

test('dataset.build：相同输入重复构建幂等', async () => {
  const {ctx} = tempProject();
  seedSource(ctx, 'output/cad/source-a.json', SOURCE_A);
  await run(build, ctx, {source: 'output/cad/source-a.json', id: 'd1', confirm: true});
  const first = hashesOf(ctx);

  const again = await run(build, ctx, {source: 'output/cad/source-a.json', id: 'd1', confirm: true});
  assert.match(again.summary, /3 条 trace/);
  assert.deepEqual(hashesOf(ctx), first, '重复构建不应改变文件字节');

  const writes = ctx.store.events().filter(e => e.type === 'write' && e.path.startsWith('data/datasets/d1/'));
  assert.equal(writes.length, 4, '两次构建各写两个文件');
  assert.deepEqual(writes.slice(-2).map(e => e.status), ['unchanged', 'unchanged']);
});

test('dataset.diff：记录层与图元层的 added/removed/changed 都正确', async () => {
  const {ctx} = tempProject();
  seedSource(ctx, 'output/cad/source-a.json', SOURCE_A);
  seedSource(ctx, 'output/cad/source-b.json', SOURCE_B);
  await run(build, ctx, {source: 'output/cad/source-a.json', id: 'd1', confirm: true});
  await run(build, ctx, {source: 'output/cad/source-b.json', id: 'd2', confirm: true});

  const result = await run(diff, ctx, {a: 'd1', b: 'd2'});
  assert.deepEqual(result.data.entities.added, ['H3']);
  assert.deepEqual(result.data.entities.removed, ['H2']);
  assert.deepEqual(result.data.entities.changed, ['H1']);
  assert.deepEqual(result.data.entities.changes, [
    {handle: 'H1', from: [0, 0, 4000, 0], to: [0, 0, 5000, 0]}
  ]);
  assert.equal(result.data.models.compared, true);
  assert.deepEqual(result.data.records.sources.added, ['output/cad/source-b.json::' + ctx.store.hashOf('output/cad/source-b.json')]);
  assert.deepEqual(result.data.records.sources.removed, ['output/cad/source-a.json::' + ctx.store.hashOf('output/cad/source-a.json')]);
  assert.deepEqual(result.data.records.confirmations, {added: [], removed: [], changed: []});
  assert.match(result.summary, /\+1 -1 ~1/);
});

test('dataset.correct：只读比对，verify 与文件哈希前后一致', async () => {
  const {ctx} = tempProject();
  seedSource(ctx, 'output/cad/source-a.json', SOURCE_A);
  seedSource(ctx, 'output/cad/source-c.json', SOURCE_C);
  await run(build, ctx, {source: 'output/cad/source-a.json', id: 'd1', confirm: true});

  const beforeVerify = ctx.store.verify();
  const beforeHashes = hashesOf(ctx);
  const beforeDataset = ctx.store.readText('data/datasets/d1/dataset.json');
  const beforeModel = ctx.store.readText('data/datasets/d1/model.json');

  const result = await run(correct, ctx, {dataset: 'd1', source: 'output/cad/source-c.json'});
  assert.deepEqual(result.data.entities.added, ['H3']);
  assert.deepEqual(result.data.entities.removed, []);
  assert.deepEqual(result.data.entities.changed, ['H1']);
  assert.equal(result.data.review.available, true, '复核清单来自权威文件，不依赖索引');
  assert.deepEqual(result.data.review.suggested, [], '还没有设计引用这个数据集');
  assert.deepEqual(result.data.review.changedHandles.sort(), ['H1', 'H3']);
  assert.equal(result.data.review.downstream.available, false, '下游产物只有图投影能给，明确降级');
  assert.match(result.data.review.downstream.reason, /索引/);
  assert.match(result.summary, /图元 \+1 -0 ~1/);

  assert.deepEqual(ctx.store.verify(), beforeVerify, 'verify 报告不应变化');
  assert.deepEqual(hashesOf(ctx), beforeHashes, '任何文件哈希都不应变');
  assert.equal(ctx.store.readText('data/datasets/d1/dataset.json'), beforeDataset);
  assert.equal(ctx.store.readText('data/datasets/d1/model.json'), beforeModel);
});

test('缺文件与未知数据集给出清晰错误', async () => {
  const {ctx} = tempProject();
  seedSource(ctx, 'output/cad/source-a.json', SOURCE_A);
  await run(build, ctx, {source: 'output/cad/source-a.json', id: 'd1', confirm: true});

  await assert.rejects(run(build, ctx, {source: 'output/cad/none.json', id: 'd9', confirm: true}), (e) => {
    assert.equal(e.code, 'E_EXEC_PARAM');
    assert.match(e.message, /文件不存在/);
    return true;
  });

  await assert.rejects(run(diff, ctx, {a: 'd1', b: 'ghost'}), (e) => {
    assert.equal(e.code, 'E_DATA_REFERENCE');
    assert.match(e.message, /数据集不存在：ghost/);
    return true;
  });

  await assert.rejects(run(correct, ctx, {dataset: 'ghost', source: 'output/cad/source-a.json'}), (e) => {
    assert.equal(e.code, 'E_DATA_REFERENCE');
    assert.match(e.message, /数据集不存在：ghost/);
    return true;
  });

  await assert.rejects(run(correct, ctx, {dataset: 'd1', source: 'output/cad/none.json'}), (e) => {
    assert.equal(e.code, 'E_EXEC_PARAM');
    assert.match(e.message, /文件不存在/);
    return true;
  });

  await assert.rejects(run(diff, ctx, {a: 'd1'}), (e) => {
    assert.equal(e.code, 'E_EXEC_PARAM');
    assert.match(e.message, /a 与 b/);
    return true;
  });
});

const annotation = capabilities.find(c => c.id === 'annotation.confirm');

test('annotation.confirm：逐项记录依据与时间，重复确认幂等', async () => {
  const {ctx} = tempProject();
  seedSource(ctx, 'output/cad/source-a.json', SOURCE_A);
  await run(build, ctx, {source: 'output/cad/source-a.json', id: 'd1', confirm: true});

  const first = await run(annotation, ctx, {dataset: 'd1', object: 'ground', field: 'clearHeight', value: '2750', basis: '图纸标注 2.75m', actor: 'aaron'});
  assert.match(first.summary, /2750/);
  assert.match(first.summary, /图纸标注/);
  const record = ctx.store.readJson('data/datasets/d1/dataset.json');
  const entry = record.confirmations.find(c => c.object === 'ground' && c.field === 'clearHeight');
  assert.equal(entry.value, 2750, '数字字符串应转成数字');
  assert.equal(entry.basis, '图纸标注 2.75m');
  assert.equal(entry.actor, 'aaron');
  assert.ok(entry.at, '必须记录确认时间');
  assert.equal(first.data.total, 1);

  const again = await run(annotation, ctx, {dataset: 'd1', object: 'ground', field: 'clearHeight', value: '2750', basis: '图纸标注 2.75m', actor: 'aaron'});
  assert.equal(again.data.unchanged, true, '同样内容重复确认不产生写入');
  assert.equal(ctx.store.readJson('data/datasets/d1/dataset.json').confirmations.length, 1);
});

test('annotation.confirm：缺依据被拒；判为无效可不带值；覆盖保留历史', async () => {
  const {ctx} = tempProject();
  seedSource(ctx, 'output/cad/source-a.json', SOURCE_A);
  await run(build, ctx, {source: 'output/cad/source-a.json', id: 'd1', confirm: true});

  await assert.rejects(
    run(annotation, ctx, {dataset: 'd1', object: 'ground', field: 'clearHeight', value: 2700}),
    (e) => { assert.equal(e.code, 'E_EXEC_PARAM'); assert.match(e.message, /依据/); return true; }
  );
  await assert.rejects(
    run(annotation, ctx, {dataset: 'd1', object: 'ghost-wall', field: 'heightMm', value: 2700, basis: '实测'}),
    (e) => { assert.equal(e.code, 'E_DATA_REFERENCE'); return true; }
  );

  const invalid = await run(annotation, ctx, {dataset: 'd1', object: 'ghost-wall', field: 'heightMm', invalid: true, basis: '现场确认不存在该构件'});
  assert.match(invalid.summary, /判为无效/);
  const record = ctx.store.readJson('data/datasets/d1/dataset.json');
  const marked = record.confirmations.find(c => c.object === 'ghost-wall');
  assert.equal(marked.invalid, true);
  assert.equal(marked.value, undefined);
  assert.equal(marked.basis, '现场确认不存在该构件');

  const text = await run(annotation, ctx, {dataset: 'd1', object: 'H1', field: 'structure', value: '承重', basis: '结构图例'});
  assert.equal(text.data.value, '承重', '非数字文本原样保留');

  // 同一 object+field 覆盖：旧值进 previous，不丢历史
  const first = await run(annotation, ctx, {dataset: 'd1', object: 'ground', field: 'clearHeight', value: 2750, basis: '图纸标注 2.75m'});
  assert.equal(first.data.value, 2750);
  await run(annotation, ctx, {dataset: 'd1', object: 'ground', field: 'clearHeight', value: 2720, basis: '复测'});
  const updated = ctx.store.readJson('data/datasets/d1/dataset.json').confirmations.find(c => c.object === 'ground' && c.field === 'clearHeight');
  assert.equal(updated.value, 2720);
  assert.equal(updated.basis, '复测');
  assert.equal(updated.previous.length, 1, '覆盖旧确认要保留历史');
  assert.equal(updated.previous[0].value, 2750);
  assert.equal(updated.previous[0].basis, '图纸标注 2.75m');
  assert.equal(ctx.store.verify().ok, true);
});
