import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {lintProject} from '../checks/layout.mjs';

const TOOLKIT_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function scaffold({id = 'demo-house', dirName = id, project = {}, files = {}, omit = []} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-layout-'));
  const dir = path.join(base, dirName);
  fs.mkdirSync(dir, {recursive: true});
  const p = {schema: 'space-project/v1', id, name: '演示住宅', status: 'awaiting-source', model: null, output: 'output', ...project};
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(p, null, 2));
  const defaults = {'README.md': '# 演示住宅\n', '.gitignore': 'output/\n.space/\n', 'source/manifest.json': JSON.stringify({schema: 'source-manifest/v1', files: []}), 'space.lock.json': JSON.stringify({schema: 'space-lock/v1', toolkit: TOOLKIT_VERSION})};
  for (const [rel, content] of Object.entries({...defaults, ...files})) {
    if (omit.includes(rel)) continue;
    fs.mkdirSync(path.dirname(path.join(dir, rel)), {recursive: true});
    fs.writeFileSync(path.join(dir, rel), content);
  }
  fs.mkdirSync(path.join(dir, 'source'), {recursive: true});
  return dir;
}

const lint = (dir) => lintProject(path.join(dir, 'project.json'));
const codes = (r) => [...r.errors, ...r.warnings].map(e => e.code);
const has = (r, code) => codes(r).includes(code);

test('合规项目骨架零错误零警告', () => {
  const r = lint(scaffold());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.passed, true);
  assert.equal(r.layoutVersion, 1);
});

test('E001：project.json 无法解析或 schema 不符', () => {
  const dir = scaffold();
  fs.writeFileSync(path.join(dir, 'project.json'), '{oops');
  assert.ok(has(lint(dir), 'E001'));
  const dir2 = scaffold({project: {schema: 'space-project/v2'}});
  assert.ok(has(lint(dir2), 'E001'));
});

test('E002：id 与目录名不一致', () => {
  const dir = scaffold({id: 'another-house', dirName: 'demo-house'});
  const r = lint(dir);
  assert.ok(has(r, 'E002'));
  assert.equal(r.id, 'another-house');
});

test('E003：model 缺失、不在 data/ 或文件不存在', () => {
  assert.ok(has(lint(scaffold({project: {model: 'data/missing.json'}})), 'E003'));
  assert.ok(has(lint(scaffold({project: {model: 'model.json'}, files: {'model.json': '{}'}})), 'E003'));
  const ok = lint(scaffold({project: {model: 'data/model.json'}, files: {'data/model.json': '{}'}}));
  assert.ok(!has(ok, 'E003'));
  assert.equal(ok.passed, true);
});

test('E004：output 必须位于项目内 output/ 下', () => {
  assert.ok(has(lint(scaffold({project: {output: '../../output/demo'}})), 'E004'));
  assert.ok(has(lint(scaffold({project: {output: '/tmp/demo'}})), 'E004'));
  assert.ok(!has(lint(scaffold({project: {output: 'output/views'}})), 'E004'));
});

test('E005：项目目录内出现工具实现', () => {
  assert.ok(has(lint(scaffold({files: {'src/renderer.mjs': ''}})), 'E005'));
  assert.ok(has(lint(scaffold({files: {'package.json': '{}'}})), 'E005'));
});

test('E006：source/ 文件必须在 manifest 登记', () => {
  const unlisted = scaffold({files: {'source/drawings/20260101-plan.dwg': 'x'}});
  assert.ok(has(lint(unlisted), 'E006'));
  const listed = scaffold({files: {
    'source/manifest.json': JSON.stringify({schema: 'source-manifest/v1', files: ['source/drawings/20260101-plan.dwg']}),
    'source/drawings/20260101-plan.dwg': 'x'
  }});
  const r = lint(listed);
  assert.ok(!has(r, 'E006'));
  assert.ok(!has(r, 'W001'));
});

test('E007：生成物必须在 output/ 下', () => {
  assert.ok(has(lint(scaffold({files: {'report.html': '<html>'}})), 'E007'));
  assert.ok(has(lint(scaffold({files: {'data/模型.glb': 'x'}})), 'E007'));
  assert.ok(!has(lint(scaffold({files: {'output/report.html': '<html>'}})), 'E007'));
  assert.ok(!has(lint(scaffold({files: {'data/assets/lounge-chair.glb': 'x'}})), 'E007'), '项目专用模型属于 data/assets/');
});

test('E008：一个项目只能有一个 project.json', () => {
  assert.ok(has(lint(scaffold({files: {'docs/project.json': '{}'}})), 'E008'));
});

test('W001：source 内文件名缺少日期前缀', () => {
  const dir = scaffold({files: {
    'source/manifest.json': JSON.stringify({files: ['source/drawings/plan.dwg']}),
    'source/drawings/plan.dwg': 'x'
  }});
  const r = lint(dir);
  assert.ok(has(r, 'W001'));
  assert.equal(r.passed, true, 'W001 只是警告');
});

test('W005：锁定的工具版本超出兼容窗口', () => {
  const dir = scaffold({files: {'space.lock.json': JSON.stringify({schema: 'space-lock/v1', toolkit: '9.0.0'})}});
  assert.ok(has(lint(dir), 'W005'));
});

test('strict 语义：只有警告时 passed 仍为 true，由调用方决定退出码', () => {
  const dir = scaffold({files: {'图纸.png': 'x'}});
  const r = lint(dir);
  assert.ok(has(r, 'W008'));
  assert.equal(r.passed, true);
  assert.equal(r.summary.warnings > 0, true);
});
