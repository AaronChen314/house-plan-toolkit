import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from '../src/store/index.mjs';
import {closeIndex, openIndex, sqliteAvailable} from '../src/indexer/db.mjs';
import {applySchema} from '../src/indexer/schema.mjs';
import {syncGraph, readGraph, projectFromFiles, markStaleProjection} from '../src/store/graph.mjs';
import {datasetFile, designVersionFile} from '../src/contracts/graph.mjs';
import {designVersion, emptyDataset, emptyDesign} from '../src/contracts/datasets.mjs';

const available = await sqliteAvailable();
const skip = available ? false : '需要 Node 22.5+ 的 node:sqlite';

const projectData = (id) => ({schema: 'space-project/v1', id, model: null, output: 'output'});

// 临时项目：project.json 由测试脚手架落盘，其余写入仍经存储层（派生库走 store.derived）。
function tempProject(id = 'graph-demo') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-graph-'));
  const file = path.join(dir, 'project.json');
  fs.writeFileSync(file, JSON.stringify(projectData(id), null, 2));
  return {dir, file, store: openStore(file)};
}

// 伪造权威数据文件：只读扫描要看到它们，所以直接落盘（测试允许）。
function put(dir, rel, data) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), {recursive: true});
  fs.writeFileSync(abs, JSON.stringify(data, null, 2));
}

const statuses = (graph) => Object.fromEntries(graph.nodes.map(n => [n.id, n.status]));
const edgeKeys = (graph) => graph.edges.map(e => `${e.src}->${e.dst}[${e.role}]`).sort();
const derivedEvents = (store) => store.events().filter(e => e.type === 'derived');

const confirmedDataset = (id, status = 'confirmed') => ({...emptyDataset({id, sources: [{file: 'source/plan.dxf'}]}), status});
const designManifest = (scheme, dataset, status = 'confirmed', seq = 1) => ({
  ...emptyDesign({scheme, dataset}),
  versions: [{seq, status, dataset}]
});

test('投影写入后可读回：节点、派生边、复制、版本各自落到该去的表', {skip}, async () => {
  const {store} = tempProject();
  const nodes = [
    {id: 'd1', kind: 'dataset', status: 'confirmed'},
    {id: 'scheme-a', kind: 'design', status: 'confirmed'},
    {id: 'scheme-b', kind: 'design', status: 'stale'}
  ];
  const edges = [{src: 'd1', dst: 'scheme-a', role: 'derived'}];
  const forks = [{node: 'scheme-b', copiedFrom: 'scheme-a'}];

  const result = await syncGraph(store, {nodes, edges, forks});
  assert.deepEqual({nodes: result.nodes, edges: result.edges, forks: result.forks}, {nodes: 3, edges: 2, forks: 1});

  const graph = await readGraph(store);
  assert.deepEqual(statuses(graph), {d1: 'confirmed', 'scheme-a': 'confirmed', 'scheme-b': 'stale'});
  assert.deepEqual(edgeKeys(graph), ['d1->scheme-a[derived]', 'scheme-a->scheme-b[fork]'], '复制同时留一条 fork 边');
  assert.deepEqual(graph.forks.map(f => [f.node, f.copiedFrom]), [['scheme-b', 'scheme-a']]);
  assert.equal(typeof graph.forks[0].at, 'string');
  assert.deepEqual(graph.versions, []);

  const events = derivedEvents(store);
  assert.equal(events.length, 1, '一次同步只留一条汇总事件');
  assert.equal(events[0].op, 'graph.sync');
  assert.equal(events[0].name, 'index');
  assert.deepEqual(events[0].summary, {nodes: 3, edges: 2, forks: 1});
  assert.equal(store.events().filter(e => e.type === 'write').length, 0, '派生库不产生逐行写事件');
  assert.deepEqual(store.files().files, {}, '派生库不进文件登记');
});

test('同一份输入重复 sync 幂等：节点不翻倍，事件每次一条', {skip}, async () => {
  const {store} = tempProject();
  const input = {
    nodes: [{id: 'd1', kind: 'dataset', status: 'confirmed'}, {id: 'scheme-a', kind: 'design', status: 'draft'}],
    edges: [{src: 'd1', dst: 'scheme-a', role: 'derived'}],
    forks: []
  };
  await syncGraph(store, input);
  const first = await readGraph(store);
  await syncGraph(store, input);
  const second = await readGraph(store);

  assert.equal(first.nodes.length, 2);
  assert.equal(second.nodes.length, 2, '重复同步不应叠加节点');
  assert.deepEqual(edgeKeys(second), edgeKeys(first));
  const events = derivedEvents(store);
  assert.equal(events.length, 2);
  assert.ok(events.every(e => e.op === 'graph.sync' && e.summary.nodes === 2));
  assert.equal(store.events().filter(e => e.type === 'write').length, 0);
});

test('设计派生设计被拒，且失败时不留下半份投影', {skip}, async () => {
  const {store} = tempProject();
  await assert.rejects(
    () => syncGraph(store, {
      nodes: [{id: 'scheme-a', kind: 'design'}, {id: 'scheme-b', kind: 'design'}],
      edges: [{src: 'scheme-a', dst: 'scheme-b', role: 'derived'}]
    }),
    (e) => {
      assert.equal(e.code, 'E_DATA_RULE');
      assert.ok(e.detail.problems.some(p => /不允许派生/.test(p)), e.detail.problems.join('；'));
      return true;
    }
  );
  const graph = await readGraph(store);
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);

  // 版本不是边：写成 edge 同样被拒。
  await assert.rejects(
    () => syncGraph(store, {
      nodes: [{id: 'scheme-a', kind: 'design'}],
      edges: [{src: 'scheme-a', dst: 'scheme-a', role: 'version'}]
    }),
    (e) => e.code === 'E_DATA_RULE'
  );

  // 同一份投影里节点 id 重复也不行（否则计数与内容会对不上）。
  await assert.rejects(
    () => syncGraph(store, {
      nodes: [{id: 'd1', kind: 'dataset'}, {id: 'd1', kind: 'dataset'}],
      edges: [],
      forks: []
    }),
    (e) => e.code === 'E_DATA_RULE' && e.detail.problems.some(p => /节点重复登记/.test(p))
  );
});

test('复制只允许设计之间：数据集不能复制', {skip}, async () => {
  const {store} = tempProject();
  const datasetFork = {
    nodes: [{id: 'd1', kind: 'dataset'}, {id: 'd2', kind: 'dataset'}],
    edges: [],
    forks: [{node: 'd2', copiedFrom: 'd1'}]
  };
  await assert.rejects(() => syncGraph(store, datasetFork), (e) => {
    assert.equal(e.code, 'E_DATA_RULE');
    assert.ok(e.detail.problems.some(p => /只允许设计之间复制/.test(p)), e.detail.problems.join('；'));
    return true;
  });

  // 设计之间可以复制；同一个方案登记两次复制则被拒。
  const designFork = {
    nodes: [{id: 'scheme-a', kind: 'design'}, {id: 'scheme-b', kind: 'design'}],
    edges: [],
    forks: [{node: 'scheme-b', copiedFrom: 'scheme-a'}]
  };
  await syncGraph(store, designFork);
  const graph = await readGraph(store);
  assert.deepEqual(edgeKeys(graph), ['scheme-a->scheme-b[fork]']);
  assert.deepEqual(graph.forks.map(f => f.node), ['scheme-b']);

  await assert.rejects(
    () => syncGraph(store, {...designFork, forks: [...designFork.forks, {node: 'scheme-b', copiedFrom: 'scheme-a'}]}),
    (e) => e.code === 'E_DATA_RULE' && e.detail.problems.some(p => /多次复制/.test(p))
  );
});

test('registry 的 files.json 里不出现 .space 内的库，verify 仍然全绿', {skip}, async () => {
  const {dir, store} = tempProject();
  store.writeData('project.json', JSON.stringify(projectData('graph-demo'), null, 2), {
    baseHash: store.hashOf('project.json'),
    confirm: true,
    op: 'test.init'
  });
  await syncGraph(store, {
    nodes: [{id: 'd1', kind: 'dataset', status: 'confirmed'}],
    edges: [],
    forks: []
  });

  assert.equal(fs.existsSync(path.join(dir, '.space', 'project.sqlite')), true);
  const registered = Object.keys(store.files().files);
  assert.deepEqual(registered, ['project.json']);
  assert.ok(registered.every(rel => !rel.startsWith('.space/')), '派生库不得进文件登记');
  assert.ok(registered.every(rel => !rel.includes('project.sqlite')));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.space', 'files.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.files), ['project.json']);
  const verify = store.verify();
  assert.equal(verify.ok, true, JSON.stringify({missing: verify.missing, modified: verify.modified, untracked: verify.untracked, leftovers: verify.leftovers}));
});

test('projectFromFiles 从 data/ 文件生成节点、边与状态', {skip}, async () => {
  const {dir, store} = tempProject();

  // 数据集：d1 已确认；d2 由 d1 校正而来，仍是草稿。
  put(dir, datasetFile('d1'), confirmedDataset('d1', 'confirmed'));
  const corrected = confirmedDataset('d2', 'draft');
  corrected.corrections = [{from: 'd1', note: '墙位按现场复核'}];
  put(dir, datasetFile('d2'), corrected);

  // 设计方案：scheme-a 用 d1 且已确认；scheme-b 复制自 scheme-a 的 001，草稿。
  put(dir, 'data/designs/scheme-a/design.json', designManifest('scheme-a', 'd1', 'confirmed'));
  put(dir, designVersionFile('scheme-a', 1), designVersion({scheme: 'scheme-a', seq: 1, dataset: 'd1', status: 'confirmed'}));
  put(dir, 'data/designs/scheme-b/design.json', designManifest('scheme-b', 'd2', 'draft'));
  put(dir, designVersionFile('scheme-b', 1), designVersion({
    scheme: 'scheme-b',
    seq: 1,
    dataset: 'd2',
    status: 'draft',
    forkedFrom: {scheme: 'scheme-a', seq: 1}
  }));

  const result = await projectFromFiles(store);
  assert.deepEqual({nodes: result.nodes, edges: result.edges, forks: result.forks}, {nodes: 4, edges: 4, forks: 1});

  const graph = await readGraph(store);
  assert.deepEqual(statuses(graph), {
    d1: 'confirmed',
    d2: 'draft',
    'scheme-a': 'confirmed',
    'scheme-b': 'draft'
  }, '状态只从文件来');
  assert.deepEqual(edgeKeys(graph), [
    'd1->d2[derived]',
    'd1->scheme-a[derived]',
    'd2->scheme-b[derived]',
    'scheme-a->scheme-b[fork]'
  ]);
  assert.deepEqual(graph.forks.map(f => [f.node, f.copiedFrom]), [['scheme-b', 'scheme-a']]);
  assert.equal(derivedEvents(store).length, 1);

  // 再跑一次：文件没变，投影不翻倍。
  await projectFromFiles(store);
  assert.equal((await readGraph(store)).nodes.length, 4);
});

test('readGraph 从 node_version 读出图版本链，sync 不碰版本表', {skip}, async () => {
  const {store} = tempProject();
  const index = store.derived('index');
  const db = await openIndex(index);
  try {
    applySchema(db);
    // 版本链由设计 lane 写入，这里只验证投影层能读回来。
    db.prepare('INSERT INTO node_version (node, seq, parent_seq, input_hash, op, op_version, payload_path) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('scheme-a', 1, null, 'hash-1', 'design.version', '1.0.0', 'data/designs/scheme-a/versions/001.json');
  } finally {
    closeIndex(db);
  }

  const graph = await readGraph(store);
  // node:sqlite 返回无原型对象，断言前转成普通对象。
  assert.deepEqual(graph.versions.map(v => ({...v})), [{
    node: 'scheme-a',
    seq: 1,
    parentSeq: null,
    inputHash: 'hash-1',
    op: 'design.version',
    opVersion: '1.0.0',
    payloadPath: 'data/designs/scheme-a/versions/001.json'
  }]);

  await syncGraph(store, {nodes: [{id: 'scheme-a', kind: 'design'}], edges: [], forks: []});
  assert.equal((await readGraph(store)).versions.length, 1, '整表重建只清 node/edge/fork');
});

test('非法数据被拒：缺 schema 报 E_DATA_SCHEMA，未知状态报 E_DATA_RULE', {skip}, async () => {
  {
    const {dir, store} = tempProject();
    put(dir, datasetFile('d1'), {...confirmedDataset('d1'), schema: 'space-dataset/v0'});
    await assert.rejects(() => projectFromFiles(store), (e) => {
      assert.equal(e.code, 'E_DATA_SCHEMA');
      assert.ok(e.detail.problems.some(p => /schema/.test(p)), e.detail.problems.join('；'));
      return true;
    });
    assert.deepEqual((await readGraph(store)).nodes, [], '非法数据不写投影');
  }

  {
    const {dir, store} = tempProject();
    put(dir, datasetFile('d1'), {...confirmedDataset('d1'), status: 'wip'});
    await assert.rejects(() => projectFromFiles(store), (e) => {
      assert.equal(e.code, 'E_DATA_RULE');
      assert.ok(e.detail.problems.some(p => /status 不合法/.test(p)), e.detail.problems.join('；'));
      return true;
    });
    assert.deepEqual((await readGraph(store)).nodes, []);
  }

  {
    const {dir, store} = tempProject();
    put(dir, 'data/designs/scheme-a/design.json', designManifest('scheme-a', 'd1'));
    put(dir, designVersionFile('scheme-a', 1), designVersion({scheme: 'scheme-a', seq: 1, dataset: 'd1', status: 'done'}));
    await assert.rejects(() => projectFromFiles(store), (e) => e.code === 'E_DATA_RULE' && e.detail.problems.some(p => /status 不合法/.test(p)));
  }
});

test('索引不存在时 readGraph 返回空结构，markStaleProjection 不造库', {skip}, async () => {
  const {dir, store} = tempProject();
  assert.deepEqual(await readGraph(store), {nodes: [], edges: [], forks: [], versions: []});

  const result = await markStaleProjection(store, ['d1']);
  assert.equal(result.updated, 0);
  assert.deepEqual(result.skipped, [{id: 'd1', reason: '索引不存在'}]);
  assert.equal(fs.existsSync(path.join(dir, '.space', 'project.sqlite')), false, '投影不创建索引');
  assert.equal(store.events().length, 0);
});

test('markStaleProjection 只改索引里的 node.status，不动文件', {skip}, async () => {
  const {dir, store} = tempProject();
  put(dir, datasetFile('d1'), confirmedDataset('d1', 'confirmed'));
  await projectFromFiles(store);

  const before = JSON.parse(fs.readFileSync(path.join(dir, datasetFile('d1')), 'utf8'));
  assert.equal(before.status, 'confirmed');

  const result = await markStaleProjection(store, ['d1']);
  assert.equal(result.updated, 1);
  assert.deepEqual(result.stale, [{id: 'd1', from: 'confirmed', to: 'stale'}]);

  const graph = await readGraph(store);
  assert.equal(statuses(graph).d1, 'stale', '索引里的投影标为待复核');
  const after = JSON.parse(fs.readFileSync(path.join(dir, datasetFile('d1')), 'utf8'));
  assert.equal(after.status, 'confirmed', '权威文件保持原状：这不是 markStale');
  assert.equal(store.events().at(-1).op, 'graph.markStale');

  // 已待复核不重复标，未登记的不硬塞。
  const again = await markStaleProjection(store, ['d1', 'nope']);
  assert.equal(again.updated, 0);
  assert.deepEqual(again.skipped.map(s => s.reason), ['已是待复核', '索引里未登记']);
});
