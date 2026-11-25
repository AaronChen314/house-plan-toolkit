import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  GLOBAL_INDEX_SCHEMA, FORBIDDEN_FIELDS, globalRecord, validateGlobalRecord, normalizeQuery
} from '../src/contracts/index.mjs';
import {openStore} from '../src/store/index.mjs';
import {closeGlobal, globalIndexFile, listGlobal, statGlobal, syncGlobal} from '../src/indexer/global.mjs';
import {sqliteAvailable} from '../src/indexer/index.mjs';
import {buildIndex} from '../src/indexer/index.mjs';

const BIN = fileURLToPath(new URL('../bin/space.mjs', import.meta.url));
const sqlite = await sqliteAvailable();
const space = (env, ...args) => spawnSync(process.execPath, [BIN, ...args], {encoding: 'utf8', env: {...process.env, ...env}});

const record = (over = {}) => globalRecord({
  projectId: 'demo', name: '示例', path: path.join('demo-project'), toolkit: '0.6.0',
  updatedAt: '2026-11-25T00:00:00.000Z', entities: 12, layers: 3, datasets: 1, designs: 1, documents: 1, renders: 1, ...over
});

test('全局索引记录：只存摘要，几何与内容字段一律拒绝', () => {
  assert.equal(GLOBAL_INDEX_SCHEMA, 'space-global-index/v1');
  assert.deepEqual(validateGlobalRecord(record()), []);
  for (const field of FORBIDDEN_FIELDS) {
    assert.match(validateGlobalRecord({...record(), [field]: [[0, 0]]}).join(), new RegExp(field), `${field} 必须被拒`);
  }
  assert.match(validateGlobalRecord(record({projectId: ''})).join(), /项目 id/);
  assert.match(validateGlobalRecord(record({path: ''})).join(), /项目路径/);
  assert.match(validateGlobalRecord(record({entities: -1})).join(), /非负整数/);
  assert.match(validateGlobalRecord(record({updatedAt: null})).join(), /同步时间/);
  assert.equal(normalizeQuery('  a  '), 'a');
  assert.equal(normalizeQuery('x'.repeat(500)).length, 200);
});

test('全局索引：位置在项目之外，可以按环境变量重定向', () => {
  const file = globalIndexFile({home: path.join('someones-home')});
  assert.equal(file.endsWith(path.join('.cache', 'house-plan', 'index.sqlite')), true, `默认位置不对：${file}`);
  assert.equal(file.includes('someones-home'), true, '默认位置在用户缓存目录下');
  const override = path.join(os.tmpdir(), 'x.sqlite');
  assert.equal(globalIndexFile({override}), path.resolve(override));
  // 构造不校验，校验器负责报错
  assert.match(validateGlobalRecord(globalRecord({projectId: 'x'})).join(), /项目路径/);
});

test('同步与检索：一个项目一条摘要，不含几何列', {skip: !sqlite && 'node:sqlite 不可用'}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-global-'));
  const projectFile = path.join(dir, 'project.json');
  const dbFile = path.join(dir, 'global.sqlite');
  fs.writeFileSync(projectFile, JSON.stringify({schema: 'space-project/v1', id: 'global-demo', name: '全局示例', output: 'output'}, null, 2));
  fs.mkdirSync(path.join(dir, 'output/cad'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'output/cad/source.json'), JSON.stringify({
    schema: 'cad-source/v1', source: {file: 'plan.dxf'},
    entities: [{id: 'E1', handle: 'H1', type: 'LINE', layer: 'WALL', points: [[0, 0], [1000, 0]]}], issues: []
  }));
  const store = openStore(projectFile);
  await buildIndex(store, {source: 'output/cad/source.json'});

  process.env.SPACE_GLOBAL_INDEX = dbFile;
  try {
    closeGlobal();
    const synced = await syncGlobal(store);
    assert.equal(synced.record.projectId, 'global-demo');
    assert.equal(synced.record.entities, 1);
    assert.equal(synced.record.datasets, 0);

    const listed = await listGlobal();
    assert.equal(listed.available, true);
    assert.equal(listed.rows.length, 1);
    assert.equal(listed.rows[0].projectId, 'global-demo');
    assert.equal(listed.rows[0].name, '全局示例');

    const searched = await listGlobal({q: 'global'});
    assert.equal(searched.rows.length, 1);
    assert.equal((await listGlobal({q: 'nope'})).rows.length, 0);

    const stat = await statGlobal();
    assert.equal(stat.projects, 1);
    assert.equal(stat.entities, 1);

    // 再同步一次是更新，不是新增
    await syncGlobal(store);
    assert.equal((await statGlobal()).projects, 1);

    // 表结构里没有几何/内容列
    const {openGlobal} = await import('../src/indexer/global.mjs');
    const opened = await openGlobal({file: dbFile});
    const columns = opened.db.prepare('PRAGMA table_info(project)').all().map(c => c.name);
    for (const forbidden of FORBIDDEN_FIELDS) assert.equal(columns.includes(forbidden), false, `表里不应有 ${forbidden}`);
    assert.ok(columns.includes('entities') && columns.includes('updated_at'));

    // 全局索引不在项目里
    assert.equal(fs.existsSync(path.join(dir, '.space', 'global.sqlite')), false);
    assert.equal(store.verify().ok, true);
  } finally {
    closeGlobal();
    delete process.env.SPACE_GLOBAL_INDEX;
  }
});

test('CLI：index global sync / list / stat', {skip: !sqlite && 'node:sqlite 不可用'}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-global-cli-'));
  const projectFile = path.join(dir, 'project.json');
  const dbFile = path.join(dir, 'global.sqlite');
  fs.writeFileSync(projectFile, JSON.stringify({schema: 'space-project/v1', id: 'cli-demo', name: 'CLI 示例', output: 'output'}));

  const statEmpty = space({SPACE_GLOBAL_INDEX: dbFile}, 'index', 'global', 'stat');
  assert.equal(statEmpty.status, 0, statEmpty.stderr);
  assert.match(statEmpty.stdout, /全局索引不可用|0 个项目/);

  const sync = space({SPACE_GLOBAL_INDEX: dbFile}, 'index', 'global', 'sync', '--project', projectFile);
  assert.equal(sync.status, 0, sync.stderr);
  assert.match(sync.stdout, /已同步到全局索引：cli-demo/);
  assert.match(sync.stdout, /不含几何/);

  const list = space({SPACE_GLOBAL_INDEX: dbFile}, 'index', 'global', 'list');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /cli-demo/);
  assert.match(list.stdout, /CLI 示例/);

  const stat = space({SPACE_GLOBAL_INDEX: dbFile}, 'index', 'global', 'stat');
  assert.match(stat.stdout, /1 个项目/);

  // list 不需要 --project
  const noProject = space({SPACE_GLOBAL_INDEX: dbFile}, 'index', 'global', 'list', '--json');
  assert.equal(noProject.status, 0, noProject.stderr);
  assert.equal(JSON.parse(noProject.stdout).rows[0].projectId, 'cli-demo');
});
