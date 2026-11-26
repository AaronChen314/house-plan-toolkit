#!/usr/bin/env node
// 打包时把当前提交写进包里，装好之后 `space version` 能看出是哪一版。
// 生成 src/build-info.json → npm pack → 删掉，不污染工作区。
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || process.cwd();
const git = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'});
const commit = git.status === 0 ? git.stdout.trim() : null;
const dirty = spawnSync('git', ['status', '--porcelain'], {cwd: root, encoding: 'utf8'}).stdout.trim().length > 0;
const info = path.join(root, 'src', 'build-info.json');

if (commit) fs.writeFileSync(info, JSON.stringify({commit, dirty, at: new Date().toISOString()}, null, 2) + '\n');
try {
  const r = spawnSync('npm', ['pack', '--pack-destination', path.resolve(out)], {cwd: root, encoding: 'utf8'});
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(r.status || 1); }
  const file = r.stdout.trim().split('\n').pop();
  console.log(path.join(path.resolve(out), file));
  if (commit) console.log(`commit ${commit.slice(0, 7)}${dirty ? '（工作区有未提交改动）' : ''}`);
} finally {
  fs.rmSync(info, {force: true});
}
