import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runCapability} from '../src/capabilities/index.mjs';
import {openStore} from '../src/store/index.mjs';
import {validateBundle, validateRender, validateSnapshot, bundleManifestFile, snapshotFile, isGenerated} from '../src/contracts/index.mjs';

const BIN = fileURLToPath(new URL('../bin/space.mjs', import.meta.url));
const space = (...args) => spawnSync(process.execPath, [BIN, ...args], {encoding: 'utf8'});
const cap = (project, capability, params = {}) => runCapability({project, capability, params});

const MODEL = {
  schema: 'space-model/v1',
  units: 'mm',
  projectId: 'm4-demo',
  defaults: {slab: 150},
  floors: [{
    id: 'ground', name: '首层', elevation: 0, clearHeight: 3000, wallHeight: 2800, slabThickness: 150,
    slab: [{outer: [[0, 0], [5000, 0], [5000, 4000], [0, 4000]], holes: []}],
    walls: [
      {handle: 'W1', polygon: {outer: [[0, 0], [5000, 0], [5000, 4000], [0, 4000]]}, thicknessMm: 200},
      {handle: 'W2', polygon: {outer: [[2500, 0], [2500, 2500]]}, thicknessMm: 100, demolition: true}
    ],
    columns: [], doors: [], windowOpenings: [],
    furniture: [{id: 'sofa', kind: 'sofa', footprint: [{outer: [[100, 100], [2100, 100], [2100, 900], [100, 900]], holes: []}], heightMm: 800}],
    trace: []
  }]
};

async function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-m4-'));
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({schema: 'space-project/v1', id: 'm4-demo', output: 'output'}, null, 2));
  fs.mkdirSync(path.join(dir, 'output/cad'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'output/cad/source-a.json'), JSON.stringify({
    schema: 'cad-source/v1', source: {file: 'plan.dxf'},
    entities: [{id: 'E1', handle: 'H1', type: 'LINE', layer: 'WALL', points: [[0, 0], [5000, 0]]}],
    issues: []
  }));
  const file = path.join(dir, 'project.json');
  await cap(file, 'dataset.build', {source: 'output/cad/source-a.json', id: 'd1', confirm: true});
  await cap(file, 'design.create', {scheme: 'a', dataset: 'd1'});
  await cap(file, 'design.confirm', {scheme: 'a', seq: 1});
  fs.writeFileSync(path.join(dir, 'data/datasets/d1/model.json'), JSON.stringify(MODEL, null, 2));
  const store = openStore(file);
  store.rebuild({op: 'test.model'});
  return {dir, file, store};
}

test('M4 链路：拆改图 → 彩平图 → 交付包 → 只读快照', async () => {
  const {file, store} = await tempProject();

  const doc = await cap(file, 'doc.wall-demolition', {scheme: 'a', seq: 1});
  assert.ok(store.exists(doc.data.file));

  const plan = await cap(file, 'render.colorplan', {scheme: 'a', seq: 1});
  const svg = store.readText(plan.data.file);
  assert.match(plan.data.file, /^output\/render\/colorplan\/a-001\.svg$/);
  assert.match(svg, /㎡/, '彩平要写面积');
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(svg), '渲染产物里不能有时间戳');
  assert.deepEqual(validateRender(store.readJson(plan.data.file.replace(/\.svg$/, '.json'))), []);

  const bundle = await cap(file, 'bundle.export', {scheme: 'a', seq: 1, name: 'v1'});
  const manifest = store.readJson(bundleManifestFile('v1'));
  assert.deepEqual(validateBundle(manifest), []);
  assert.ok(manifest.readOnly);
  const roles = new Set(manifest.entries.map(e => e.role));
  for (const role of ['design', 'dataset', 'model', 'document', 'render']) assert.ok(roles.has(role), `交付包缺少 ${role}`);
  for (const entry of manifest.entries) {
    assert.equal(store.hashOf(path.posix.join('output/bundle/v1', entry.path)), entry.sha256, `${entry.path} 哈希与源不一致`);
  }

  const snapshot = await cap(file, 'deliver.snapshot', {scheme: 'a', seq: 1, name: 'v1'});
  const html = store.readText(snapshotFile('v1'));
  assert.match(html, /只读/);
  assert.match(html, /哈希/);
  assert.deepEqual(validateSnapshot(store.readJson('output/snapshot/v1.json')), []);

  // 同一输入重出快照：字节一致（内容里可以有权威数据自带的确认时间）
  await cap(file, 'deliver.snapshot', {scheme: 'a', seq: 1, name: 'v1', force: true});
  assert.equal(store.readText(snapshotFile('v1')), html, '同输入快照应字节一致');

  // 生成物全在 output/ 下，写权限守卫成立
  for (const rel of [plan.data.file, snapshotFile('v1'), bundleManifestFile('v1')]) assert.equal(isGenerated(rel), true);
  assert.equal(store.verify().ok, true);

  // 验收：快照里的哈希与源项目一致
  const designSha = store.hashOf('data/designs/a/versions/001.json');
  assert.ok(html.includes(designSha), '快照哈希清单要包含设计版本哈希');

  // 验收：生成图不能反向覆盖数据——所有写入都落在 output/，data/ 一个字节都没变
  const after = store.files().files;
  for (const rel of Object.keys(after)) {
    if (rel.startsWith('data/') || rel === 'project.json') assert.ok(!isGenerated(rel));
  }
  for (const [rel, entry] of Object.entries(after)) {
    if (rel.startsWith('output/')) continue;
    assert.equal(store.hashOf(rel), entry.sha256, `${rel} 在渲染/交付过程中被改了`);
  }
});

test('M4 确定性：同输入重复渲染与打包，哈希一致', async () => {
  const one = await tempProject();
  const first = await cap(one.file, 'render.colorplan', {scheme: 'a', seq: 1});
  const again = await cap(one.file, 'render.colorplan', {scheme: 'a', seq: 1});
  assert.equal(again.data.unchanged ?? true, true);
  assert.equal(one.store.hashOf(first.data.file), first.data.sha256);

  const two = await tempProject();
  const other = await cap(two.file, 'render.colorplan', {scheme: 'a', seq: 1});
  assert.equal(other.data.sha256, first.data.sha256, '同输入彩平哈希应一致');

  await cap(one.file, 'bundle.export', {scheme: 'a', seq: 1, name: 'x'});
  await cap(one.file, 'bundle.export', {scheme: 'a', seq: 1, name: 'y'});
  const listOf = (name) => one.store.readJson(bundleManifestFile(name)).entries.map(e => `${e.path}:${e.role}:${e.sha256}`);
  assert.deepEqual(listOf('x'), listOf('y'), '同名输入的两个包，条目与哈希应一致');
});

test('M4 未实现图种：效果图只有契约', async () => {
  const {file} = await tempProject();
  await assert.rejects(cap(file, 'render.interior'), (e) => {
    assert.equal(e.code, 'E_EXEC_NOT_IMPLEMENTED', '已登记但未实现：与「未知能力」区分开');
    return true;
  });
});

test('M4 CLI：render / bundle / deliver 可用', async () => {
  const {file} = await tempProject();
  const render = space('render', 'colorplan', '--project', file, '--scheme', 'a', '--seq', '1');
  assert.equal(render.status, 0, render.stdout + render.stderr);
  assert.match(render.stdout, /彩平/);

  space('doc', 'render', '--project', file, '--scheme', 'a', '--seq', '1');
  const bundle = space('bundle', 'export', '--project', file, '--scheme', 'a', '--seq', '1', '--name', 'cli');
  assert.equal(bundle.status, 0, bundle.stdout + bundle.stderr);
  assert.match(bundle.stdout, /output\/bundle\/cli\/manifest\.json/);

  const snapshot = space('deliver', 'snapshot', '--project', file, '--scheme', 'a', '--seq', '1', '--name', 'cli');
  assert.equal(snapshot.status, 0, snapshot.stdout + snapshot.stderr);
  assert.match(snapshot.stdout, /output\/snapshot\/cli\.html/);

  const bad = space('render', 'interior', '--project', file);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /只有契约/);
});
