import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runCapability} from '../src/capabilities/index.mjs';
import {openStore} from '../src/store/index.mjs';
import {projectFromFiles, readGraph} from '../src/store/graph.mjs';
import {impactOf, planStale} from '../src/domain/graph.mjs';
import {sqliteAvailable} from '../src/indexer/index.mjs';

const BIN = fileURLToPath(new URL('../bin/space.mjs', import.meta.url));
const EXAMPLE = fileURLToPath(new URL('../examples/two-level/project.json', import.meta.url));
const space = (...args) => spawnSync(process.execPath, [BIN, ...args], {encoding: 'utf8'});
const sqlite = await sqliteAvailable();

const SOURCE_A = {
  schema: 'cad-source/v1',
  source: {file: 'plan-a.dxf', sha256: 'a'.repeat(64)},
  entities: [
    {id: 'E1', handle: 'H1', type: 'LINE', layer: 'WALL', points: [[0, 0], [4000, 0]]},
    {id: 'E2', handle: 'H2', type: 'LINE', layer: 'WALL', points: [[0, 0], [0, 3000]]},
    {id: 'E3', handle: 'H3', type: 'TEXT', layer: 'DIM', text: '3600', at: [500, 500], points: [[500, 500]]}
  ],
  issues: []
};

const SOURCE_C = {
  schema: 'cad-source/v1',
  source: {file: 'plan-c.dxf', sha256: 'c'.repeat(64)},
  entities: [
    {id: 'E1', handle: 'H1', type: 'LINE', layer: 'WALL', points: [[0, 0], [4200, 0]]},
    {id: 'E2', handle: 'H2', type: 'LINE', layer: 'WALL', points: [[0, 0], [0, 3000]]},
    {id: 'E4', handle: 'H4', type: 'LINE', layer: 'WALL', points: [[4200, 0], [4200, 3000]]}
  ],
  issues: []
};

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-m2-'));
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({schema: 'space-project/v1', id: 'm2-demo', model: null, output: 'output'}, null, 2));
  fs.mkdirSync(path.join(dir, 'output/cad'), {recursive: true});
  fs.mkdirSync(path.join(dir, 'source/drawings'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'source/drawings/plan.dxf'), 'synthetic');
  fs.writeFileSync(path.join(dir, 'output/cad/source-a.json'), JSON.stringify(SOURCE_A));
  fs.writeFileSync(path.join(dir, 'output/cad/source-c.json'), JSON.stringify(SOURCE_C));
  return {dir, file: path.join(dir, 'project.json'), store: openStore(path.join(dir, 'project.json'))};
}

async function cap(project, id, params) {
  return runCapability({project, capability: id, params});
}

test('M2 链路：数据集 → 设计版本 → 图投影 → 校正预演只影响引用该数据集的设计', {skip: !sqlite && 'node:sqlite 不可用'}, async () => {
  const {file, store} = tempProject();

  const built = await cap(file, 'dataset.build', {source: 'output/cad/source-a.json', id: 'd1', confirm: true});
  const datasetFile = store.readJson('data/datasets/d1/dataset.json');
  assert.ok(datasetFile.assumptions.length > 0, '草稿必须把推断值记成假设');
  assert.ok(datasetFile.assumptions.every(a => a.basis === 'preview'), '假设必须标 preview 依据');
  assert.equal(built.data.assumptions, datasetFile.assumptions.length);
  assert.ok(store.exists('data/datasets/d1/dataset.json'));
  assert.ok(store.exists('data/datasets/d1/model.json'));

  await cap(file, 'design.create', {scheme: 'a', dataset: 'd1'});
  await cap(file, 'design.version', {scheme: 'a', note: '加一层柜体'});
  // 节点状态取最新版本：两版都确认，方案才算「已确认」。
  await cap(file, 'design.confirm', {scheme: 'a', seq: 1});
  await cap(file, 'design.confirm', {scheme: 'a', seq: 2});

  await cap(file, 'dataset.build', {source: 'output/cad/source-c.json', id: 'd2', confirm: true});
  await cap(file, 'design.create', {scheme: 'b', dataset: 'd2'});
  await cap(file, 'design.confirm', {scheme: 'b', seq: 1});

  const projected = await projectFromFiles(store);
  assert.equal(projected.nodes, 4, '两个数据集 + 两个方案');
  assert.equal(projected.edges, 2, '每个方案引用一个数据集');
  assert.equal(projected.forks, 0);

  const graph = await readGraph(store);
  assert.deepEqual(graph.nodes.map(n => `${n.id}:${n.kind}:${n.status}`).sort(), [
    'a:design:confirmed', 'b:design:confirmed', 'd1:dataset:draft', 'd2:dataset:draft'
  ]);
  assert.deepEqual(graph.edges.map(e => `${e.src}->${e.dst}[${e.role}]`).sort(), ['d1->a[derived]', 'd2->b[derived]']);

  // 校正 d1：只有引用 d1 的方案 a 需要复核，b 引用的是 d2。
  const corrected = await cap(file, 'dataset.correct', {dataset: 'd1', source: 'output/cad/source-c.json'});
  assert.deepEqual(corrected.data.entities.added, ['H4']);
  assert.deepEqual(corrected.data.entities.changed, ['H1']);
  assert.deepEqual(corrected.data.entities.removed, ['H3']);
  assert.equal(corrected.data.review.available, true);
  assert.deepEqual(corrected.data.review.suggested.map(s => s.id), ['a']);

  // 草稿 a#2 不标；已确认 a#1 标待复核——由领域层决定，不由能力层自己判断。
  const impact = impactOf({changed: ['d1'], edges: graph.edges});
  assert.deepEqual(impact.affected.map(a => a.id), ['a']);
  assert.deepEqual(planStale({affected: impact.affected, nodes: graph.nodes}).stale.map(s => s.id), ['a']);
});

test('M2 复制：fork 只记录来源，原方案变化不影响副本', {skip: !sqlite && 'node:sqlite 不可用'}, async () => {
  const {file, store} = tempProject();
  await cap(file, 'dataset.build', {source: 'output/cad/source-a.json', id: 'd1', confirm: true});
  await cap(file, 'design.create', {scheme: 'a', dataset: 'd1'});
  await cap(file, 'design.confirm', {scheme: 'a', seq: 1});

  const forked = await cap(file, 'design.fork', {from: 'a#1', scheme: 'copy'});
  assert.equal(forked.data.forkedFrom.scheme, 'a');
  const copyFile = store.readJson('data/designs/copy/versions/001.json');
  assert.equal(copyFile.parent, null, '复制不继承父链');
  assert.deepEqual(copyFile.forkedFrom, {scheme: 'a', seq: 1});

  const projected = await projectFromFiles(store);
  assert.equal(projected.forks, 1);
  const graph = await readGraph(store);
  assert.ok(graph.edges.some(e => e.src === 'a' && e.dst === 'copy' && e.role === 'fork'));

  // 原方案标待复核，副本不受影响；复制边不传播。
  await cap(file, 'design.stale', {scheme: 'a', seq: 1});
  await projectFromFiles(store);
  const after = await readGraph(store);
  const copyNode = after.nodes.find(n => n.id === 'copy');
  assert.equal(copyNode.status, 'draft', '副本状态不被原方案影响');
  const impact = impactOf({changed: ['a'], edges: after.edges});
  assert.ok(!impact.affected.some(a => a.id === 'copy'), '复制边不传播失效');
});

test('M2 CLI：dataset / design / graph / program 子命令可用', {skip: !sqlite && 'node:sqlite 不可用'}, () => {
  const {dir, file} = tempProject();
  const run = (...args) => space(...args, '--project', file);

  const build = run('dataset', 'build', '--source', 'output/cad/source-a.json', '--id', 'd1', '--confirm');
  assert.equal(build.status, 0, build.stdout + build.stderr);
  assert.match(build.stdout, /预览假设/);
  assert.ok(fs.existsSync(path.join(dir, 'data/datasets/d1/dataset.json')));

  const noConfirm = run('dataset', 'build', '--source', 'output/cad/source-a.json', '--id', 'd9');
  assert.equal(noConfirm.status, 1, '不带 --confirm 必须被拒');
  assert.match(noConfirm.stderr, /confirm|确认/);

  assert.equal(run('design', 'create', '--scheme', 'a', '--dataset', 'd1').status, 0);
  assert.equal(run('design', 'version', '--scheme', 'a', '--note', 'v2').status, 0);
  assert.equal(run('design', 'confirm', '--scheme', 'a', '--seq', '1').status, 0);
  assert.equal(run('design', 'confirm', '--scheme', 'a', '--seq', '2').status, 0);

  const sync = run('graph', 'sync');
  assert.equal(sync.status, 0, sync.stdout + sync.stderr);
  assert.match(sync.stdout, /节点/);

  const show = run('graph', 'show');
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /d1/);
  assert.match(show.stdout, /a\tdesign/);

  const preview = run('graph', 'stale', '--node', 'd1');
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /待复核：a/);
  assert.match(preview.stdout, /只刷新了索引投影/);

  assert.equal(run('design', 'stale', '--scheme', 'a', '--seq', '2').status, 0);
  const again = run('graph', 'stale', '--node', 'd1');
  assert.match(again.stdout, /已是待复核|没有需要标待复核/, '已标过的不重复标');

  const diff = run('dataset', 'diff', '--a', 'd1', '--b', 'd1');
  assert.equal(diff.status, 0, diff.stderr);
  assert.match(diff.stdout, /\+0 -0 ~0/);

  const correct = run('dataset', 'correct', '--dataset', 'd1', '--source', 'output/cad/source-c.json');
  assert.equal(correct.status, 0, correct.stderr);
  assert.match(correct.stdout, /只读预演/);

  // 真实合成示例：拆改/净空/动线检查不误报
  const program = space('program', 'check', '--project', EXAMPLE);
  assert.equal(program.status, 0, program.stdout + program.stderr);
  assert.match(program.stdout, /没有发现问题/);

  const bad = run('dataset', 'nope');
  assert.equal(bad.status, 1);
});

test('M2 校验：design 引用不存在的数据集、非法状态转移都不留文件', {skip: !sqlite && 'node:sqlite 不可用'}, async () => {
  const {file, store} = tempProject();
  await assert.rejects(cap(file, 'design.create', {scheme: 'ghost', dataset: 'missing'}), /E_DATA_REFERENCE|数据集|不存在/);
  assert.equal(store.exists('data/designs/ghost/design.json'), false);

  await cap(file, 'dataset.build', {source: 'output/cad/source-a.json', id: 'd1', confirm: true});
  await cap(file, 'design.create', {scheme: 'a', dataset: 'd1'});
  await assert.rejects(cap(file, 'design.stale', {scheme: 'a', seq: 1}), /E_DATA_RULE|状态|复核/);
  assert.equal(store.readJson('data/designs/a/versions/001.json').status, 'draft');
});

test('一致性：写权威数据后自动刷新投影，不需要手动 graph sync', {skip: !sqlite && 'node:sqlite 不可用'}, async () => {
  const {file, store} = tempProject();
  await cap(file, 'dataset.build', {source: 'output/cad/source-a.json', id: 'd1', confirm: true});

  // 没有手动 projectFromFiles：能力返回时就该带上投影计数
  const created = await cap(file, 'design.create', {scheme: 'a', dataset: 'd1'});
  assert.ok(created.graph, '能力结果里应带投影计数');
  assert.equal(created.graph.nodes, 2);
  assert.equal(created.graph.edges, 1);

  const graph = await readGraph(store);
  assert.deepEqual(graph.nodes.map(n => n.id).sort(), ['a', 'd1']);
  assert.ok(graph.edges.some(e => e.src === 'd1' && e.dst === 'a'));
  assert.ok(store.events().some(e => e.type === 'derived' && e.op === 'graph.sync'), '刷新留一条汇总事件');
});

test('一致性：重建数据集保留确认记录，来源变化只降为待复核', {skip: !sqlite && 'node:sqlite 不可用'}, async () => {
  const {file, store} = tempProject();
  await cap(file, 'dataset.build', {source: 'output/cad/source-a.json', id: 'd1', confirm: true});

  // 模拟人工确认：把状态改 confirmed 并写入两条确认记录
  const rel = 'data/datasets/d1/dataset.json';
  const base = store.readJson(rel);
  store.writeData(rel, JSON.stringify({
    ...base,
    status: 'confirmed',
    confirmations: [
      {object: 'ground', field: 'clearHeight', value: 2700, at: new Date().toISOString(), actor: 'test', basis: '测试'},
      {object: 'H1', field: 'thicknessMm', value: 200, at: new Date().toISOString(), actor: 'test', basis: '测试'}
    ]
  }, null, 2), {baseHash: store.hashOf(rel), confirm: true});

  // 同一来源重建：确认与状态都保留，字节稳定
  const same = await cap(file, 'dataset.build', {source: 'output/cad/source-a.json', id: 'd1', confirm: true});
  const kept = store.readJson(rel);
  assert.equal(kept.status, 'confirmed', '来源没变就不该降级');
  assert.equal(kept.confirmations.length, 2);
  assert.equal(same.data.sourceChanged, false);
  const firstBytes = store.readText(rel);
  await cap(file, 'dataset.build', {source: 'output/cad/source-a.json', id: 'd1', confirm: true});
  assert.equal(store.readText(rel), firstBytes, '同来源重建应字节相同');

  // 换来源重建：确认保留，但状态降为待复核，并提示
  const changed = await cap(file, 'dataset.build', {source: 'output/cad/source-c.json', id: 'd1', confirm: true});
  const after = store.readJson(rel);
  assert.equal(after.status, 'stale', '来源变化后必须待复核');
  assert.equal(after.confirmations.length, 2, '确认记录不能被重建抹掉');
  assert.equal(changed.data.sourceChanged, true);
  assert.equal(changed.data.confirmations, 2);
  assert.match(changed.summary, /待复核/);
});

test('构件级影响：只有用到变化构件的设计版本进复核清单', {skip: !sqlite && 'node:sqlite 不可用'}, async () => {
  const {file} = tempProject();
  await cap(file, 'dataset.build', {source: 'output/cad/source-a.json', id: 'd1', confirm: true});
  await cap(file, 'design.create', {scheme: 'a', dataset: 'd1', uses: 'H1'});
  await cap(file, 'design.create', {scheme: 'b', dataset: 'd1', uses: 'H2'});
  await cap(file, 'design.create', {scheme: 'c', dataset: 'd1'});

  const corrected = await cap(file, 'dataset.correct', {dataset: 'd1', source: 'output/cad/source-c.json'});
  assert.deepEqual(corrected.data.review.changedHandles.sort(), ['H1', 'H3', 'H4']);
  const suggested = corrected.data.review.suggested;
  const byId = Object.fromEntries(suggested.map(s => [s.id, s]));
  assert.ok(byId.a, 'a 用到了变化的 H1');
  assert.deepEqual(byId.a.matched, ['H1']);
  assert.equal(byId.a.reason, 'touches-changed');
  assert.ok(byId.c, 'c 没声明构件，按依赖整个数据集处理');
  assert.equal(byId.c.reason, 'depends-on-dataset');
  assert.ok(!byId.b, 'b 只用到 H2，不受影响');
  assert.deepEqual(corrected.data.review.untouched.map(s => s.id), ['b']);
  assert.match(corrected.summary, /建议复核 2 个设计/);
});

test('构件级影响：版本继承 uses，显式覆盖后按新清单判断', {skip: !sqlite && 'node:sqlite 不可用'}, async () => {
  const {file, store} = tempProject();
  await cap(file, 'dataset.build', {source: 'output/cad/source-a.json', id: 'd1', confirm: true});
  await cap(file, 'design.create', {scheme: 'a', dataset: 'd1', uses: 'H1'});
  await cap(file, 'design.version', {scheme: 'a', note: '继续用 H1'});
  assert.deepEqual(store.readJson('data/designs/a/versions/002.json').uses, ['H1'], '未显式给 uses 时继承');

  await cap(file, 'design.version', {scheme: 'a', note: '改用 H2', uses: 'H2'});
  assert.deepEqual(store.readJson('data/designs/a/versions/003.json').uses, ['H2']);

  const corrected = await cap(file, 'dataset.correct', {dataset: 'd1', source: 'output/cad/source-c.json'});
  assert.ok(!corrected.data.review.suggested.some(s => s.id === 'a'), '最新版本只用 H2，H1 变化不影响');
  assert.equal(corrected.data.review.untouched.find(s => s.id === 'a').status, 'draft');
});
