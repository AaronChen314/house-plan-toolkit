import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  PLANNED_CAPABILITIES, PLANNED_FIELDS, PLANNED_IDS, validatePlanned, validatePlannedRegistry, STAGE_IDS
} from '../src/contracts/index.mjs';
import {capabilityCatalog, checkCapabilities, listCapabilities, listPlanned} from '../src/capabilities/index.mjs';
import {startStudio} from '../src/server/studio.mjs';

const BIN = fileURLToPath(new URL('../bin/space.mjs', import.meta.url));
const EXAMPLE = fileURLToPath(new URL('../examples/two-level/project.json', import.meta.url));
const space = (...args) => spawnSync(process.execPath, [BIN, ...args], {encoding: 'utf8'});

test('计划中的能力：字段齐全、不带实现、分组合法、id 不重复', () => {
  assert.deepEqual(validatePlannedRegistry(PLANNED_CAPABILITIES), []);
  assert.ok(PLANNED_IDS.length >= 3);
  for (const entry of PLANNED_CAPABILITIES) {
    for (const field of PLANNED_FIELDS) assert.ok(field in entry, `${entry.id} 缺少 ${field}`);
    assert.ok(STAGE_IDS.includes(entry.stage), `${entry.id} 分组不合法`);
    assert.equal('run' in entry, false, '计划项不能带实现');
  }
  // 反例：缺阻塞原因、带实现、重复、分组错
  assert.match(validatePlanned({...PLANNED_CAPABILITIES[0], blockedBy: ''}).join(), /阻塞原因/);
  assert.match(validatePlanned({...PLANNED_CAPABILITIES[0], run: () => {}}).join(), /不能带实现/);
  assert.match(validatePlanned({...PLANNED_CAPABILITIES[0], stage: 'nope'}).join(), /stage/);
  assert.match(validatePlannedRegistry([PLANNED_CAPABILITIES[0], PLANNED_CAPABILITIES[0]]).join(), /重复/);
});

test('能力目录：已实现与计划中分开，id 不重叠，契约 lint 通过', () => {
  const catalog = capabilityCatalog();
  assert.equal(catalog.implemented.length, listCapabilities().length);
  assert.deepEqual(catalog.planned.map(p => p.id), PLANNED_IDS);
  const implementedIds = new Set(catalog.implemented.map(c => c.id));
  for (const id of PLANNED_IDS) assert.equal(implementedIds.has(id), false, `${id} 同时出现在两份清单里`);
  assert.deepEqual(checkCapabilities(), []);
  assert.ok(listPlanned().every(p => p.planned === true));
});

test('CLI 门面：cap list / show / run 覆盖全部能力', () => {
  const listed = JSON.parse(space('cap', 'list', '--json').stdout);
  assert.equal(listed.implemented.length, listCapabilities().length);
  assert.deepEqual(listed.planned.map(p => p.id), PLANNED_IDS);

  const show = space('cap', 'show', 'model.validate');
  assert.equal(show.status, 0);
  assert.match(show.stdout, /副作用/);

  const planned = space('cap', 'show', 'render.interior');
  assert.equal(planned.status, 0);
  assert.match(planned.stdout, /未实现/);

  // 已实现的能跑（只读能力，不产生文件）
  const run = space('cap', 'run', 'model.validate', '--project', EXAMPLE);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /通过/);

  // 计划中的能力：明确拒绝，并给出阻塞原因
  const refused = space('cap', 'run', 'doc.mep', '--project', EXAMPLE);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /还没有实现/);
  assert.match(refused.stderr, /点位数据/);

  // 契约里没有的参数要直接报错，不能静默忽略
  const bad = space('cap', 'run', 'model.validate', '--project', EXAMPLE, '--nope', '1');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /没有这些参数/);
  assert.match(bad.stderr, /--project|可用/);

  assert.equal(space('cap', 'show', 'nope.nope').status, 1);
});

test('space capabilities 同时给出已实现与计划中', () => {
  const r = JSON.parse(space('capabilities').stdout);
  assert.ok(Array.isArray(r.implemented) && Array.isArray(r.planned));
  assert.equal(r.implemented.length, listCapabilities().length);
  assert.deepEqual(r.planned.map(p => p.id), PLANNED_IDS);

  const check = space('capabilities', '--check');
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /已实现/);
  assert.match(check.stdout, /计划中/);
});

test('工作台门面：/api/capabilities 给计划项，运行时拒绝计划项', async () => {
  const server = await startStudio({project: EXAMPLE, port: 0});
  try {
    const caps = await (await fetch(new URL('/api/capabilities', server.url))).json();
    assert.ok(caps.capabilities.length >= 20);
    assert.deepEqual(caps.planned.map(p => p.id), PLANNED_IDS);
    for (const p of caps.planned) assert.ok(p.blockedBy);

    const run = await fetch(new URL('/api/run', server.url), {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({project: EXAMPLE, capability: 'doc.furniture', params: {}})
    });
    const body = await run.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /还没有实现|未实现/);
  } finally {
    await server.close();
  }
});

test('门面自检：每条计划项都在两个宿主上可达', () => {
  const listed = JSON.parse(space('cap', 'list', '--json').stdout);
  for (const id of PLANNED_IDS) {
    assert.ok(listed.planned.some(p => p.id === id), `CLI 缺 ${id}`);
    const show = space('cap', 'show', id);
    assert.equal(show.status, 0, `CLI 无法查看 ${id}`);
  }
  // 已实现的能力都要能从 CLI 门面跑（这里只校验能被识别，不执行）
  for (const cap of listCapabilities()) {
    const show = space('cap', 'show', cap.id);
    assert.equal(show.status, 0, `CLI 门面缺 ${cap.id}`);
    assert.match(show.stdout, new RegExp(cap.stage));
  }
});
