import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runCapability} from '../src/capabilities/index.mjs';
import {openStore} from '../src/store/index.mjs';
import {validateManifest, docManifestFile} from '../src/contracts/documents.mjs';

const BIN = fileURLToPath(new URL('../bin/space.mjs', import.meta.url));
const space = (...args) => spawnSync(process.execPath, [BIN, ...args], {encoding: 'utf8'});
const cap = (project, capability, params = {}) => runCapability({project, capability, params});

const SOURCE = {
  schema: 'cad-source/v1',
  source: {file: 'plan.dxf'},
  entities: [
    {id: 'E1', handle: 'H1', type: 'LINE', layer: 'WALL', points: [[0, 0], [6000, 0]]},
    {id: 'E2', handle: 'H2', type: 'LINE', layer: 'WALL', points: [[0, 0], [0, 4000]]}
  ],
  issues: []
};

const MODEL = {
  schema: 'space-model/v1',
  units: 'mm',
  projectId: 'doc-demo',
  defaults: {slab: 150},
  floors: [{
    id: 'ground',
    name: '首层',
    elevation: 0,
    clearHeight: 3000,
    wallHeight: 2800,
    slabThickness: 150,
    slab: [], columns: [], doors: [], windowOpenings: [], furniture: [], trace: [],
    walls: [
      {handle: 'W1', polygon: {outer: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]]}, thicknessMm: 200},
      {handle: 'W2', polygon: {outer: [[3000, 0], [3000, 2500]]}, thicknessMm: 100, demolition: true},
      {handle: 'W3', polygon: {outer: [[0, 2500], [2000, 2500]]}, thicknessMm: 100, built: false}
    ]
  }]
};

async function tempProject({withWalls = true} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-doc-'));
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({schema: 'space-project/v1', id: 'doc-demo', output: 'output'}, null, 2));
  fs.mkdirSync(path.join(dir, 'output/cad'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'output/cad/source-a.json'), JSON.stringify(SOURCE));
  const file = path.join(dir, 'project.json');
  await cap(file, 'dataset.build', {source: 'output/cad/source-a.json', id: 'd1', confirm: true});
  await cap(file, 'design.create', {scheme: 'a', dataset: 'd1'});
  await cap(file, 'design.confirm', {scheme: 'a', seq: 1});
  if (withWalls) {
    fs.writeFileSync(path.join(dir, 'data/datasets/d1/model.json'), JSON.stringify(MODEL, null, 2));
    openStore(file).rebuild({op: 'test.model'});
  }
  return {dir, file, store: openStore(file)};
}

test('拆改图：同输入两次生成产物字节相同，第二次不重写', async () => {
  const one = await tempProject();
  const first = await cap(one.file, 'doc.wall-demolition', {scheme: 'a', seq: 1});
  assert.equal(first.data.kind, 'wall-demolition');
  assert.match(first.data.file, /^output\/doc\/wall-demolition\/a-001\.svg$/);
  assert.deepEqual(first.data.layers, ['frame', 'wall-existing', 'wall-demolish', 'wall-new', 'dimension', 'note']);

  const svg = one.store.readText(first.data.file);
  assert.match(svg, /拆除/);
  assert.match(svg, /新建/);
  assert.match(svg, /data-layer="wall-demolish"/);
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(svg), '产物里不能出现时间戳');

  const second = await cap(one.file, 'doc.wall-demolition', {scheme: 'a', seq: 1});
  assert.equal(second.data.unchanged, true);
  assert.equal(one.store.readText(first.data.file), svg, '第二次不应改动产物');

  // 同样的输入换一个项目目录：产物哈希必须一致
  const two = await tempProject();
  const other = await cap(two.file, 'doc.wall-demolition', {scheme: 'a', seq: 1});
  assert.equal(other.data.sha256, first.data.sha256, '同输入产物哈希应一致');
});

test('交付清单：记录输入版本链与确认值，能回答「基于哪版」', async () => {
  const {file, store} = await tempProject();
  await cap(file, 'annotation.confirm', {dataset: 'd1', object: 'ground', field: 'clearHeight', value: 2750, basis: '图纸标注'});
  const r = await cap(file, 'doc.wall-demolition', {scheme: 'a', seq: 1, scale: 100, title: '拆改图'});
  assert.equal(r.data.scale, 100);

  const manifest = store.readJson(docManifestFile());
  assert.deepEqual(validateManifest(manifest), []);
  const record = manifest.docs['wall-demolition:a:1'];
  assert.equal(record.file, r.data.file);
  assert.equal(record.sha256, r.data.sha256);
  assert.equal(record.generator.id, 'doc.wall-demolition');
  assert.equal(record.inputs.design.scheme, 'a');
  assert.equal(record.inputs.design.seq, 1);
  assert.equal(record.inputs.design.status, 'confirmed');
  assert.equal(record.inputs.dataset.id, 'd1');
  assert.match(record.inputs.dataset.sha256, /^[0-9a-f]{64}$/);
  assert.match(record.inputs.model.sha256, /^[0-9a-f]{64}$/);
  assert.equal(record.inputs.confirmations.length, 1);
  assert.equal(record.inputs.confirmations[0].value, 2750);
  assert.equal(record.inputs.confirmations[0].basis, '图纸标注');
  assert.equal(record.inputs.params.scale, 100);

  const list = await cap(file, 'doc.list');
  assert.equal(list.data.summary.total, 1);
  assert.deepEqual(list.data.kinds.map(k => `${k.id}:${k.implemented}`), ['wall-demolition:true', 'mep:false', 'furniture:false']);
});

test('设计/模型变化：先标待复核，重出必须显式 force', async () => {
  const {dir, file} = await tempProject();
  const first = await cap(file, 'doc.wall-demolition', {scheme: 'a', seq: 1});
  assert.equal((await cap(file, 'doc.check')).data.stale, 0);

  // 模型变化
  const model = JSON.parse(fs.readFileSync(path.join(dir, 'data/datasets/d1/model.json'), 'utf8'));
  model.floors[0].walls.push({handle: 'W4', polygon: {outer: [[0, 4000], [6000, 4000]]}, thicknessMm: 200});
  fs.writeFileSync(path.join(dir, 'data/datasets/d1/model.json'), JSON.stringify(model, null, 2));
  openStore(file).rebuild({op: 'test.model'});

  const checked = await cap(file, 'doc.check');
  assert.equal(checked.data.stale, 1);
  assert.match(checked.data.docs[0].reasons.join('；'), /空间模型已变化/);
  assert.equal(checked.summary.includes('待复核'), true);

  await assert.rejects(cap(file, 'doc.wall-demolition', {scheme: 'a', seq: 1}), (e) => {
    assert.equal(e.code, 'E_DATA_RULE');
    assert.match(e.message, /force/);
    return true;
  });

  const forced = await cap(file, 'doc.wall-demolition', {scheme: 'a', seq: 1, force: true});
  assert.notEqual(forced.data.sha256, first.data.sha256, '模型变了产物应变');
  const after = await cap(file, 'doc.check');
  assert.equal(after.data.stale, 0, '重出之后回到一致');

  // 设计版本被标待复核，交付物也跟着待复核
  await cap(file, 'design.stale', {scheme: 'a', seq: 1});
  const staleDesign = await cap(file, 'doc.check');
  assert.equal(staleDesign.data.stale, 1);
  assert.match(staleDesign.data.docs[0].reasons.join('；'), /设计版本已标待复核|状态/);
});

test('未实现的图种只有契约：调用会按未知能力拒绝', async () => {
  const {file} = await tempProject();
  for (const id of ['doc.mep', 'doc.furniture']) {
    await assert.rejects(cap(file, id), (e) => {
      assert.equal(e.code, 'E_EXEC_NOT_IMPLEMENTED', '已登记但未实现：与「未知能力」区分开');
      return true;
    });
  }
  const list = await cap(file, 'doc.list');
  assert.equal(list.data.kinds.find(k => k.id === 'mep').implemented, false);
});

test('缺设计版本或数据集时给出可读错误', async () => {
  const {file} = await tempProject();
  await assert.rejects(cap(file, 'doc.wall-demolition', {scheme: 'nope', seq: 1}), /设计版本不存在/);
  await assert.rejects(cap(file, 'doc.wall-demolition', {scheme: 'a', seq: 9}), /设计版本不存在/);
  await assert.rejects(cap(file, 'doc.wall-demolition', {scheme: 'a', seq: 0}), /正整数/);
});

test('space doc render / check / list 可用', async () => {
  const {file} = await tempProject();
  const render = space('doc', 'render', '--project', file, '--scheme', 'a', '--seq', '1');
  assert.equal(render.status, 0, render.stdout + render.stderr);
  assert.match(render.stdout, /拆改图 · a#001/);
  assert.match(render.stdout, /比例 1:100/);

  const check = space('doc', 'check', '--project', file);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /全部与输入一致/);

  const listed = space('doc', 'list', '--project', file);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /拆改图/);
  assert.match(listed.stdout, /水电图（只有契约与图层规范，未出图）/);

  const bad = space('doc', 'render', '--project', file, '--scheme', 'ghost', '--seq', '1');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /设计版本不存在/);
});
