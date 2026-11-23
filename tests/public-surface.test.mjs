import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {verifyPublic, parseDenylist} from '../src/checks/public-surface.mjs';

function git(dir, args) {
  const r = spawnSync('git', args, {cwd: dir, encoding: 'utf8'});
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-public-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'tester']);
  return dir;
}

function write(dir, rel, content) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), {recursive: true});
  fs.writeFileSync(path.join(dir, rel), content);
}

function manifest(dir, extra = {}) {
  const m = {
    schema: 'publish-surface/v1',
    layouts: {test: {allowDirectories: ['src', 'docs'], allowFiles: ['.gitignore', 'LICENSE', 'README.md', 'publish-manifest.json'], denyExtensions: ['.dwg', '.pdf'], ...extra.layout}},
    binaries: {registered: {}},
    ...extra
  };
  write(dir, 'publish-manifest.json', JSON.stringify(m, null, 2));
}

function commit(dir) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'snapshot', '--allow-empty']);
}

const codes = (r) => r.errors.map(e => e.code);
const has = (r, code) => codes(r).includes(code);

test('干净仓库通过：白名单内、无敏感词、无未登记二进制', () => {
  const dir = repo();
  manifest(dir);
  write(dir, 'README.md', '# 工具包\n');
  write(dir, 'LICENSE', 'MIT\n');
  write(dir, 'src/main.mjs', 'export const version = "0.1.0";\n');
  commit(dir);
  const r = verifyPublic({root: dir, layout: 'test'});
  assert.equal(r.passed, true, JSON.stringify(r.errors));
});

test('P001：白名单外的路径被拒绝', () => {
  const dir = repo();
  manifest(dir);
  write(dir, 'README.md', '# 工具包\n');
  write(dir, 'projects/demo-house/data/model.json', '{}\n');
  commit(dir);
  const r = verifyPublic({root: dir, layout: 'test'});
  assert.ok(has(r, 'P001'));
});

test('P003：文本中出现本机绝对路径', () => {
  const dir = repo();
  manifest(dir);
  write(dir, 'README.md', '# 工具包\n');
  const absPath = ['', 'Users', 'somebody', 'plan.dwg'].join('/');
  write(dir, 'src/paths.mjs', `const p = "${absPath}";\n`);
  commit(dir);
  const r = verifyPublic({root: dir, layout: 'test'});
  assert.ok(has(r, 'P003'));
});

test('P004：命中私有词表', () => {
  const dir = repo();
  manifest(dir);
  write(dir, 'README.md', '# 工具包\n');
  write(dir, 'src/note.md', '参见某客户的方案。\n');
  const dl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-deny-')), 'denylist.txt');
  fs.writeFileSync(dl, '# 私有词表\n某客户\nre:客户[0-9]+\n');
  commit(dir);
  const terms = parseDenylist(dl);
  assert.equal(terms.length, 2);
  const r = verifyPublic({root: dir, layout: 'test', terms});
  assert.ok(has(r, 'P004'));
});

test('P004：文件名命中词表（二进制也查）', () => {
  const dir = repo();
  manifest(dir);
  write(dir, 'README.md', '# 工具包\n');
  write(dir, 'docs/某客户-户型.png', Buffer.from([1, 2, 3]));
  commit(dir);
  const terms = [{text: '某客户'}];
  const r = verifyPublic({root: dir, layout: 'test', terms});
  assert.ok(r.errors.some(e => e.code === 'P004' && e.path.includes('某客户')));
});

test('P006：二进制必须登记，哈希不符也拒绝', () => {
  const dir = repo();
  manifest(dir);
  write(dir, 'README.md', '# 工具包\n');
  write(dir, 'src/model.glb', Buffer.from([1, 2, 3, 4]));
  commit(dir);

  const unregistered = verifyPublic({root: dir, layout: 'test'});
  assert.ok(has(unregistered, 'P006'));

  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'src/model.glb'))).digest('hex');
  const withHash = (sha) => {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'publish-manifest.json'), 'utf8'));
    m.binaries.registered['src/model.glb'] = {license: 'CC0', source: 'https://example.com/model', sha256: sha};
    write(dir, 'publish-manifest.json', JSON.stringify(m, null, 2));
  };
  withHash(hash);
  assert.equal(verifyPublic({root: dir, layout: 'test'}).passed, true);

  withHash('0'.repeat(64));
  assert.ok(has(verifyPublic({root: dir, layout: 'test'}), 'P006'));
});

test('P007：资产清单缺许可/来源或 id 不规范', () => {
  const dir = repo();
  manifest(dir, {layout: {assetManifests: ['src/assets/catalog.json']}});
  write(dir, 'README.md', '# 工具包\n');
  write(dir, 'src/assets/model.glb', Buffer.from([1, 2]));
  write(dir, 'src/assets/catalog.json', JSON.stringify({models: {
    'demo-chair': {file: 'model.glb'},
    'Demo 椅子': {file: 'model.glb', license: 'CC0', source: 'x'}
  }}));
  commit(dir);
  const r = verifyPublic({root: dir, layout: 'test'});
  const assetErrors = r.errors.filter(e => e.code === 'P007');
  assert.ok(assetErrors.some(e => e.message.includes('license')));
  assert.ok(assetErrors.some(e => e.message.includes('kebab-case')));
  assert.ok(!r.errors.some(e => e.code === 'P006' && e.path === 'src/assets/model.glb'), '资产清单已引用的二进制不重复要求登记');
});

test('P005：历史提交里出现过项目路径', () => {
  const dir = repo();
  manifest(dir);
  write(dir, 'README.md', '# 工具包\n');
  write(dir, 'projects/secret/data.json', '{}\n');
  commit(dir);
  git(dir, ['rm', '-rq', 'projects']);
  commit(dir);
  const r = verifyPublic({root: dir, layout: 'test'});
  assert.ok(has(r, 'P005'), '删除文件也要在历史里被拦住');
});
