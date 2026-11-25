import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {buildProject} from '../src/cli/build.mjs';
import {openStore} from '../src/store/index.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXAMPLE = path.join(ROOT, 'examples/two-level');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function hashTree(dir, base = dir, out = {}) {
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) hashTree(abs, base, out);
    else out[path.relative(base, abs).split(path.sep).join('/')] = sha(abs);
  }
  return out;
}

function tempExample() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-build-'));
  const dir = path.join(base, 'two-level');
  fs.mkdirSync(path.join(dir, 'data'), {recursive: true});
  fs.copyFileSync(path.join(EXAMPLE, 'data/model.json'), path.join(dir, 'data/model.json'));
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    schema: 'space-project/v1',
    id: 'two-level',
    name: '构建确定性用例',
    model: 'data/model.json',
    output: 'output',
    assets: path.join(ROOT, 'src/furniture/assets/catalog.json')
  }, null, 2));
  return {dir, file: path.join(dir, 'project.json')};
}

test('同一空间数据重复构建，产物哈希一致（M0 确定性验收）', async () => {
  const {dir, file} = tempExample();
  await buildProject(file, {viewer: 'white-model'});
  const first = hashTree(path.join(dir, 'output'));
  await new Promise(r => setTimeout(r, 20));
  const again = await buildProject(file, {viewer: 'white-model'});
  const second = hashTree(path.join(dir, 'output'));
  assert.deepEqual(second, first, '重复构建产生了不同字节');
  assert.ok(first['白模.html'] && first['model.json'] && first['validation.json']);
  assert.equal(again.file, path.join(dir, 'output/白模.html'));
});

test('构建只写项目内 output/，全部经存储登记且可校验', async () => {
  const {dir, file} = tempExample();
  await buildProject(file, {viewer: 'drawing'});
  const store = openStore(file);
  const entries = Object.keys(store.files().files);
  assert.ok(entries.length >= 4, '构建产物没有登记');
  for (const rel of entries) assert.ok(rel.startsWith('output/'), `${rel} 不在 output/`);
  const writes = store.events().filter(e => e.type === 'write');
  assert.ok(writes.length >= entries.length);
  for (const rel of entries) {
    const event = writes.filter(e => e.path === rel).at(-1);
    assert.ok(event, `${rel} 缺少写入事件`);
    assert.equal(event.sha256, store.files().files[rel].sha256);
  }
  assert.equal(store.verify().ok, true, JSON.stringify(store.verify()));
});

test('重建前保留上一版生成物，副本同样登记', async () => {
  const {dir, file} = tempExample();
  await buildProject(file, {viewer: 'drawing'});
  // 改动输入，触发一次真实重建（项目名进入页面数据）
  const project = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({...project, name: '重建对照'}, null, 2));
  await buildProject(file, {viewer: 'drawing'});
  const history = Object.keys(openStore(file).files().files).filter(rel => rel.startsWith('output/history/'));
  assert.ok(history.length >= 1, '未保留上一版生成物');
  assert.ok(history.some(rel => rel.endsWith('平面核对.html')));
  assert.ok(history.some(rel => rel.endsWith('model.json')));
});

test('示例项目的空间数据与白模在重构后仍可构建', async () => {
  const {dir, file} = tempExample();
  const r = await buildProject(file, {viewer: 'white-model'});
  const html = fs.readFileSync(r.file, 'utf8');
  assert.match(html, /whiteModel/);
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'output/model.json'), 'utf8'));
  assert.equal(data.projectId, 'two-level');
  assert.equal(data.floors.length, 2);
  assert.equal(data.view.centerMm.length, 2);
});
