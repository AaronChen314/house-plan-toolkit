import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {listCapabilities, resolveInside, projectOverview, runCapability} from '../src/capabilities/index.mjs';
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

test('build.viewer 经能力生成白模并写入项目 output/', async () => {
  const r = await runCapability({project: PROJECT, capability: 'build.viewer', params: {viewer: 'drawing'}});
  assert.match(r.summary, /平面核对\.html$/);
  assert.ok(fs.existsSync(path.join(DIR, r.data.file)));
});
