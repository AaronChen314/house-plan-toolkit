import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const BIN = fileURLToPath(new URL('../bin/space.mjs', import.meta.url));
const EXAMPLES = fileURLToPath(new URL('../examples/two-level/', import.meta.url));

const space = (...args) => spawnSync(process.execPath, [BIN, ...args], {encoding: 'utf8'});

test('space version 输出可解析的版本矩阵', () => {
  const r = space('version');
  assert.equal(r.status, 0);
  const v = JSON.parse(r.stdout);
  assert.match(v.toolkit, /^\d+\.\d+\.\d+$/);
  assert.equal(v.layoutVersion, 1);
  assert.equal(v.skills.count, 5);
});

test('space init 生成合规骨架，lock 写入版本', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-cli-'));
  const dir = path.join(base, 'demo-house');
  const init = space('init', '--id', 'demo-house', '--dir', dir);
  assert.equal(init.status, 0, init.stderr);
  const lint = space('lint', '--project', path.join(dir, 'project.json'));
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  assert.match(lint.stdout, /0 error \/ 0 warning/);
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'space.lock.json'), 'utf8'));
  assert.match(lock.toolkit, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.layoutVersion, 1);
});

test('space init 的 id 与目录不一致时被 lint 拦住', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-cli-'));
  const dir = path.join(base, 'other-name');
  assert.equal(space('init', '--id', 'demo-house', '--dir', dir).status, 0);
  const lint = space('lint', '--project', path.join(dir, 'project.json'));
  assert.equal(lint.status, 1);
  assert.match(lint.stdout, /E002/);
});

test('space lock 更新数据指纹', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-cli-'));
  const dir = path.join(base, 'demo-house');
  space('init', '--id', 'demo-house', '--dir', dir);
  const r = space('lock', '--project', path.join(dir, 'project.json'));
  assert.equal(r.status, 0, r.stderr);
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'space.lock.json'), 'utf8'));
  assert.equal(lock.schema, 'space-lock/v1');
});

test('examples/two-level 是合规项目', () => {
  const r = space('lint', '--project', path.join(EXAMPLES, 'project.json'));
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /PASS two-level/);
});

test('space store verify 通过；篡改后失败，rebuild 后恢复', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-store-cli-'));
  const dir = path.join(base, 'demo-house');
  assert.equal(space('init', '--id', 'demo-house', '--dir', dir).status, 0);
  const project = path.join(dir, 'project.json');

  const clean = space('store', 'verify', '--project', project);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /PASS 存储登记/);

  fs.writeFileSync(path.join(dir, 'source/manifest.json'), '{"schema":"space-manifest/v1","drawings":[]}\n');
  const dirty = space('store', 'verify', '--project', project);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stdout, /E_STORE_VERIFY 变更：source\/manifest\.json/);

  const rebuilt = space('store', 'rebuild', '--project', project);
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.equal(space('store', 'verify', '--project', project).status, 0);

  const events = JSON.parse(space('store', 'events', '--project', project, '--json').stdout);
  assert.ok(events.some(e => e.type === 'rebuild'));
  assert.ok(events.every(e => e.schema === 'space-events/v1' && Number.isInteger(e.seq)));
});

test('space store verify --strict 把未登记文件也算失败', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-store-cli-'));
  const dir = path.join(base, 'demo-house');
  space('init', '--id', 'demo-house', '--dir', dir);
  fs.writeFileSync(path.join(dir, 'docs/额外说明.md'), '# 手工放进去的文件\n');
  const project = path.join(dir, 'project.json');
  assert.equal(space('store', 'verify', '--project', project).status, 0, '默认把未登记当提示');
  const strict = space('store', 'verify', '--project', project, '--strict');
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /未登记：docs\/额外说明\.md/);
});

test('space capabilities --check 通过契约 lint', () => {
  const r = space('capabilities', '--check');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /能力契约一致/);
});

test('space index rebuild / stat / query / layers 可从项目内索引产物建库', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-index-cli-'));
  const dir = path.join(base, 'demo-house');
  assert.equal(space('init', '--id', 'demo-house', '--dir', dir).status, 0);
  const project = path.join(dir, 'project.json');

  const entities = [];
  for (let i = 0; i < 40; i++) {
    const x = (i % 10) * 1000, y = Math.floor(i / 10) * 1000;
    entities.push({id: `E${i}`, type: i % 2 ? 'LINE' : 'TEXT', layer: i % 3 ? 'WALL' : 'DIM', points: [[x, y], [x + 800, y + 300]]});
  }
  fs.mkdirSync(path.join(dir, 'output/cad'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'output/cad/source.json'), JSON.stringify({schema: 'cad-source/v1', source: {file: 'plan.dxf'}, entities, issues: []}));
  fs.writeFileSync(path.join(dir, 'source/drawings/plan.dxf'), 'synthetic');

  const rebuild = space('index', 'rebuild', '--project', project);
  assert.equal(rebuild.status, 0, rebuild.stderr);
  assert.match(rebuild.stdout, /已建立索引：40 个图元/);
  assert.match(rebuild.stdout, /来源 output\/cad\/source\.json/);

  const stat = space('index', 'stat', '--project', project);
  assert.equal(stat.status, 0, stat.stderr);
  assert.match(stat.stdout, /40 个图元/);

  const query = space('index', 'query', '--project', project, '--box', '0,0,2500,1000', '--limit', '3', '--json');
  assert.equal(query.status, 0, query.stderr);
  const page = JSON.parse(query.stdout);
  assert.equal(page.rows.length, 3);
  assert.equal(page.hasMore, true);
  assert.ok(page.rows.every(r => r.maxx >= 0 && r.minx <= 2500 && r.maxy >= 0 && r.miny <= 1000));

  const counted = JSON.parse(space('index', 'query', '--project', project, '--box', '0,0,2500,1000', '--count', '--json').stdout);
  assert.ok(counted.total >= 6);

  const layers = space('index', 'layers', '--project', project);
  assert.equal(layers.status, 0, layers.stderr);
  assert.match(layers.stdout, /WALL/);

  assert.equal(space('index', 'query', '--project', project, '--box', '1,2', '--json').status, 1, '坏的 --box 应失败');
  assert.equal(space('index', 'nope', '--project', project).status, 1);
});
