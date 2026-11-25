import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runCapability} from '../src/capabilities/index.mjs';
import {openStore} from '../src/store/index.mjs';
import {wallPolygon, imageToModel, mergeTrace, traceHandle} from '../src/domain/tracing.mjs';
import {validateTraceSpec, traceSpec, underlay} from '../src/contracts/index.mjs';

const BIN = fileURLToPath(new URL('../bin/space.mjs', import.meta.url));
const space = (...args) => spawnSync(process.execPath, [BIN, ...args], {encoding: 'utf8'});

const MODEL = {
  schema: 'space-model/v1', units: 'mm', projectId: 'trace-demo', defaults: {slab: 150},
  floors: [{id: 'ground', name: '首层', elevation: 0, clearHeight: 3000, wallHeight: 2800, slabThickness: 150,
    slab: [], walls: [], columns: [], doors: [], windowOpenings: [], furniture: [], trace: []}]
};

async function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-trace-'));
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({schema: 'space-project/v1', id: 'trace-demo', output: 'output'}, null, 2));
  fs.mkdirSync(path.join(dir, 'output/cad'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'output/cad/source.json'), JSON.stringify({
    schema: 'cad-source/v1', source: {file: 'plan.dxf'},
    entities: [{id: 'E1', handle: 'H1', type: 'LINE', layer: 'WALL', points: [[0, 0], [6000, 0]]}], issues: []
  }));
  const file = path.join(dir, 'project.json');
  await runCapability({project: file, capability: 'dataset.build', params: {source: 'output/cad/source.json', id: 'd1', confirm: true}});
  // dataset.build 的草稿模型读不出楼层尺寸，这里换成带完整楼层的模型便于合并
  const store = openStore(file);
  store.writeData('data/datasets/d1/model.json', MODEL, {baseHash: store.hashOf('data/datasets/d1/model.json'), confirm: true});
  return {dir, file, store};
}

test('纯函数：墙多边形、坐标变换、handle 稳定', () => {
  const ring = wallPolygon([0, 0], [1000, 0], 200);
  // 法向取 (-(y2-y1), (x2-x1)) 方向：水平墙的两条边在 y=+half 与 y=-half
  assert.deepEqual(ring, [[0, 100], [1000, 100], [1000, -100], [0, -100]]);
  assert.equal(traceHandle([0, 0], [1000, 0], 200), traceHandle([0, 0], [1000, 0], 200));
  assert.notEqual(traceHandle([0, 0], [1000, 0], 200), traceHandle([0, 0], [1000, 0], 100));
  assert.throws(() => wallPolygon([0, 0], [0, 0], 200), /重合/);

  const ul = underlay({file: 'a.png', mmPerPx: 10, origin: [1000, 2000]});
  assert.deepEqual(imageToModel(ul, [0, 0]), [1000, 2000]);
  assert.deepEqual(imageToModel(ul, [10, 20]), [1100, 2200]);
  assert.deepEqual(imageToModel({...ul, rotationDeg: 90}, [10, 0]), [1000, 1900]);
});

test('契约：描图提交必须带操作者与合法构件', () => {
  const items = [{kind: 'wall', from: [0, 0], to: [1000, 0], thicknessMm: 200}];
  assert.deepEqual(validateTraceSpec(traceSpec({dataset: 'd1', items, actor: 'aaron'})), []);
  assert.match(validateTraceSpec(traceSpec({dataset: 'd1', items, actor: ''})).join(), /操作者/);
  assert.match(validateTraceSpec(traceSpec({dataset: 'd1', items: [], actor: 'a'})).join(), /至少提交/);
  assert.match(validateTraceSpec(traceSpec({dataset: 'd1', items: [{kind: 'wall', from: [0, 0], to: [0, 0], thicknessMm: 200}], actor: 'a'})).join(), /重合/);
  assert.match(validateTraceSpec(traceSpec({dataset: 'd1', items, actor: 'a', underlay: {file: 'a.png', mmPerPx: 0, origin: [0, 0]}})).join(), /mmPerPx/);
  assert.match(validateTraceSpec(traceSpec({dataset: 'd1', items: [{kind: 'invalid'}], actor: 'a'})).join(), /handle/);
  assert.match(validateTraceSpec(traceSpec({dataset: 'd1', items: [{kind: 'wall', from: [0, 0], to: [1, 1], thicknessMm: 9999}], actor: 'a'})).join(), /墙厚/);
});

test('合并：新增、幂等覆盖、判无效、按 handle 排序', () => {
  const items = [
    {kind: 'wall', from: [0, 0], to: [6000, 0], thicknessMm: 200},
    {kind: 'wall', from: [0, 0], to: [0, 4000], thicknessMm: 200},
    {kind: 'invalid', handle: 'H9'}
  ];
  const first = mergeTrace(MODEL, {floor: 'ground', items, actor: 'aaron', at: '2026-11-25T00:00:00.000Z'});
  assert.equal(first.applied.length, 2);
  assert.equal(first.applied.filter(a => a.replaced).length, 0);
  assert.deepEqual(first.invalidHandles, ['H9']);
  const walls = first.model.floors[0].walls;
  assert.equal(walls.length, 2);
  assert.equal(walls[0].provenance, 'manual');
  assert.equal(walls[0].tracedBy, 'aaron');
  assert.deepEqual(walls.map(w => w.handle), [...walls.map(w => w.handle)].sort());

  const second = mergeTrace(first.model, {floor: 'ground', items, actor: 'aaron'});
  assert.equal(second.model.floors[0].walls.length, 2, '重复提交不应新增');
  assert.equal(second.applied.filter(a => a.replaced).length, 2);
  assert.deepEqual(MODEL.floors[0].walls, [], '不得修改输入模型');
});

test('能力：描图写入模型与数据集记录，重复提交幂等', async () => {
  const {file, store} = await tempProject();
  const items = [{kind: 'wall', from: [0, 0], to: [6000, 0], thicknessMm: 200}, {kind: 'invalid', handle: 'H1', reason: '家具边'}];
  const first = await runCapability({file, project: file, capability: 'annotation.trace', params: {dataset: 'd1', items, actor: 'aaron', note: '首轮'}});
  assert.match(first.summary, /新增 1 面墙/);
  assert.equal(first.data.created, 1);
  assert.equal(first.data.invalid, 1);

  const model = store.readJson('data/datasets/d1/model.json');
  assert.equal(model.floors[0].walls.length, 1);
  assert.equal(model.floors[0].walls[0].provenance, 'manual');
  assert.ok(model.floors[0].walls[0].tracedAt);

  const dataset = store.readJson('data/datasets/d1/dataset.json');
  assert.equal(dataset.traces.length, 1);
  assert.equal(dataset.traces[0].actor, 'aaron');
  assert.equal(dataset.traces[0].walls, 1);
  assert.equal(dataset.traces[0].invalid, 1);

  const again = await runCapability({file, project: file, capability: 'annotation.trace', params: {dataset: 'd1', items, actor: 'aaron'}});
  assert.equal(again.data.created, 0);
  assert.equal(again.data.replaced, 1);
  assert.equal(store.readJson('data/datasets/d1/model.json').floors[0].walls.length, 1, '重复提交不新增墙');
  assert.equal(store.readJson('data/datasets/d1/dataset.json').traces.length, 2, '每次都留一条记录');
  assert.equal(store.verify().ok, true);
});

test('能力：缺操作者、坏 JSON、未知楼层都被拒', async () => {
  const {file} = await tempProject();
  const items = [{kind: 'wall', from: [0, 0], to: [1000, 0], thicknessMm: 200}];
  await assert.rejects(runCapability({file, project: file, capability: 'annotation.trace', params: {dataset: 'd1', items}}), /操作者/);
  await assert.rejects(runCapability({file, project: file, capability: 'annotation.trace', params: {dataset: 'd1', items: '{oops', actor: 'a'}}), /JSON/);
  await assert.rejects(runCapability({file, project: file, capability: 'annotation.trace', params: {dataset: 'd1', items, actor: 'a', floor: 'roof'}}), /没有楼层/);
  await assert.rejects(runCapability({file, project: file, capability: 'annotation.trace', params: {dataset: 'nope', items, actor: 'a'}}), /数据集不存在/);
});

test('CLI：trace save / list', async () => {
  const {dir, file} = await tempProject();
  const itemsFile = path.join(dir, 'items.json');
  fs.writeFileSync(itemsFile, JSON.stringify([{kind: 'wall', from: [0, 0], to: [3000, 0], thicknessMm: 150}]));
  const saved = space('trace', 'save', '--project', file, '--dataset', 'd1', '--file', itemsFile, '--actor', 'tester',
    '--underlay', JSON.stringify({file: 'output/cad/underlay.png', mmPerPx: 10, origin: [0, 0]}));
  assert.equal(saved.status, 0, saved.stdout + saved.stderr);
  assert.match(saved.stdout, /新增 1 面墙/);

  const listed = space('trace', 'list', '--project', file, '--dataset', 'd1');
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /描图记录 1 条/);
  assert.match(listed.stdout, /tester/);

  const bad = space('trace', 'save', '--project', file, '--dataset', 'd1', '--items', '[]', '--actor', 'x');
  assert.equal(bad.status, 1);
});
