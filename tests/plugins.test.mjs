import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PLUGIN_SCHEMA, validatePluginManifest, pluginsEnabled, validatePluginIdFree} from '../src/contracts/index.mjs';
import {pluginDirs} from '../src/capabilities/plugins.mjs';
import {initPlugins, listCapabilities, checkCapabilities, pluginSummary, getCapability, runCapability} from '../src/capabilities/index.mjs';
import {startStudio} from '../src/server/studio.mjs';

const BIN = fileURLToPath(new URL('../bin/space.mjs', import.meta.url));
const space = (...args) => spawnSync(process.execPath, [BIN, ...args], {encoding: 'utf8'});

const CAPABILITY = (id, title = '插件能力') => `export const capabilities = [{
  id: '${id}',
  version: '1.0.0',
  stage: 'data',
  title: '${title}',
  description: '插件提供的只读能力。',
  params: [],
  inputs: {},
  outputs: {},
  sideEffects: ['none'],
  requires: [],
  idempotent: true,
  errors: ['E_STORE_PROJECT'],
  async run(ctx) { return {summary: 'ok', outputs: [], data: {files: Object.keys(ctx.store.files().files).length}}; }
}];`;

function pluginProject({dirId = 'demo', capId = 'demo.count', manifest = {}} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-plugin-'));
  const projectDir = path.join(base, 'proj');
  const pluginDir = path.join(projectDir, 'plugins', dirId);
  fs.mkdirSync(pluginDir, {recursive: true});
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({schema: 'space-project/v1', id: 'plugin-demo', output: 'output'}));
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
    schema: PLUGIN_SCHEMA, id: dirId, name: '示例插件', version: '1.0.0', entry: 'index.mjs', ...manifest
  }, null, 2));
  fs.writeFileSync(path.join(pluginDir, 'index.mjs'), CAPABILITY(capId));
  return {base, projectFile: path.join(projectDir, 'project.json'), projectDir, pluginDir};
}

test('插件清单：字段、id、版本、入口越界都被拒', () => {
  const good = {schema: PLUGIN_SCHEMA, id: 'demo', name: '示例', version: '1.0.0', entry: 'index.mjs'};
  assert.deepEqual(validatePluginManifest(good), []);
  assert.match(validatePluginManifest({...good, schema: 'x'}).join(), /space-plugin/);
  assert.match(validatePluginManifest({...good, id: 'Demo_1'}).join(), /插件 id/);
  assert.match(validatePluginManifest({...good, version: '1.0'}).join(), /版本/);
  assert.match(validatePluginManifest({...good, entry: '../evil.mjs'}).join(), /越界/);
  assert.match(validatePluginManifest({...good, entry: '/abs.mjs'}).join(), /越界/);
  assert.match(validatePluginManifest({...good, entry: 'index.js'}).join(), /\.mjs/);
  assert.match(validatePluginManifest({name: '缺字段'}).join(), /缺少/);
  assert.equal(pluginsEnabled('1'), true);
  assert.equal(pluginsEnabled('true'), true);
  assert.equal(pluginsEnabled(undefined), false);
  assert.equal(pluginsEnabled('0'), false);
  assert.match(validatePluginIdFree('model.validate', {builtin: ['model.validate']}).join(), /不能覆盖内置/);
  assert.match(validatePluginIdFree('doc.mep', {planned: ['doc.mep']}).join(), /计划中/);
  const dirs = pluginDirs({projectDir: '/x'});
  assert.equal(dirs[0], path.join('/x', 'plugins'));
  assert.match(dirs[1], /\.config\/house-plan\/plugins$/);
});

test('加载器：默认关闭；开启后加载、校验、拒绝冲突与坏清单', async () => {
  const {projectFile, projectDir} = pluginProject();
  try {
    const off = await initPlugins({projectDir, enabled: false});
    assert.equal(off.enabled, false);
    assert.equal(off.capabilities.length, 0);
    assert.equal(listCapabilities().some(c => c.id === 'demo.count'), false);

    const on = await initPlugins({projectDir, enabled: true});
    assert.equal(on.enabled, true);
    assert.equal(on.loaded.length, 1);
    assert.equal(on.loaded[0].id, 'demo');
    assert.deepEqual(on.capabilities.map(c => c.id), ['demo.count']);
    assert.deepEqual(on.problems, []);
    assert.ok(listCapabilities().some(c => c.id === 'demo.count'));
    assert.ok(getCapability('demo.count').plugin, '能力要带插件来源');
    assert.deepEqual(checkCapabilities(), []);
    assert.equal(pluginSummary().plugins[0].capabilities[0], 'demo.count');

    // 覆盖内置能力：拒载并给出原因
    const conflict = pluginProject({dirId: 'badid', capId: 'model.validate'});
    const clash = await initPlugins({projectDir: conflict.projectDir, enabled: true});
    assert.equal(clash.loaded.length, 0);
    assert.match(clash.problems.join(), /不能覆盖内置能力/);

    // 清单坏了：拒载，不影响其他插件
    const broken = pluginProject({dirId: 'broken', manifest: {entry: '../evil.mjs'}});
    const withBroken = await initPlugins({projectDir: broken.projectDir, enabled: true});
    assert.equal(withBroken.loaded.length, 0);
    assert.match(withBroken.problems.join(), /越界/);
  } finally {
    await initPlugins({enabled: false});
    assert.equal(listCapabilities().some(c => c.id === 'demo.count'), false, '关闭后要彻底移除');
  }
});

test('插件能力与内置能力走同一条执行路径', async () => {
  const {projectFile, projectDir} = pluginProject();
  try {
    await initPlugins({projectDir, enabled: true});
    const r = await runCapability({project: projectFile, capability: 'demo.count'});
    assert.equal(r.summary, 'ok');
    assert.equal(r.capability, 'demo.count');
    assert.ok(Number.isInteger(r.data.files));
  } finally {
    await initPlugins({enabled: false});
  }
});

test('CLI：plugin list 与 cap 门面都看得到插件', () => {
  const {projectFile, projectDir} = pluginProject();
  const disabled = space('plugin', 'list', '--project', projectFile);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /已关闭/);

  const env = {...process.env, SPACE_PLUGINS: '1'};
  const listed = spaceEnv(env, 'plugin', 'list', '--project', projectFile);
  assert.match(listed.stdout, /已开启/);
  assert.match(listed.stdout, /demo@1\.0\.0/);
  assert.match(listed.stdout, /demo\.count/);

  const caps = spaceEnv(env, 'cap', 'list', '--project', projectFile);
  assert.match(caps.stdout, /demo\.count/);

  const run = spaceEnv(env, 'cap', 'run', 'demo.count', '--project', projectFile);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /ok/);

  const check = spaceEnv(env, 'capabilities', '--check');
  assert.equal(check.status, 0, check.stderr);

  // 关闭时看不到插件能力
  const off = space('cap', 'list', '--project', projectFile);
  assert.doesNotMatch(off.stdout, /demo\.count/);
});

test('工作台：插件能力出现在能力清单里', async () => {
  const {projectFile, projectDir} = pluginProject();
  const before = process.env.SPACE_PLUGINS;
  process.env.SPACE_PLUGINS = '1';
  const server = await startStudio({project: projectFile, port: 0});
  try {
    const caps = await (await fetch(new URL('/api/capabilities', server.url))).json();
    assert.ok(caps.capabilities.some(c => c.id === 'demo.count'), '工作台要看到插件能力');
    assert.equal(caps.plugins.enabled, true);
    assert.deepEqual(caps.plugins.plugins.map(p => p.id), ['demo']);

    const run = await fetch(new URL('/api/run', server.url), {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({project: projectFile, capability: 'demo.count', params: {}})
    });
    const body = await run.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.capability, 'demo.count');
  } finally {
    await server.close();
    await initPlugins({enabled: false});
    if (before === undefined) delete process.env.SPACE_PLUGINS; else process.env.SPACE_PLUGINS = before;
  }
});

function spaceEnv(env, ...args) {
  return spawnSync(process.execPath, [BIN, ...args], {encoding: 'utf8', env});
}
