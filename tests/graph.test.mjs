import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NODE_KINDS, RELATIONS, EDGE_ROLES, NODE_STATUSES, STATUS_TRANSITIONS, STATUS_AUTHORITY,
  ALLOWED_DERIVED, ALLOWED_FORK, GRAPH_INVARIANTS,
  canEdge, canTransition, relationStorage, propagates, datasetFile, designVersionFile,
  validateGraph, kindOfIndexPath
} from '../src/contracts/graph.mjs';
import {impactOf, planStale, staleAfterChange, upstreamOf} from '../src/domain/graph.mjs';

const node = (id, kind, status = 'draft') => ({id, kind, status});
const edge = (src, dst, role = 'derived') => ({src, dst, role});

test('图契约：类型、关系、状态三者互不混用', () => {
  assert.deepEqual(NODE_KINDS, ['source', 'dataset', 'design', 'model', 'render', 'document', 'bundle']);
  assert.deepEqual(RELATIONS, ['derived', 'version', 'fork']);
  assert.deepEqual(EDGE_ROLES, ['derived', 'fork'], '版本不是边');
  assert.deepEqual(NODE_STATUSES, ['draft', 'confirmed', 'stale', 'superseded']);
  assert.equal(STATUS_AUTHORITY, 'file', '状态权威在文件，索引只是投影');
  assert.ok(GRAPH_INVARIANTS.includes('stale-does-not-delete'));
  assert.equal(relationStorage('derived'), 'edge');
  assert.equal(relationStorage('fork'), 'fork');
  assert.equal(relationStorage('version'), 'node_version');
  assert.throws(() => relationStorage('nope'), /未知关系/);
  assert.equal(propagates('derived'), true);
  assert.equal(propagates('fork'), false);
  assert.equal(propagates('version'), false);
});

test('派生矩阵覆盖全部类型，且反向依赖被拒', () => {
  for (const kind of NODE_KINDS) {
    assert.ok(kind in ALLOWED_DERIVED, `派生矩阵缺少 ${kind}`);
    assert.ok(kind in ALLOWED_FORK, `复制矩阵缺少 ${kind}`);
  }
  assert.deepEqual(canEdge('source', 'dataset', 'derived'), {ok: true});
  assert.deepEqual(canEdge('dataset', 'design', 'derived'), {ok: true});
  assert.deepEqual(canEdge('design', 'document', 'derived'), {ok: true});
  assert.equal(canEdge('design', 'design', 'derived').ok, false, '设计不能派生设计');
  assert.equal(canEdge('model', 'design', 'derived').ok, false, '反向依赖禁止');
  assert.equal(canEdge('dataset', 'dataset', 'derived').ok, true, '校正产生新数据集');
  assert.equal(canEdge('bundle', 'design', 'derived').ok, false);
  assert.equal(canEdge('nope', 'design', 'derived').ok, false);
  assert.equal(canEdge('version' in {} ? 'design' : 'design', 'design', 'version').ok, false, '版本不能写成边');
});

test('复制只允许设计之间；数据集不许复制', () => {
  assert.deepEqual(canEdge('design', 'design', 'fork'), {ok: true});
  for (const kind of NODE_KINDS.filter(k => k !== 'design')) {
    assert.equal(canEdge(kind, kind, 'fork').ok, false, `${kind} 不应允许复制`);
  }
  assert.equal(canEdge('design', 'dataset', 'fork').ok, false);
});

test('状态机：失效只从已确认出发，草稿与已作废不参与', () => {
  assert.equal(canTransition('draft', 'confirmed'), true);
  assert.equal(canTransition('confirmed', 'stale'), true);
  assert.equal(canTransition('stale', 'confirmed'), true, '复核后可回到确认');
  assert.equal(canTransition('confirmed', 'draft'), false);
  assert.equal(canTransition('superseded', 'confirmed'), false);
  assert.equal(canTransition('draft', 'stale'), false);
  assert.equal(canTransition(undefined, 'confirmed'), true, '缺省视为草稿');
  assert.deepEqual(STATUS_TRANSITIONS.superseded, []);
});

test('权威文件位置由契约给出，不允许自己拼目录', () => {
  assert.equal(datasetFile('d1'), 'data/datasets/d1/dataset.json');
  assert.equal(designVersionFile('scheme-a', 2), 'data/designs/scheme-a/versions/002.json');
  assert.throws(() => datasetFile('../escape'), /只能是字母/);
  assert.throws(() => designVersionFile('scheme', 0), /正整数/);
  assert.equal(kindOfIndexPath('data/designs/a/versions/001.json'), 'design');
  assert.equal(kindOfIndexPath('data/datasets/d1/dataset.json'), 'dataset');
  assert.equal(kindOfIndexPath('output/x.json'), null);
});

test('图校验：未知类型、未登记节点、自环、重复边、成环、非法依赖', () => {
  assert.deepEqual(validateGraph({
    nodes: [node('s', 'source'), node('d', 'dataset'), node('a', 'design')],
    edges: [edge('s', 'd'), edge('d', 'a')]
  }), []);

  const problems = (nodes, edges) => validateGraph({nodes, edges}).join('\n');
  assert.match(problems([node('a', 'weird')], []), /未知节点类型/);
  assert.match(problems([node('a', 'design', 'nope')], []), /未知状态/);
  assert.match(problems([node('a', 'design')], [edge('a', 'zzz')]), /未登记节点/);
  assert.match(problems([node('a', 'design')], [edge('a', 'a')]), /自环/);
  assert.match(problems([node('a', 'design'), node('m', 'model')], [edge('a', 'm'), edge('a', 'm')]), /重复边/);
  assert.match(problems([node('d', 'dataset')], [edge('d', 'd2'), {src: 'd2', dst: 'd', role: 'derived'}]),
    /未登记节点|成环/);
  assert.match(problems([node('a', 'design'), node('b', 'design')], [edge('a', 'b')]), /不允许派生/);
  assert.match(problems([node('m', 'model'), node('a', 'design')], [edge('m', 'a')]), /不允许派生/);
  // 复制边不参与环检测
  assert.deepEqual(validateGraph({nodes: [node('a', 'design'), node('b', 'design')], edges: [edge('a', 'b', 'fork')]}), []);
});

test('影响面：分层、去重、复制不传播、种子不算受影响', () => {
  const edges = [
    edge('d1', 'a'), edge('d1', 'b'),
    edge('a', 'm1'), edge('b', 'm1'),
    edge('m1', 'r1'),
    edge('a', 'copy', 'fork')
  ];
  const impact = impactOf({changed: ['d1'], edges});
  assert.deepEqual(impact.affected, [
    {id: 'a', depth: 1},
    {id: 'b', depth: 1},
    {id: 'm1', depth: 2},
    {id: 'r1', depth: 3}
  ]);
  assert.equal(impact.truncated, false);
  assert.equal(impact.visited, 5);

  const self = impactOf({changed: ['a'], edges});
  assert.deepEqual(self.affected.map(a => a.id), ['m1', 'r1'], '种子本身不列入受影响');

  const copy = impactOf({changed: ['a'], edges});
  assert.ok(!copy.affected.some(a => a.id === 'copy'), '复制不传播失效');
  assert.equal(impactOf({changed: [], edges}).impacted, false);
});

test('影响面：多层图不会指数爆炸，深度可截断', () => {
  const edges = [];
  for (let i = 0; i < 6; i++) {
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) edges.push(edge(`l${i}-${a}`, `l${i + 1}-${b}`));
  }
  const all = impactOf({changed: ['l0-0'], edges});
  assert.ok(all.affected.length <= 25, '重复访问不应重复计入');

  const shallow = impactOf({changed: ['l0-0'], edges, maxDepth: 1});
  assert.equal(shallow.truncated, true);
  assert.ok(shallow.affected.every(a => a.depth <= 1));
});

test('失效计划：只标已确认的受影响节点，草稿与已作废不动', () => {
  const nodes = [
    node('a', 'design', 'confirmed'),
    node('b', 'design', 'draft'),
    node('m', 'model', 'confirmed'),
    node('old', 'design', 'superseded'),
    node('done', 'model', 'stale')
  ];
  const plan = planStale({affected: [{id: 'a', depth: 1}, {id: 'b', depth: 1}, {id: 'm', depth: 2}, {id: 'old', depth: 1}, {id: 'done', depth: 1}, {id: 'ghost', depth: 1}], nodes});
  assert.deepEqual(plan.stale, [
    {id: 'a', from: 'confirmed', to: 'stale', depth: 1},
    {id: 'm', from: 'confirmed', to: 'stale', depth: 2}
  ]);
  const reasons = Object.fromEntries(plan.skipped.map(s => [s.id, s.reason]));
  assert.match(reasons.b, /草稿/);
  assert.match(reasons.old, /作废/);
  assert.match(reasons.done, /已是待复核/);
  assert.match(reasons.ghost, /未登记/);
});

test('校正链：只有引用了该数据集的设计版本被标待复核', () => {
  const nodes = [
    node('src', 'source', 'confirmed'),
    node('d1', 'dataset', 'confirmed'),
    node('d2', 'dataset', 'confirmed'),
    node('a', 'design', 'confirmed'),
    node('b', 'design', 'confirmed'),
    node('c', 'design', 'confirmed'),
    node('m1', 'model', 'confirmed'),
    node('doc1', 'document', 'confirmed'),
    node('r1', 'render', 'confirmed')
  ];
  const edges = [
    edge('src', 'd1'),
    edge('d1', 'd2'),          // 校正产生新数据集
    edge('d2', 'a'),           // a 引用新数据集
    edge('d2', 'b'),
    edge('d1', 'c'),           // c 只引用旧数据集
    edge('a', 'm1'),
    edge('a', 'doc1'),
    edge('a', 'r1'),
    edge('a', 'b', 'fork')     // b 是 a 的副本，只记录来源
  ];
  const plan = staleAfterChange({changed: ['d2'], nodes, edges});
  const marked = plan.stale.map(s => s.id).sort();
  assert.deepEqual(marked, ['a', 'b', 'doc1', 'm1', 'r1'], '受影响的设计版本与其下游被标记');
  assert.ok(!marked.includes('c'), '未引用该数据集的设计不受影响');
  assert.ok(!marked.includes('d1'), '上游不受影响');
  assert.equal(plan.skipped.length, 0);
});

test('来源追溯：能回答「基于哪版数据、哪版设计」', () => {
  const edges = [edge('src', 'd1'), edge('d1', 'a'), edge('a', 'm1'), edge('a', 'copy', 'fork')];
  assert.deepEqual(upstreamOf({node: 'm1', edges}), ['a', 'd1', 'src']);
  assert.deepEqual(upstreamOf({node: 'src', edges}), []);
  assert.ok(!upstreamOf({node: 'copy', edges}).includes('a'), '复制不算来源依赖');
});

test('性能：一千节点影响分析在 5 毫秒以内', () => {
  const nodes = [node('n0', 'dataset', 'confirmed')];
  const edges = [];
  for (let i = 1; i < 1000; i++) {
    nodes.push(node(`n${i}`, i % 3 === 0 ? 'design' : i % 3 === 1 ? 'model' : 'document', 'confirmed'));
    edges.push(edge(`n${i - 1}`, `n${i}`));
  }
  const samples = [];
  for (let i = 0; i < 7; i++) {
    const started = performance.now();
    const impact = impactOf({changed: ['n0'], edges});
    samples.push(performance.now() - started);
    assert.equal(impact.affected.length, 999);
  }
  samples.sort((a, b) => a - b);
  assert.ok(samples[3] < 5, `一千节点影响分析中位 ${samples[3].toFixed(2)}ms，应低于 5ms`);
});
