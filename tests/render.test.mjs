// 彩平图：领域纯函数 + render.colorplan 能力。只用 os.tmpdir() 临时项目，不碰 examples/。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runCapability, createContext} from '../src/capabilities/index.mjs';
import {capabilities as renderCapabilities} from '../src/capabilities/render.mjs';
import {validateRegistry} from '../src/contracts/capability.mjs';
import {normalizeCamera, renderFile, renderRecordFile, validateRender} from '../src/contracts/rendering.mjs';
import {emptyDataset, designVersion} from '../src/contracts/datasets.mjs';
import {buildColorplan, colorplanLayerIds, formatAreaMm2, polygonAreaMm2} from '../src/domain/colorplan.mjs';
import {openStore} from '../src/store/index.mjs';

const MODEL = {
  schema: 'space-model/v1',
  units: 'mm',
  projectId: 'render-demo',
  defaults: {slab: 150},
  floors: [{
    id: 'ground',
    name: '首层',
    elevation: 0,
    clearHeight: 3000,
    wallHeight: 2800,
    slabThickness: 150,
    slab: [{outer: [[0, 0], [5000, 0], [5000, 4000], [0, 4000]]}],
    walls: [{polygon: {outer: [[0, 0], [5000, 0], [5000, 200], [0, 200]]}, thicknessMm: 200}],
    columns: [],
    doors: [{id: 'entry', kind: 'door', label: '入户门', hinge: [1000, 0], closedEnd: [1900, 0], openEnd: [1000, 900], heightMm: 2100, thicknessMm: 100}],
    windowOpenings: [{id: 'living-window', kind: 'window', label: '客厅窗', footprint: [{outer: [[2500, 0], [3600, 0], [3600, 150], [2500, 150]]}], sillMm: 900, headMm: 2400}],
    furniture: [{id: 'sofa', label: '沙发', kind: 'furniture', heightMm: 800, footprint: [{outer: [[500, 1000], [2500, 1000], [2500, 1800], [500, 1800]]}]}]
  }]
};

const EMPTY_MODEL = {
  schema: 'space-model/v1',
  units: 'mm',
  projectId: 'render-empty',
  floors: [{id: 'ground', name: '首层', elevation: 0, clearHeight: 2800, wallHeight: 2700, slabThickness: 120}]
};

// 临时项目：数据集、设计版本与模型都直接落盘（测试造数据允许用 fs）。
function tempProject(model) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-render-'));
  const file = path.join(dir, 'project.json');
  const write = (rel, value) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), {recursive: true});
    fs.writeFileSync(abs, JSON.stringify(value, null, 2));
  };
  fs.writeFileSync(file, JSON.stringify({schema: 'space-project/v1', id: 'render-demo', output: 'output'}, null, 2));
  write('data/datasets/d1/dataset.json', emptyDataset({
    id: 'd1', model: 'data/datasets/d1/model.json', sources: [{file: 'plan.dxf'}], at: '2026-01-01T00:00:00.000Z'
  }));
  write('data/datasets/d1/model.json', model);
  write('data/designs/a/versions/001.json', designVersion({
    scheme: 'a', seq: 1, dataset: 'd1', status: 'confirmed', at: '2026-01-01T00:00:00.000Z'
  }));
  return {dir, file, store: () => openStore(file)};
}

// render.mjs 还没接进 capabilities/index.mjs，测试直接跑能力实现（接线由主控负责）。
async function cap(project, params = {}) {
  const ctx = createContext(project);
  const capability = renderCapabilities.find(c => c.id === 'render.colorplan');
  return capability.run({...ctx, store: ctx.store.scope(capability.id)}, {scheme: 'a', seq: 1, ...params});
}

const layerOrder = (svg) => [...svg.matchAll(/data-layer="([^"]+)"/g)].map(m => m[1]);

test('能力契约齐全：render.colorplan 字段与错误码都合规', () => {
  assert.deepEqual(validateRegistry(renderCapabilities), []);
  const capability = renderCapabilities.find(c => c.id === 'render.colorplan');
  assert.equal(capability.stage, 'delivery');
  assert.deepEqual(capability.sideEffects, ['write:artifact']);
  assert.equal(capability.idempotent, true);
  assert.ok(capability.params.some(p => p.key === 'force'));
});

test('彩平图：同一模型两次生成 SVG 字节相同，第二次不重写', async () => {
  const project = tempProject(MODEL);
  const first = await cap(project.file);
  assert.equal(first.data.kind, 'colorplan');
  assert.equal(first.data.layers.length, colorplanLayerIds().length);
  const svg = project.store().readText(first.data.file);
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(svg), '产物里不能出现时间戳');
  assert.match(svg, /<g data-layer="slab"/);
  assert.match(svg, /入户门|客厅窗|沙发/);

  const second = await cap(project.file);
  assert.equal(second.data.unchanged, true);
  assert.equal(project.store().readText(first.data.file), svg, '第二次不应改动产物');

  // 换个项目目录、同样的模型与参数：字节必须一致（渲染只取决于输入）
  const other = tempProject(MODEL);
  const again = await cap(other.file);
  assert.equal(again.data.sha256, first.data.sha256);
  assert.equal(other.store().readText(again.data.file), svg);

  // 领域函数本身也是确定性的
  assert.equal(buildColorplan(MODEL).svg, buildColorplan(MODEL).svg);
});

test('产物路径与登记：符合 renderFile 规则，记录通过 validateRender', async () => {
  const project = tempProject(MODEL);
  const r = await cap(project.file, {theme: 'cool', floor: 'ground'});
  assert.equal(r.data.file, renderFile({kind: 'colorplan', scheme: 'a', seq: 1}));
  assert.equal(r.data.file, 'output/render/colorplan/a-001.svg');
  assert.equal(r.data.recordFile, renderRecordFile({kind: 'colorplan', scheme: 'a', seq: 1}));
  assert.equal(r.data.recordFile, 'output/render/colorplan/a-001.json');
  assert.equal(r.data.theme, '冷调');

  const store = project.store();
  const files = store.files().files;
  assert.equal(files[r.data.file].sha256, r.data.sha256, '产物要登记进 store.files');
  assert.equal(files[r.data.recordFile].sha256, r.data.recordSha256, '渲染记录也要登记');

  const record = store.readJson(r.data.recordFile);
  assert.deepEqual(validateRender(record), []);
  assert.equal(record.kind, 'colorplan');
  assert.equal(record.deterministic, true);
  assert.equal(record.file, r.data.file);
  assert.equal(record.bytes, r.data.bytes);
  assert.equal(record.inputs.design.scheme, 'a');
  assert.equal(record.inputs.design.seq, 1);
  assert.equal(record.inputs.dataset.id, 'd1');
  assert.match(record.inputs.dataset.sha256, /^[0-9a-f]{64}$/);
  assert.match(record.inputs.model.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(record.camera, normalizeCamera());
  assert.deepEqual(record.style, {base: null, style: null});
});

test('没有 slab/walls/furniture 也能出图：空平面 + 图例', async () => {
  const built = buildColorplan(EMPTY_MODEL);
  assert.match(built.svg, /data-layer="slab"/, '空平面也要有底面');
  assert.match(built.svg, /data-layer="legend"/);
  assert.match(built.svg, /图例/);
  assert.match(built.svg, /合计面积 0\.0 ㎡/);
  assert.equal(built.stats.areaM2, 0);
  assert.equal(built.stats.slabs, 0);
  assert.deepEqual(built.layers.map(l => l.id), colorplanLayerIds());
  assert.equal(buildColorplan(EMPTY_MODEL).svg, built.svg);

  // 能力层：空模型同样能落盘，图层顺序固定为 slab → … → text → legend
  const project = tempProject(EMPTY_MODEL);
  const r = await cap(project.file);
  const svg = project.store().readText(r.data.file);
  const order = layerOrder(svg);
  assert.equal(order[0], 'slab');
  assert.deepEqual(order.slice(-2), ['text', 'legend']);
  assert.equal(order.indexOf('walls'), -1, '没有墙就不该出现空图层');
  assert.deepEqual(validateRender(project.store().readJson(r.data.recordFile)), []);
});

test('面积：鞋带公式（5000×4000 = 20.0 ㎡），holes 扣掉', () => {
  const rect = {outer: [[0, 0], [5000, 0], [5000, 4000], [0, 4000]]};
  assert.equal(polygonAreaMm2(rect), 20e6);
  assert.equal(formatAreaMm2(20e6), '20.0 ㎡');
  const withHole = {outer: rect.outer, holes: [[[0, 0], [1000, 0], [1000, 1000], [0, 1000]]]};
  assert.equal(polygonAreaMm2(withHole), 19e6);

  const {svg, stats} = buildColorplan(MODEL);
  assert.match(svg, /面积 20\.0 ㎡/);
  assert.equal(stats.areaM2, 20);
  assert.equal(stats.slabs, 1);
  assert.equal(stats.surfaces[0].areaM2, 20);
  assert.match(svg, /首层 彩平图/, '图名默认取楼层名（数据），不写死项目信息');
});

test('设计版本变化：不带 force 被拒（E_DATA_RULE），force 重出后记录哈希变化', async () => {
  const project = tempProject(MODEL);
  const first = await cap(project.file);
  const before = project.store().readText(first.data.file);

  const versionFile = path.join(project.dir, 'data/designs/a/versions/001.json');
  const version = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
  fs.writeFileSync(versionFile, JSON.stringify({...version, status: 'stale'}, null, 2));

  await assert.rejects(cap(project.file), (e) => {
    assert.equal(e.code, 'E_DATA_RULE');
    assert.match(e.message, /force/);
    return true;
  });
  assert.equal(project.store().readText(first.data.file), before, '被拒时不得改动产物');
  assert.equal(project.store().readJson(first.data.recordFile).inputs.design.status, 'confirmed');

  const forced = await cap(project.file, {force: true});
  assert.equal(forced.data.unchanged, false);
  assert.equal(forced.data.sha256, first.data.sha256, '楼层几何没变，SVG 不该变');
  assert.notEqual(forced.data.recordSha256, first.data.recordSha256, '输入链变了，渲染记录必须变');
  const record = project.store().readJson(forced.data.recordFile);
  assert.equal(record.inputs.design.status, 'stale');
  assert.deepEqual(validateRender(record), []);
});

test('空间模型变化：不带 force 被拒，force 重出后 SVG 哈希变化', async () => {
  const project = tempProject(MODEL);
  const first = await cap(project.file);

  const modelFile = path.join(project.dir, 'data/datasets/d1/model.json');
  const model = JSON.parse(fs.readFileSync(modelFile, 'utf8'));
  model.floors[0].slab = [{outer: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]]}];
  fs.writeFileSync(modelFile, JSON.stringify(model, null, 2));

  await assert.rejects(cap(project.file), (e) => {
    assert.equal(e.code, 'E_DATA_RULE');
    return true;
  });

  const forced = await cap(project.file, {force: true});
  assert.notEqual(forced.data.sha256, first.data.sha256, '模型变了产物应变');
  assert.equal(forced.data.areaM2, 24);
  assert.match(project.store().readText(forced.data.file), /面积 24\.0 ㎡/);
});

test('未实现的图种：render.interior 被拒（E_EXEC_NOT_IMPLEMENTED，已登记但未实现）', async () => {
  // 预期行为：contracts/rendering.mjs 里 interior 的 implemented=false，只有契约、没有能力。
  // 主控把 render.mjs 接进注册表后，这里仍应保持同样的拒绝（能力只导出 colorplan）。
  const project = tempProject(MODEL);
  assert.equal(renderCapabilities.some(c => c.id === 'render.interior'), false);
  await assert.rejects(runCapability({project: project.file, capability: 'render.interior'}), (e) => {
    assert.equal(e.code, 'E_EXEC_NOT_IMPLEMENTED', '已登记但未实现：与「未知能力」区分开');
    return true;
  });
});
