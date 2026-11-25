import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  ERROR_CODES, ERROR_CODE_SET, SpaceError, fail, isSpaceError,
  SCHEMAS, SCHEMA_SET, schemaCompatible, requireSchema,
  CAPABILITY_FIELDS, SIDE_EFFECTS, STAGE_IDS, PARAM_TYPES, validateCapability, validateRegistry, isSchemaRef,
  STORE_METHODS, STORE_METHOD_NAMES, STORE_INVARIANTS, WRITE_MODES, writeModeFor, artifactBlocked, assertStoreInterface,
  EXIT, JOB_STATES, WORKER_FRAMES, RESULT_FIELDS, failureResult, exitCodeFor, jobFrame, workerFrame, parseWorkerFrame
} from '../src/contracts/index.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('错误码表：四类前缀、编号唯一、每条都有说明', () => {
  const codes = ERROR_CODES.map(e => e.code);
  assert.equal(new Set(codes).size, codes.length, '错误码重复');
  const prefixes = new Set(ERROR_CODES.map(e => e.category));
  assert.deepEqual([...prefixes].sort(), ['data', 'exec', 'publish', 'store']);
  const prefixByCategory = {data: 'E_DATA_', exec: 'E_EXEC_', store: 'E_STORE_', publish: 'E_PUBLISH_'};
  for (const e of ERROR_CODES) {
    assert.ok(e.code.startsWith(prefixByCategory[e.category]), `${e.code} 前缀与分类不符`);
    assert.ok(e.message && e.message.length > 3, `${e.code} 缺少说明`);
  }
  assert.equal(ERROR_CODE_SET.size, codes.length);
});

test('错误对象携带分类；未登记的错误码不能伪造', () => {
  const e = fail('E_STORE_CONFLICT', '哈希不一致');
  assert.ok(e instanceof SpaceError);
  assert.ok(isSpaceError(e));
  assert.equal(e.category, 'store');
  assert.deepEqual(Object.keys(e.toJSON()).sort(), ['category', 'code', 'message']);
  assert.throws(() => fail('E_NOT_REAL'), /未登记的错误码/);
});

test('schema 登记表：路径存在、编号唯一、兼容窗口按大版本判断', () => {
  const ids = SCHEMAS.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(SCHEMA_SET.size, ids.length);
  for (const s of SCHEMAS) {
    assert.ok(['authoritative', 'derived'].includes(s.role), `${s.id} role 不合法`);
    if (s.file) assert.ok(fs.existsSync(path.join(ROOT, s.file)), `${s.id} 指向的 schema 文件不存在：${s.file}`);
  }
  assert.ok(schemaCompatible('space-model/v1', 'space-model/v1'));
  assert.equal(schemaCompatible('space-model/v1', 'space-model/v3'), false);
  assert.equal(schemaCompatible('space-model/v1', 'design-sync/v1'), false);
  assert.equal(requireSchema('space-model/v1', 'space-model/v1'), 'space-model/v1');
});

test('能力契约：字段固定、取值受限、错误码必须已登记', () => {
  assert.deepEqual(CAPABILITY_FIELDS, ['id', 'version', 'stage', 'title', 'description', 'params', 'inputs', 'outputs', 'sideEffects', 'requires', 'idempotent', 'errors']);
  const good = {
    id: 'demo.thing',
    version: '1.0.0',
    stage: 'source',
    title: '示例',
    description: '示例能力',
    params: [{key: 'file', label: '文件', type: 'path', required: true}],
    inputs: {file: 'path:dxf'},
    outputs: {index: 'cad-source/v1'},
    sideEffects: ['write:artifact'],
    requires: ['python:cad'],
    idempotent: true,
    errors: ['E_EXEC_PARAM'],
    run: async () => ({})
  };
  assert.deepEqual(validateCapability(good), []);
  assert.deepEqual(validateRegistry([good]), []);

  const bad = {...good, id: 'not-a-dotted-id', version: '1.0', stage: 'nope', sideEffects: ['write:everything'], requires: ['ruby:gem'], errors: ['E_MADE_UP'], idempotent: 'yes'};
  const problems = validateRegistry([bad, good]).join('\n');
  assert.match(problems, /点分/);
  assert.match(problems, /version/);
  assert.match(problems, /stage/);
  assert.match(problems, /write:everything/);
  assert.match(problems, /ruby:gem/);
  assert.match(problems, /E_MADE_UP/);
  assert.match(problems, /idempotent/);

  assert.ok(SIDE_EFFECTS.includes('none'));
  assert.ok(PARAM_TYPES.includes('select'));
  assert.ok(STAGE_IDS.includes('delivery'));
  assert.ok(isSchemaRef('artifact:html') && isSchemaRef('space-model/v1') && !isSchemaRef('whatever'));
});

test('能力注册表本身满足契约（space capabilities --check 的对象）', async () => {
  const {capabilities, checkCapabilities, listCapabilities} = await import('../src/capabilities/index.mjs');
  assert.deepEqual(checkCapabilities(), []);
  assert.equal(listCapabilities().length, capabilities.length);
  for (const cap of listCapabilities()) {
    assert.equal(cap.run, undefined, '注册表不暴露实现');
    for (const field of CAPABILITY_FIELDS) assert.ok(field in cap, `${cap.id} 缺少 ${field}`);
  }
});

test('存储接口契约：方法不重复，写入模式覆盖所有目录', () => {
  const names = STORE_METHODS.map(m => m.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(STORE_INVARIANTS.length >= 5);
  assert.deepEqual(WRITE_MODES, ['artifact', 'data']);
  assert.equal(writeModeFor('output/白模.html'), 'artifact');
  assert.equal(writeModeFor('data/model.json'), 'data');
  assert.equal(writeModeFor('source/manifest.json'), 'data');
  assert.equal(writeModeFor('project.json'), 'data');
  assert.equal(artifactBlocked('data/x.json'), true);
  assert.equal(artifactBlocked('output/x.json'), false);
  assert.throws(() => assertStoreInterface({}), /缺少方法/);
});

test('传输契约：退出码、作业帧与 worker 帧可解析', () => {
  assert.deepEqual(EXIT, {OK: 0, FAIL: 1, USAGE: 2});
  assert.ok(RESULT_FIELDS.includes('outputs'));
  assert.equal(exitCodeFor({ok: true}), EXIT.OK);
  assert.equal(exitCodeFor(failureResult(new SpaceError('E_STORE_CONFLICT'))), EXIT.FAIL);
  assert.equal(exitCodeFor(failureResult(new SpaceError('E_EXEC_PARAM'))), EXIT.USAGE);
  assert.equal(jobFrame('progress', {pct: 10}).type, 'progress');
  assert.throws(() => jobFrame('done'), /未知作业帧/);
  assert.ok(JOB_STATES.includes('cancelled'));
  const frame = parseWorkerFrame(workerFrame('progress', {pct: 40}));
  assert.equal(frame.type, 'progress');
  assert.equal(frame.pct, 40);
  assert.deepEqual(parseWorkerFrame('not json').type, 'log');
  assert.deepEqual(parseWorkerFrame(JSON.stringify({type: 'progress'})).type, 'log', '缺 schema 的消息不当数据帧');
  assert.ok(WORKER_FRAMES.includes('result'));
});
