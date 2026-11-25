import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runCapability} from '../src/capabilities/index.mjs';
import {openStore} from '../src/store/index.mjs';
import {buildIndex, statIndexFor, cacheKey, writeParseCache, PARSER, sqliteAvailable} from '../src/indexer/index.mjs';

const sqlite = await sqliteAvailable();

// 假 Python：一旦被调用就以 7 退出，用来证明「命中缓存就不启动解析器」。
function fakePython() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-fakepy-'));
  const exe = path.join(dir, 'python3');
  fs.writeFileSync(exe, '#!/bin/sh\nexit 7\n', {mode: 0o755});
  return exe;
}

const CAD_SOURCE = {
  schema: 'cad-source/v1',
  source: {file: 'plan.dxf', sha256: 'x'},
  units: 'mm',
  entities: [
    {id: 'E1', handle: '1A', type: 'LINE', layer: 'WALL', points: [[0, 0], [4000, 0]]},
    {id: 'E2', handle: '1B', type: 'LINE', layer: 'WALL', points: [[0, 0], [0, 3000]]},
    {id: 'E3', handle: '1C', type: 'TEXT', layer: 'DIM', points: [[500, 500]], text: '3600', at: [500, 500]}
  ],
  issues: [{kind: 'note', message: '示例'}]
};

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-source-'));
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({schema: 'space-project/v1', id: 'source-demo', output: 'output'}, null, 2));
  fs.mkdirSync(path.join(dir, 'source/drawings'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'source/drawings/plan.dxf'), 'synthetic-dxf-bytes');
  return {dir, file: path.join(dir, 'project.json'), store: openStore(path.join(dir, 'project.json'))};
}

function seedParseCache(store, dxfRel) {
  const sha = store.hashOf(dxfRel);
  const key = cacheKey({sourceSha256: sha, parser: PARSER});
  writeParseCache(store.derived('cache'), key, {data: CAD_SOURCE, parser: PARSER, params: {}, sourceSha256: sha});
  return key;
}

test('cad.inspect 命中解析缓存时不启动 Python', async () => {
  const {file, store} = tempProject();
  seedParseCache(store, 'source/drawings/plan.dxf');
  const before = process.env.SPACE_PYTHON;
  process.env.SPACE_PYTHON = fakePython();
  try {
    const r = await runCapability({project: file, capability: 'cad.inspect', params: {dxf: 'source/drawings/plan.dxf'}});
    assert.equal(r.data.cacheHit, true);
    assert.equal(r.data.entities, 3);
    assert.equal(r.data.issues, 1);
    assert.match(r.summary, /命中解析缓存/);
    assert.deepEqual(r.outputs.map(o => o.path), ['output/cad/source.json']);
  } finally {
    if (before === undefined) delete process.env.SPACE_PYTHON; else process.env.SPACE_PYTHON = before;
  }

  const written = store.files().files['output/cad/source.json'];
  assert.ok(written, '索引产物要登记');
  assert.equal(written.mode, 'artifact');
  assert.equal(store.readJson('output/cad/source.json').entities.length, 3);
  const event = store.events().find(e => e.path === 'output/cad/source.json');
  assert.equal(event.op, 'cad.inspect');
  assert.equal(event.sha256, written.sha256);
  assert.equal(store.verify().ok, true);
});

test('cad.inspect 缓存未命中时确实调用解析器，失败按 E_EXEC_DEPENDENCY 报', async () => {
  const {file} = tempProject();
  const before = process.env.SPACE_PYTHON;
  process.env.SPACE_PYTHON = fakePython();
  try {
    await assert.rejects(
      runCapability({project: file, capability: 'cad.inspect', params: {dxf: 'source/drawings/plan.dxf'}}),
      /解析失败|E_EXEC_PROCESS/
    );
  } finally {
    if (before === undefined) delete process.env.SPACE_PYTHON; else process.env.SPACE_PYTHON = before;
  }
});

test('cad.inspect 缺文件与越界路径仍然被拒', async () => {
  const {file} = tempProject();
  await assert.rejects(runCapability({project: file, capability: 'cad.inspect', params: {dxf: 'source/drawings/none.dxf'}}), /文件不存在/);
  await assert.rejects(runCapability({project: file, capability: 'cad.inspect', params: {dxf: '../outside.dxf'}}), /越界/);
});

test('建索引时登记 dataset 节点，重复重建不重复登记', {skip: !sqlite && 'node:sqlite 不可用'}, async () => {
  const {store} = tempProject();
  const parse = async () => CAD_SOURCE;
  const first = await buildIndex(store, {source: 'source/drawings/plan.dxf', parse});
  const stat = await statIndexFor(store);
  assert.equal(stat.nodes.dataset, 1, '数据集节点应登记');

  const second = await buildIndex(store, {source: 'source/drawings/plan.dxf', parse});
  assert.equal(second.dataset, first.dataset);
  assert.equal((await statIndexFor(store)).nodes.dataset, 1, '重建不应新增节点');
});
