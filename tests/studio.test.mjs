import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {listCapabilities, resolveInside, projectOverview, runCapability} from '../src/capabilities/index.mjs';
import {buildIndex, sqliteAvailable} from '../src/indexer/index.mjs';
import {startStudio} from '../src/server/studio.mjs';

const PROJECT = new URL('../examples/two-level/project.json', import.meta.url).pathname;
const DIR = path.dirname(PROJECT);

test('能力注册表：id 唯一、阶段合法、参数与实现齐全', () => {
  const caps = listCapabilities();
  const ids = caps.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length);
  const stages = new Set(['source', 'data', 'design', 'model', 'delivery']);
  for (const c of caps) {
    assert.ok(stages.has(c.stage), `${c.id} 阶段不合法`);
    assert.ok(c.title && c.description, `${c.id} 缺少标题或说明`);
    assert.ok(Array.isArray(c.params), `${c.id} 缺少 params`);
    assert.equal(c.run, undefined, 'listCapabilities 不应暴露实现');
  }
  for (const id of ['cad.inspect', 'cad.preview', 'model.validate', 'build.viewer', 'model.preview', 'model.convert']) {
    assert.ok(ids.includes(id), `缺少能力 ${id}`);
  }
});

test('路径守卫：项目内允许，越界拒绝', () => {
  assert.equal(resolveInside(DIR, 'data/model.json'), path.join(DIR, 'data/model.json'));
  assert.throws(() => resolveInside(DIR, '../outside.json'), /越界/);
  assert.throws(() => resolveInside(DIR, '/etc/passwd'), /越界/);
});

test('项目概览包含目录规范结果与文件清单', () => {
  const o = projectOverview(PROJECT);
  assert.equal(o.project.id, 'two-level');
  assert.equal(o.lint.passed, true);
  assert.ok(o.files.includes('data/model.json'));
  assert.ok(o.files.some(f => f.startsWith('output/')));
});

test('能力可被无头调用：空间数据校验', async () => {
  const r = await runCapability({project: PROJECT, capability: 'model.validate', params: {}});
  assert.equal(r.ok, undefined, 'result 由调用方包装');
  assert.equal(r.data.passed, true);
  assert.equal(r.summary, '通过');
});

test('能力拒绝不存在的模型文件', async () => {
  await assert.rejects(
    runCapability({project: PROJECT, capability: 'model.preview', params: {file: 'data/not-there.glb'}}),
    /文件不存在/
  );
});

test('工作台服务：外壳、能力清单与打包后的前端可访问', async () => {
  const server = await startStudio({project: PROJECT, port: 0});
  try {
    const html = await (await fetch(server.url)).text();
    assert.match(html, /__STUDIO_PROJECT__/);
    assert.match(html, /\/app\.js/);
    const caps = await (await fetch(new URL('/api/capabilities', server.url))).json();
    assert.ok(caps.capabilities.length >= 6);
    const js = await (await fetch(new URL('/app.js', server.url))).text();
    assert.ok(js.length > 50000, '前端 bundle 过小，可能没有打包依赖');
    assert.match(js, /createModelStage|户型工作台/);
    const project = await (await fetch(new URL('/api/project?path=' + encodeURIComponent(PROJECT), server.url))).json();
    assert.equal(project.project.id, 'two-level');
  } finally {
    await server.close();
  }
});

test('文件接口只允许项目内路径', async () => {
  const server = await startStudio({project: PROJECT, port: 0});
  try {
    const ok = await fetch(new URL(`/api/file?project=${encodeURIComponent(PROJECT)}&path=${encodeURIComponent('data/model.json')}`, server.url));
    assert.equal(ok.status, 200);
    const bad = await fetch(new URL(`/api/file?project=${encodeURIComponent(PROJECT)}&path=${encodeURIComponent('../package.json')}`, server.url));
    assert.equal(bad.status, 500);
  } finally {
    await server.close();
  }
});

test('build.viewer 经能力生成白模，只写项目内 output/', async () => {
  // 用临时副本，避免与并行用例共用示例目录
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-build-'));
  const proj = path.join(base, 'two-level');
  fs.mkdirSync(path.join(proj, 'data'), {recursive: true});
  fs.copyFileSync(path.join(DIR, 'data/model.json'), path.join(proj, 'data/model.json'));
  fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify({
    schema: 'space-project/v1', id: 'two-level', name: '构建用例', model: 'data/model.json',
    output: 'output', assets: path.join(DIR, '../../src/furniture/assets/catalog.json')
  }));
  const r = await runCapability({project: path.join(proj, 'project.json'), capability: 'build.viewer', params: {viewer: 'drawing'}});
  assert.match(r.summary, /平面核对\.html$/);
  assert.ok(fs.existsSync(path.join(proj, r.data.file)));
  assert.ok(!fs.existsSync(path.join(proj, '平面核对.html')), '生成物不得落到项目根');
});

const sqlite = await sqliteAvailable();

function indexedProject(entities) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-studio-index-'));
  const dir = path.join(base, 'indexed');
  fs.mkdirSync(path.join(dir, 'data'), {recursive: true});
  fs.mkdirSync(path.join(dir, 'output/cad'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    schema: 'space-project/v1', id: 'two-level', name: '视口用例', model: 'data/model.json', output: 'output'
  }));
  fs.writeFileSync(path.join(dir, 'data/model.json'), fs.readFileSync(path.join(DIR, 'data/model.json')));
  fs.writeFileSync(path.join(dir, 'output/cad/source.json'), JSON.stringify({schema: 'cad-source/v1', source: {file: 'plan.dxf'}, entities, issues: []}));
  return {dir, file: path.join(dir, 'project.json')};
}

test('工作台视口取数：索引摘要、包围盒分页、坏参数被拒', {skip: !sqlite && 'node:sqlite 不可用'}, async () => {
  const entities = [];
  for (let i = 0; i < 300; i++) {
    const x = (i % 30) * 1000, y = Math.floor(i / 30) * 1000;
    entities.push({id: `E${i}`, type: 'LINE', layer: i % 2 ? 'WALL' : 'DIM', points: [[x, y], [x + 800, y + 300]]});
  }
  const {file} = indexedProject(entities);
  const {openStore} = await import('../src/store/index.mjs');
  await buildIndex(openStore(file), {source: 'output/cad/source.json', op: 'test.index'});

  const server = await startStudio({project: file, port: 0});
  const q = (params) => fetch(new URL('/api/' + params, server.url));
  try {
    const stat = await (await q(`index?project=${encodeURIComponent(file)}`)).json();
    assert.equal(stat.available, true);
    assert.equal(stat.present, true);
    assert.equal(stat.entities, 300);
    assert.equal(stat.layers, 2);
    assert.equal(stat.nodes.dataset, 1, '数据集节点已登记');

    const page = await (await q(`entities?project=${encodeURIComponent(file)}&box=0,0,30000,4000&limit=40`)).json();
    assert.equal(page.available, true);
    assert.equal(page.rows.length, 40);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextOffset, 40);
    assert.deepEqual(Object.keys(page.rows[0]).sort(), ['handle', 'layer', 'maxx', 'maxy', 'minx', 'miny', 'type']);
    assert.ok(!('points' in page.rows[0]), '视口取数不传完整几何');

    const second = await (await q(`entities?project=${encodeURIComponent(file)}&box=0,0,30000,4000&limit=40&offset=40`)).json();
    assert.notDeepEqual(second.rows.map(r => r.handle), page.rows.map(r => r.handle));

    const counted = await (await q(`entities?project=${encodeURIComponent(file)}&box=0,0,30000,4000&limit=5&count=1`)).json();
    assert.ok(counted.total > 40);

    const full = JSON.stringify(entities);
    assert.ok(JSON.stringify(page).length < full.length / 3, '一页视口数据应远小于整包 JSON');

    const bad = await q(`entities?project=${encodeURIComponent(file)}&box=1,2`);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /box/);

    const missing = await q('entities?box=0,0,1,1');
    assert.equal(missing.status, 400);

    const noIndex = await q(`index?project=${encodeURIComponent(path.join(DIR, 'project.json'))}`);
    assert.equal(noIndex.status, 200);
  } finally {
    await server.close();
  }
});
