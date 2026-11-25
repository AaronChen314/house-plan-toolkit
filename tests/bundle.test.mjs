import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from '../src/store/index.mjs';
import {createContext} from '../src/capabilities/context.mjs';
import {capabilities as bundleCapabilities} from '../src/capabilities/bundle.mjs';
import {validateRegistry} from '../src/contracts/capability.mjs';
import {
  MAX_SNAPSHOT_BYTES, assertSourceNotGenerated, bundleDir, bundleManifest, bundleManifestFile,
  isGenerated, snapshotFile, validateBundle, validateSnapshot
} from '../src/contracts/rendering.mjs';
import {bundleIndexHtml, collectBundleSources, scopeDocManifest, snapshotHtml} from '../src/domain/bundle.mjs';

// 能力还没接进 src/capabilities/index.mjs 的能力注册表（主控接线由别人做），
// 这里直接拿本模块的能力定义执行：与 runCapability 一样新建 ctx 并加操作作用域。
const byId = new Map(bundleCapabilities.map(c => [c.id, c]));

async function run(file, id, params = {}) {
  const cap = byId.get(id);
  assert.ok(cap, `能力 ${id} 未在 src/capabilities/bundle.mjs 注册`);
  const ctx = createContext(file);
  return cap.run({...ctx, store: ctx.store.scope(cap.id)}, params);
}

async function rejectsWith(promise, code, pattern) {
  return assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `错误码应为 ${code}，实际 ${e.code}：${e.message}`);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}

const SOURCE = {
  schema: 'cad-source/v1',
  source: {file: 'plan.dxf'},
  entities: [
    {id: 'E1', handle: 'H1', type: 'LINE', layer: 'WALL', points: [[0, 0], [6000, 0]]},
    {id: 'E2', handle: 'H2', type: 'LINE', layer: 'WALL', points: [[0, 0], [0, 4000]]}
  ],
  issues: []
};

const MODEL = {
  schema: 'space-model/v1',
  units: 'mm',
  projectId: 'bundle-demo',
  defaults: {slab: 150},
  floors: [{
    id: 'ground',
    name: '首层',
    elevation: 0,
    clearHeight: 3000,
    wallHeight: 2800,
    slabThickness: 150,
    slab: [], columns: [], doors: [], windowOpenings: [], furniture: [], trace: [],
    walls: [
      {handle: 'W1', polygon: {outer: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]]}, thicknessMm: 200},
      {handle: 'W2', polygon: {outer: [[3000, 0], [3000, 2500]]}, thicknessMm: 100, demolition: true},
      {handle: 'W3', polygon: {outer: [[0, 2500], [2000, 2500]]}, thicknessMm: 100, built: false}
    ]
  }]
};

// 包内路径 → 项目内源路径。测试用它核对「包里的哈希与源一致」。
const SOURCES = {
  'design/design.json': 'data/designs/a/design.json',
  'design/versions/001.json': 'data/designs/a/versions/001.json',
  'dataset/dataset.json': 'data/datasets/d1/dataset.json',
  'dataset/model.json': 'data/datasets/d1/model.json',
  'doc/wall-demolition/a-001.svg': 'output/doc/wall-demolition/a-001.svg',
  'render/colorplan/a-001.svg': 'output/render/colorplan/a-001.svg'
};

const MODEL_FILE = 'data/datasets/d1/model.json';
const RENDER_FILE = 'output/render/colorplan/a-001.svg';

async function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-bundle-'));
  const file = path.join(dir, 'project.json');
  fs.writeFileSync(file, JSON.stringify({schema: 'space-project/v1', id: 'bundle-demo', output: 'output'}, null, 2));
  fs.mkdirSync(path.join(dir, 'output/cad'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'output/cad/source-a.json'), JSON.stringify(SOURCE));
  // 数据集 / 设计 / 施工图用索引里的注册表：本模块只管交付包与快照。
  const {runCapability} = await import('../src/capabilities/index.mjs');
  const cap = (id, params) => runCapability({project: file, capability: id, params});
  await cap('dataset.build', {source: 'output/cad/source-a.json', id: 'd1', confirm: true});
  await cap('design.create', {scheme: 'a', dataset: 'd1'});
  await cap('design.confirm', {scheme: 'a', seq: 1});
  fs.writeFileSync(path.join(dir, MODEL_FILE), JSON.stringify(MODEL, null, 2));
  openStore(file).rebuild({op: 'test.model'});
  await cap('doc.wall-demolition', {scheme: 'a', seq: 1});
  fs.mkdirSync(path.join(dir, 'output/render/colorplan'), {recursive: true});
  fs.writeFileSync(path.join(dir, RENDER_FILE), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
  // 别的方案的渲染图：不应进 a#001 的包
  fs.writeFileSync(path.join(dir, 'output/render/colorplan/b-001.svg'), '<svg></svg>');
  openStore(file).rebuild({op: 'test.render'});
  return {dir, file};
}

test('能力契约：两个交付能力字段齐全，错误码都在表内', () => {
  assert.deepEqual(validateRegistry(bundleCapabilities), []);
  assert.deepEqual(bundleCapabilities.map(c => c.id).sort(), ['bundle.export', 'deliver.snapshot']);
  for (const cap of bundleCapabilities) {
    assert.equal(cap.stage, 'delivery');
    assert.deepEqual(cap.sideEffects, ['write:artifact']);
    assert.equal(cap.idempotent, true);
    assert.deepEqual(cap.requires, []);
    for (const key of ['scheme', 'seq', 'name', 'force']) {
      assert.ok(cap.params.some(p => p.key === key), `${cap.id} 缺少参数 ${key}`);
    }
  }
});

test('打包条目：按角色归位、按方案过滤、去重排序', () => {
  const docManifest = {
    schema: 'space-doc-manifest/v1',
    docs: {
      'wall-demolition:a:1': {kind: 'wall-demolition', file: 'output/doc/wall-demolition/a-001.svg', inputs: {design: {scheme: 'a', seq: 1}}},
      'wall-demolition:b:1': {kind: 'wall-demolition', file: 'output/doc/wall-demolition/b-001.svg', inputs: {design: {scheme: 'b', seq: 1}}}
    }
  };
  const sources = collectBundleSources({
    design: {scheme: 'a', seq: 1, designFile: 'data/designs/a/design.json', versionFile: 'data/designs/a/versions/001.json'},
    dataset: {id: 'd1', file: 'data/datasets/d1/dataset.json'},
    model: 'data/datasets/d1/model.json',
    docManifest,
    renderFiles: ['output/render/colorplan/a-001.svg', 'output/render/colorplan/b-001.svg', 'output/render/colorplan/a-001.svg']
  });
  assert.deepEqual(sources.map(s => `${s.role}:${s.target}`), [
    'dataset:dataset/dataset.json',
    'model:dataset/model.json',
    'design:design/design.json',
    'design:design/versions/001.json',
    'document:doc/wall-demolition/a-001.svg',
    'render:render/colorplan/a-001.svg'
  ]);
  assert.deepEqual(sources.map(s => s.path), [
    'data/datasets/d1/dataset.json',
    'data/datasets/d1/model.json',
    'data/designs/a/design.json',
    'data/designs/a/versions/001.json',
    'output/doc/wall-demolition/a-001.svg',
    'output/render/colorplan/a-001.svg'
  ]);

  const scoped = scopeDocManifest(docManifest, {scheme: 'a', seq: 1});
  assert.deepEqual(Object.keys(scoped.docs), ['wall-demolition:a:1']);

  // index.html 确定性：同输入字节相同，条目按路径排序，内容做 HTML 转义
  const indexManifest = {
    name: '<示例>包',
    design: {scheme: 'a', seq: 1},
    entries: [
      {path: 'render/colorplan/a-001.svg', role: 'render', sha256: '2'.repeat(64), bytes: 20},
      {path: 'dataset/dataset.json', role: 'dataset', sha256: '1'.repeat(64), bytes: 10}
    ]
  };
  const one = bundleIndexHtml(indexManifest);
  const two = bundleIndexHtml({...indexManifest, entries: [...indexManifest.entries].reverse()});
  assert.equal(one, two, 'index.html 不依赖条目传入顺序');
  assert.ok(one.indexOf('dataset/dataset.json') < one.indexOf('render/colorplan/a-001.svg'));
  assert.ok(one.includes('&lt;示例&gt;包'));
  assert.ok(!one.includes('<示例>'));
  assert.ok(one.includes('1'.repeat(64)));
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(one), 'index.html 不写生成时间');
  assert.deepEqual(validateBundle(bundleManifest(indexManifest)), []);
});

test('快照 HTML：内嵌数据安全转义、无生成时间、确定性', () => {
  const hashes = [{path: 'design/versions/001.json', sha256: 'a'.repeat(64), bytes: 10}];
  const payload = {
    name: 'snap',
    design: {scheme: 'a', seq: 1, value: {scheme: 'a', seq: 1}},
    dataset: {value: {id: 'd1'}},
    model: {value: {schema: 'space-model/v1'}},
    docManifest: {value: {docs: {}}},
    renders: [],
    hashes
  };
  const html = snapshotHtml(payload);
  assert.equal(html, snapshotHtml(payload), '同输入字节相同');
  assert.match(html, /只读/);
  assert.match(html, /不能回写/);
  assert.match(html, /哈希清单/);
  assert.ok(html.includes('a'.repeat(64)));
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(html), '快照不写日期');
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(html), '快照不写时间戳');

  // 数据里的 </script> 必须被转义，否则会提前闭合标签
  const hostile = snapshotHtml({
    ...payload,
    design: {scheme: 'a', seq: 1, value: {note: '</script><script>alert(1)</script>'}}
  });
  assert.ok(hostile.includes('\\u003c/script'), '内嵌 JSON 里的 < 必须转义');
  assert.ok(!hostile.includes('</script><script>alert(1)'));
  assert.equal(hostile.match(/<\/script>/g).length, 2, '只应有两个 script 闭合标签');
  const embedded = JSON.parse(hostile.split('<script type="application/json" id="space-snapshot">')[1].split('</script>')[0]);
  assert.equal(embedded.design.value.note, '</script><script>alert(1)</script>', '转义后 JSON 仍可还原');

  // 体积上限：超过就直接拒绝，不交一个打不开的文件
  assert.throws(() => snapshotHtml({model: {value: {blob: 'x'.repeat(MAX_SNAPSHOT_BYTES)}}}), /体积上限/);
});

test('导出交付包：条目都在包里、哈希与源一致、清单通过校验', async () => {
  const {file} = await tempProject();
  const r = await run(file, 'bundle.export', {scheme: 'a', seq: 1});
  assert.equal(r.data.name, 'a-001');
  assert.equal(r.data.dir, bundleDir('a-001'));
  assert.equal(r.data.files, Object.keys(SOURCES).length);

  const store = openStore(file);
  const manifest = store.readJson(bundleManifestFile('a-001'));
  assert.deepEqual(validateBundle(manifest), []);
  assert.equal(manifest.readOnly, true);
  assert.deepEqual(manifest.design, {scheme: 'a', seq: 1});
  assert.deepEqual(manifest.entries.map(e => e.path).sort(), Object.keys(SOURCES).sort());

  for (const entry of manifest.entries) {
    const source = SOURCES[entry.path];
    const copy = `${bundleDir('a-001')}/${entry.path}`;
    assert.equal(store.exists(copy), true, `${copy} 不在包里`);
    assert.equal(store.hashOf(copy), store.hashOf(source), `${entry.path} 与源哈希不一致`);
    assert.equal(entry.sha256, store.hashOf(source));
    assert.equal(entry.bytes, store.readBuffer(source).length);
  }
  assert.equal(r.data.bytes, manifest.entries.reduce((n, e) => n + e.bytes, 0));

  // 别的方案与清单外的文件不进包
  assert.equal(store.exists('output/bundle/a-001/render/colorplan/b-001.svg'), false);

  const index = store.readText('output/bundle/a-001/index.html');
  for (const entry of manifest.entries) {
    assert.ok(index.includes(entry.path), `index.html 缺少 ${entry.path}`);
    assert.ok(index.includes(entry.sha256), `index.html 缺少 ${entry.path} 的哈希`);
  }
});

test('交付包只读：声明 readOnly，写入落在 output/ 且记为 artifact', async () => {
  const {file} = await tempProject();
  const r = await run(file, 'bundle.export', {scheme: 'a', seq: 1, name: 'p1'});
  assert.equal(r.data.readOnly, true);
  const store = openStore(file);
  const manifest = store.readJson(bundleManifestFile('p1'));
  assert.equal(manifest.readOnly, true);
  assert.deepEqual(validateBundle(manifest), []);

  const files = store.files().files;
  for (const entry of manifest.entries) {
    const rel = `${bundleDir('p1')}/${entry.path}`;
    assert.equal(files[rel].mode, 'artifact', `${rel} 应是派生物`);
    assert.equal(files[rel].kind, entry.role, `${rel} 的登记 kind 应为角色 ${entry.role}`);
    assert.equal(isGenerated(rel), true);
    assert.throws(() => assertSourceNotGenerated(rel), /不能作为输入/, '包内文件不能当输入');
  }
  assert.equal(files[`${bundleDir('p1')}/index.html`].mode, 'artifact');
});

test('同名包内容不同：没有 force 被拒，force 之后覆盖', async () => {
  const {dir, file} = await tempProject();
  const first = await run(file, 'bundle.export', {scheme: 'a', seq: 1});
  const again = await run(file, 'bundle.export', {scheme: 'a', seq: 1});
  assert.equal(again.data.unchanged, true, '同内容重复导出不重写');
  assert.equal(again.data.manifestSha256, first.data.manifestSha256);

  const model = JSON.parse(fs.readFileSync(path.join(dir, MODEL_FILE), 'utf8'));
  model.floors[0].walls.push({handle: 'W4', polygon: {outer: [[0, 4000], [6000, 4000]]}, thicknessMm: 200});
  fs.writeFileSync(path.join(dir, MODEL_FILE), JSON.stringify(model, null, 2));
  openStore(file).rebuild({op: 'test.model'});

  await rejectsWith(run(file, 'bundle.export', {scheme: 'a', seq: 1}), 'E_DATA_RULE', /force/);

  const forced = await run(file, 'bundle.export', {scheme: 'a', seq: 1, force: true});
  assert.equal(forced.data.forced, true);
  const store = openStore(file);
  assert.notEqual(store.hashOf(bundleManifestFile('a-001')), first.data.manifestSha256);
  const entry = store.readJson(bundleManifestFile('a-001')).entries.find(e => e.path === 'dataset/model.json');
  assert.equal(entry.sha256, store.hashOf(MODEL_FILE));
});

test('只读快照：单个 HTML、含哈希清单与只读说明、记录通过校验', async () => {
  const {dir, file} = await tempProject();
  const r = await run(file, 'deliver.snapshot', {scheme: 'a', seq: 1});
  assert.equal(r.data.file, snapshotFile('a-001'));
  assert.equal(r.data.record, 'output/snapshot/a-001.json');
  assert.equal(r.data.writable, false);
  assert.equal(r.data.offline, true);

  const store = openStore(file);
  const html = store.readText(r.data.file);
  assert.match(html, /只读/);
  assert.match(html, /离线/);
  assert.match(html, /不能回写/);
  assert.match(html, /哈希清单/);
  assert.ok(!/<link\s/i.test(html), '快照不加载外部样式');
  assert.ok(!/<script\s+src=/i.test(html), '快照不加载外部脚本');

  const record = store.readJson(r.data.record);
  assert.deepEqual(validateSnapshot(record), []);
  assert.equal(record.writable, false);
  assert.equal(record.offline, true);
  assert.equal(record.bytes, r.data.bytes);
  assert.equal(record.bytes, Buffer.byteLength(html, 'utf8'));
  assert.equal(record.bytes, fs.statSync(path.join(dir, r.data.file)).size);
  // 哈希清单记的是项目内的源文件路径：拿它回项目里核对同一份数据。
  assert.deepEqual(record.hashes.map(h => h.path).sort(), Object.values(SOURCES).sort());
  for (const h of record.hashes) {
    assert.equal(h.sha256, store.hashOf(h.path));
    assert.ok(html.includes(h.sha256), `页面上应有 ${h.path} 的哈希`);
  }

  // 内嵌数据能离线解析：设计、数据集、模型、清单、渲染都在里面，且声明自己只读
  const embedded = JSON.parse(html.split('<script type="application/json" id="space-snapshot">')[1].split('</script>')[0]);
  assert.equal(embedded.writable, false);
  assert.equal(embedded.offline, true);
  assert.equal(embedded.design.value.scheme, 'a');
  assert.equal(embedded.dataset.value.id, 'd1');
  assert.equal(embedded.model.value.schema, 'space-model/v1');
  assert.deepEqual(Object.keys(embedded.docManifest.value.docs), ['wall-demolition:a:1']);
  assert.equal(embedded.renders.length, 1);
  assert.match(embedded.renders[0].text, /<svg/);

  // 同输入再跑一次：字节相同，报告「未变化」
  const before = store.hashOf(r.data.file);
  const again = await run(file, 'deliver.snapshot', {scheme: 'a', seq: 1});
  assert.equal(again.data.unchanged, true);
  assert.equal(openStore(file).hashOf(r.data.file), before);

  // 内嵌数据里的 </script> 不会提前闭合标签（端到端：落在渲染图里）
  fs.writeFileSync(path.join(dir, RENDER_FILE), '<svg></script><script>alert(1)</script></svg>');
  openStore(file).rebuild({op: 'test.render'});
  const hostile = await run(file, 'deliver.snapshot', {scheme: 'a', seq: 1, name: 'x1'});
  const hostileHtml = openStore(file).readText(hostile.data.file);
  assert.equal(hostileHtml.match(/<\/script>/g).length, 2, '外来的 </script> 必须被转义');
  assert.ok(!hostileHtml.includes('</script><script>alert(1)'));
  const hostilePayload = JSON.parse(hostileHtml.split('<script type="application/json" id="space-snapshot">')[1].split('</script>')[0]);
  assert.match(hostilePayload.renders[0].text, /<\/script><script>alert\(1\)<\/script>/);
  assert.deepEqual(validateSnapshot(openStore(file).readJson(hostile.data.record)), []);
});

test('快照内容不同：没有 force 被拒，force 之后覆盖', async () => {
  const {dir, file} = await tempProject();
  const first = await run(file, 'deliver.snapshot', {scheme: 'a', seq: 1});
  const model = JSON.parse(fs.readFileSync(path.join(dir, MODEL_FILE), 'utf8'));
  model.floors[0].walls.push({handle: 'W4', polygon: {outer: [[0, 4000], [6000, 4000]]}, thicknessMm: 200});
  fs.writeFileSync(path.join(dir, MODEL_FILE), JSON.stringify(model, null, 2));
  openStore(file).rebuild({op: 'test.model'});

  await rejectsWith(run(file, 'deliver.snapshot', {scheme: 'a', seq: 1}), 'E_DATA_RULE', /force/);
  const forced = await run(file, 'deliver.snapshot', {scheme: 'a', seq: 1, force: true});
  assert.notEqual(forced.data.bytes, first.data.bytes);
  const store = openStore(file);
  const record = store.readJson(forced.data.record);
  assert.equal(record.hashes.find(h => h.path === MODEL_FILE).sha256, store.hashOf(MODEL_FILE));
});

test('快照超过体积上限：拒绝生成，不写半成品', async () => {
  const {dir, file} = await tempProject();
  const big = JSON.parse(fs.readFileSync(path.join(dir, MODEL_FILE), 'utf8'));
  big.filler = 'x'.repeat(MAX_SNAPSHOT_BYTES);
  fs.writeFileSync(path.join(dir, MODEL_FILE), JSON.stringify(big));
  openStore(file).rebuild({op: 'test.big-model'});

  await rejectsWith(run(file, 'deliver.snapshot', {scheme: 'a', seq: 1}), 'E_DATA_RULE', /体积上限/);
  const store = openStore(file);
  assert.equal(store.exists(snapshotFile('a-001')), false);
  assert.equal(store.exists('output/snapshot/a-001.json'), false);
});
