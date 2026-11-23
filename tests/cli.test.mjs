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
