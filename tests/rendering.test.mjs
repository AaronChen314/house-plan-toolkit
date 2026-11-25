import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RENDER_KINDS, renderKind, DEFAULT_CAMERA, normalizeCamera, validateCamera,
  styleSplit, renderFile, renderRecordFile, renderRecord, validateRender,
  bundleDir, bundleManifestFile, bundleManifest, validateBundle, BUNDLE_ROLES,
  snapshotFile, snapshotRecord, validateSnapshot, MAX_SNAPSHOT_BYTES,
  isGenerated, assertSourceNotGenerated
} from '../src/contracts/index.mjs';
import {
  cameraKey, canonicalEntries, bundleSummary, bundleProblems, snapshotWithinLimit, assertStyleOnly, entryRoleOf
} from '../src/domain/rendering.mjs';

const sha = (c) => c.repeat(64);
const inputs = () => ({dataset: {id: 'd1', sha256: sha('1')}, design: {scheme: 'a', seq: 1, sha256: sha('2'), status: 'confirmed'}});

test('渲染图种：效果图只有契约，彩平可用', () => {
  assert.deepEqual(RENDER_KINDS.map(r => `${r.id}:${r.implemented}`), ['colorplan:true', 'interior:false']);
  assert.equal(renderKind('colorplan').ext, 'svg');
  assert.equal(renderKind('interior').ext, 'png');
  assert.equal(renderKind('nope'), null);
});

test('固定机位：默认值可覆盖，非法值被拒', () => {
  assert.deepEqual(normalizeCamera(), DEFAULT_CAMERA);
  const cam = normalizeCamera({azimuthDeg: 90, target: [1, 2, 3]});
  assert.equal(cam.azimuthDeg, 90);
  assert.deepEqual(cam.target, [1, 2, 3]);
  assert.deepEqual(validateCamera(normalizeCamera()), []);
  assert.match(validateCamera({...DEFAULT_CAMERA, target: [1, 2]}).join(), /target/);
  assert.match(validateCamera({...DEFAULT_CAMERA, distanceMm: 0}).join(), /距离/);
  assert.match(validateCamera({...DEFAULT_CAMERA, fovDeg: 200}).join(), /视角/);
  assert.match(validateCamera(null).join(), /对象/);
});

test('渲染记录：路径、机位指纹与输入链', () => {
  assert.equal(renderFile({kind: 'colorplan', scheme: 'a', seq: 2}), 'output/render/colorplan/a-002.svg');
  assert.equal(renderRecordFile({kind: 'colorplan', scheme: 'a', seq: 2}), 'output/render/colorplan/a-002.json');
  assert.throws(() => renderFile({kind: 'nope', scheme: 'a', seq: 1}), /未知渲染图种/);
  assert.throws(() => renderFile({kind: 'colorplan', scheme: '../x', seq: 1}), /方案 id/);
  assert.throws(() => renderFile({kind: 'colorplan', scheme: 'a', seq: 0}), /正整数/);

  const record = renderRecord({
    kind: 'colorplan', file: 'output/render/colorplan/a-001.svg', sha256: sha('a'), bytes: 100,
    camera: {azimuthDeg: 90}, inputs: inputs()
  });
  assert.deepEqual(validateRender(record), []);
  assert.equal(record.deterministic, true);
  assert.equal(record.camera.azimuthDeg, 90);
  assert.deepEqual(styleSplit({}), {base: null, style: null});

  assert.match(validateRender({...record, kind: 'nope'}).join(), /未知渲染图种/);
  assert.match(validateRender({...record, inputs: {}}).join(), /设计版本/);
  assert.match(validateRender({...record, deterministic: false}).join(), /deterministic/);
  assert.match(validateRender({...record, camera: {}}).join(), /机位/);
});

test('交付包：只读、逐文件哈希、角色受限、路径不重复', () => {
  assert.equal(bundleDir('v1'), 'output/bundle/v1');
  assert.equal(bundleManifestFile('v1'), 'output/bundle/v1/manifest.json');
  assert.throws(() => bundleDir('../x'), /包名/);

  const value = bundleManifest({
    name: 'v1',
    design: {scheme: 'a', seq: 1},
    entries: [
      {path: 'design/design.json', role: 'design', sha256: sha('1'), bytes: 10},
      {path: 'doc/wall-demolition/a-001.svg', role: 'document', sha256: sha('2'), bytes: 20}
    ]
  });
  assert.deepEqual(validateBundle(value), []);
  assert.equal(value.readOnly, true);
  assert.ok(BUNDLE_ROLES.includes('render'));

  assert.match(validateBundle({...value, readOnly: false}).join(), /readOnly/);
  assert.match(validateBundle({...value, design: null}).join(), /设计版本/);
  assert.match(validateBundle({...value, entries: []}).join(), /至少要包含/);
  assert.match(validateBundle({...value, entries: [{...value.entries[0], role: 'weird'}]}).join(), /未知角色/);
  assert.match(validateBundle({...value, entries: [value.entries[0], value.entries[0]]}).join(), /路径重复/);
});

test('只读快照：单文件、离线、不可回写、有体积上限', () => {
  assert.equal(snapshotFile('v1'), 'output/snapshot/v1.html');
  assert.throws(() => snapshotFile(''), /快照名/);
  const record = snapshotRecord({name: 'v1', file: 'output/snapshot/v1.html', bytes: 1024, hashes: [{path: 'design.json', sha256: sha('1')}], embedded: ['design.json'], design: {scheme: 'a', seq: 1}});
  assert.deepEqual(validateSnapshot(record), []);
  assert.equal(record.writable, false);
  assert.match(validateSnapshot({...record, writable: true}).join(), /writable/);
  assert.match(validateSnapshot({...record, offline: false}).join(), /offline/);
  assert.match(validateSnapshot({...record, hashes: []}).join(), /哈希清单/);
  assert.match(validateSnapshot({...record, bytes: MAX_SNAPSHOT_BYTES + 1}).join(), /体积上限/);
  assert.equal(snapshotWithinLimit(1024), true);
  assert.equal(snapshotWithinLimit(0), false);
});

test('写权限守卫：生成物不能当输入', () => {
  assert.equal(isGenerated('output/doc/a.svg'), true);
  assert.equal(isGenerated('output'), true);
  assert.equal(isGenerated('data/model.json'), false);
  assert.equal(isGenerated('output2/x'), false);
  assert.throws(() => assertSourceNotGenerated('output/render/colorplan/a.svg'), /不能作为输入/);
  assert.equal(assertSourceNotGenerated('data/datasets/d1/dataset.json'), true);
});

test('领域辅助：机位指纹稳定、条目排序去重、包问题分类', () => {
  const a = cameraKey({azimuthDeg: 90, elevationDeg: 30, distanceMm: 6000, fovDeg: 45, target: [0, 1500, 0]});
  const b = cameraKey(normalizeCamera({azimuthDeg: 90, target: [0, 1500, 0]}));
  assert.equal(a, b);
  assert.notEqual(a, cameraKey({azimuthDeg: 91, target: [0, 1500, 0]}));

  const entries = canonicalEntries([
    {path: 'b.svg', role: 'document', sha256: sha('2'), bytes: 2},
    {path: 'a.json', role: 'design', sha256: sha('1'), bytes: 1},
    {path: 'b.svg', role: 'document', sha256: sha('2'), bytes: 2}
  ]);
  assert.deepEqual(entries.map(e => e.path), ['a.json', 'b.svg']);
  assert.deepEqual(bundleSummary({entries}), {files: 2, bytes: 3, byRole: {document: 1, design: 1}});
  assert.deepEqual(bundleProblems({entries}, {'a.json': sha('1')}), {missing: ['b.svg'], mismatched: []});
  assert.deepEqual(bundleProblems({entries}, {'a.json': sha('1'), 'b.svg': sha('9')}), {missing: [], mismatched: ['b.svg']});

  assert.equal(entryRoleOf('data/designs/a/design.json'), 'design');
  assert.equal(entryRoleOf('data/datasets/d1/dataset.json'), 'dataset');
  assert.equal(entryRoleOf('data/datasets/d1/model.json'), 'model');
  assert.equal(entryRoleOf('output/doc/wall-demolition/a-001.svg'), 'document');
  assert.equal(entryRoleOf('output/render/colorplan/a-001.svg'), 'render');
  assert.equal(entryRoleOf('output/model/preview.glb'), 'model');

  assert.throws(() => assertStyleOnly({geometry: {}}), /不能包含几何/);
  assert.throws(() => assertStyleOnly({id: 'x'}, {geometryLocked: false}), /锁定几何/);
  assert.equal(assertStyleOnly({id: 'x'}, {geometryLocked: true}), true);
});
