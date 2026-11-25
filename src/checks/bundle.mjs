#!/usr/bin/env node
// 交付包离线验收：断网状态下打开包内 index.html 与单文件快照，
// 断言零外部请求、清单自洽（逐文件哈希与盘上一致）。
// 用法：node src/checks/bundle.mjs <project.json> [包名]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {launch} from './browser.mjs';
import {writeFileAtomic} from '../store/atomic.mjs';

const projectFile = path.resolve(process.argv[2] || '');
const name = process.argv[3] || 'demo';
if (!process.argv[2] || !fs.existsSync(projectFile)) {
  console.error('用法：node src/checks/bundle.mjs <project.json> [包名]');
  process.exit(2);
}

const {runCapability} = await import('../capabilities/index.mjs');
const {openStore} = await import('../store/index.mjs');
const {bundleDir} = await import('../contracts/rendering.mjs');

const out = path.resolve(process.argv[4] || path.join(os.tmpdir(), 'bundle-check'));
fs.mkdirSync(out, {recursive: true});

// 先确保包与快照存在：内容相同则原样，不同则需要显式 force。
async function ensure(capability, params) {
  try {
    return await runCapability({project: projectFile, capability, params});
  } catch (e) {
    if (e.code !== 'E_DATA_RULE') throw e;
    return runCapability({project: projectFile, capability, params: {...params, force: true}});
  }
}

const project = openStore(projectFile);
const designFile = (() => {
  const rel = Object.keys(project.files().files).find(f => /^data\/designs\/[^/]+\/design\.json$/.test(f));
  if (!rel) throw new Error('项目里没有设计方案：先 space design create');
  const scheme = rel.split('/')[2];
  const design = project.readJson(rel);
  return {scheme, seq: Math.max(...design.versions.map(v => v.seq))};
})();

await ensure('doc.wall-demolition', {scheme: designFile.scheme, seq: designFile.seq});
await ensure('render.colorplan', {scheme: designFile.scheme, seq: designFile.seq});
const bundled = await ensure('bundle.export', {scheme: designFile.scheme, seq: designFile.seq, name});
const snapshot = await ensure('deliver.snapshot', {scheme: designFile.scheme, seq: designFile.seq, name});

const dir = path.join(path.dirname(projectFile), bundleDir(name));
const manifestFile = path.join(dir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// 清单自洽：包内每个文件都在，哈希与清单一致。
for (const entry of manifest.entries) {
  const file = path.join(dir, entry.path);
  assert.ok(fs.existsSync(file), `包内缺文件：${entry.path}`);
  assert.equal(sha(file), entry.sha256, `${entry.path} 哈希与清单不一致`);
}
assert.ok(fs.existsSync(path.join(dir, 'index.html')), '交付包缺少离线清单页');

// 本地静态服务：模拟「拷到别的机器上打开」
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(dir, rel);
  if (!file.startsWith(dir + path.sep) && file !== dir) { res.writeHead(403); res.end(); return; }
  try {
    const body = fs.readFileSync(file);
    res.writeHead(200, {'content-type': rel.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream'});
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await launch({viewport: {width: 1200, height: 900}});
try {
  const page = await browser.newPage();
  const requests = [];
  page.on('request', r => requests.push(r.url()));
  const failed = [];
  page.on('requestfailed', r => failed.push(`${r.url()} ${r.failure()?.errorText || ''}`));

  // 1) 包内清单页：只允许本地请求，不许任何外部域名
  await page.goto(base + '/index.html', {waitUntil: 'networkidle0'});
  const title = await page.title();
  const rows = await page.evaluate(() => document.querySelectorAll('tbody tr').length);
  assert.equal(rows, manifest.entries.length, '清单页行数应与条目数一致');
  const external = requests.filter(u => !u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('file:'));
  assert.deepEqual(external, [], `清单页请求了外部资源：${external.join(', ')}`);
  assert.deepEqual(failed, [], `有请求失败：${failed.join(', ')}`);
  await page.screenshot({path: path.join(out, 'bundle-index.png'), fullPage: true});

  // 2) 单文件快照：直接用 file:// 打开（真正的离线），零网络请求
  const snapshotFile = path.join(path.dirname(projectFile), snapshot.data.file ?? `output/snapshot/${name}.html`);
  assert.ok(fs.existsSync(snapshotFile), `快照不存在：${snapshotFile}`);
  const snapshotRequests = [];
  const snapshotPage = await browser.newPage();
  snapshotPage.on('request', r => snapshotRequests.push(r.url()));
  await snapshotPage.goto(pathToFileURL(snapshotFile).href, {waitUntil: 'networkidle0'});
  const snapshotText = await snapshotPage.evaluate(() => document.body.innerText);
  assert.match(snapshotText, /只读/);
  assert.match(snapshotText, /哈希|sha256/i);
  const network = snapshotRequests.filter(u => /^https?:/.test(u));
  assert.deepEqual(network, [], `快照联网了：${network.join(', ')}`);
  await snapshotPage.screenshot({path: path.join(out, 'snapshot.png'), fullPage: true});

  writeFileAtomic(path.join(out, 'report.json'), JSON.stringify({
    passed: true,
    project: projectFile,
    bundle: {name, entries: manifest.entries.length, bytes: manifest.entries.reduce((n, e) => n + e.bytes, 0)},
    bundleIndex: {title, rows, externalRequests: external.length},
    snapshot: {file: path.relative(path.dirname(projectFile), snapshotFile), bytes: fs.statSync(snapshotFile).size, networkRequests: network.length},
    files: {bundleIndex: 'bundle-index.png', snapshot: 'snapshot.png'}
  }, null, 2));
  console.log(`PASS bundle offline · ${manifest.entries.length} 个文件 · 清单页零外部请求 · 快照 file:// 打开零网络`);
} finally {
  await browser.close();
  server.close();
}
