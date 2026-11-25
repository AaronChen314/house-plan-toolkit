import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOC_KINDS, DOC_KIND_IDS, docKind, LAYERS, LAYER_IDS, KIND_LAYERS, SHEET_DEFAULTS, ITEM_KINDS,
  layerOf, layersFor, sheetSpec, validateSheetSpec, deliverableFile, docManifestFile, docKey, inputChain,
  deliverable, validateDeliverable, manifest, validateManifest
} from '../src/contracts/index.mjs';
import {staleReasonOf, withStaleness, upsertDoc, summarizeManifest, existingDoc, sameBytes} from '../src/domain/documents.mjs';

const sha = (c) => c.repeat(64);

test('图种：只有实现了的图种才标 implemented', () => {
  assert.deepEqual(DOC_KIND_IDS, ['wall-demolition', 'mep', 'furniture']);
  assert.equal(docKind('wall-demolition').implemented, true);
  assert.equal(docKind('mep').implemented, false);
  assert.equal(docKind('nope'), null);
  for (const kind of DOC_KIND_IDS) assert.equal(docKind(kind).implemented, kind === 'wall-demolition');
});

test('图层规范：顺序固定、颜色与线宽齐备、按图种隔离', () => {
  assert.deepEqual(LAYER_IDS, [...LAYER_IDS].sort((a, b) => LAYERS[a].order - LAYERS[b].order));
  for (const id of LAYER_IDS) {
    const layer = layerOf(id);
    assert.ok(layer.name && layer.color && Number.isFinite(layer.width), `${id} 缺字段`);
  }
  const walls = layersFor('wall-demolition').map(l => l.id);
  assert.deepEqual(walls, ['frame', 'wall-existing', 'wall-demolish', 'wall-new', 'opening', 'dimension', 'note']);
  assert.ok(!layersFor('wall-demolition').some(l => l.id === 'mep-point'), '水电图层不能出现在拆改图');
  assert.deepEqual(layersFor('nope'), []);
  for (const kind of DOC_KIND_IDS) for (const layer of KIND_LAYERS[kind]) assert.ok(LAYERS[layer], `${kind} 引用了未登记图层 ${layer}`);
});

test('图面数据：合法通过，越界图层与坏坐标被拒', () => {
  const spec = sheetSpec({
    kind: 'wall-demolition',
    title: '拆改图',
    items: [
      {layer: 'wall-existing', kind: 'polyline', points: [[0, 0], [1000, 0]]},
      {layer: 'wall-demolish', kind: 'polyline', points: [[0, 0], [0, 800]]},
      {layer: 'dimension', kind: 'dimension', from: [0, 0], to: [1000, 0], offset: -120, label: '1000'},
      {layer: 'note', kind: 'text', at: [10, 10], text: '保留原墙', height: 40}
    ],
    notes: ['拆除前现场复核']
  });
  assert.equal(spec.schema, 'space-sheet/v1');
  assert.equal(spec.size.width, SHEET_DEFAULTS.width);
  assert.deepEqual(validateSheetSpec(spec), []);

  assert.match(validateSheetSpec({...spec, kind: 'nope'}).join(), /未知图种/);
  assert.match(validateSheetSpec({...spec, scale: 0}).join(), /比例/);
  assert.match(validateSheetSpec(sheetSpec({kind: 'wall-demolition', title: 't', items: [{layer: 'mep-point', kind: 'point', at: [0, 0]}]})).join(), /不在该图种的规范里/);
  assert.match(validateSheetSpec(sheetSpec({kind: 'wall-demolition', title: 't', items: [{layer: 'note', kind: 'text', at: [0, 0], text: ''}]})).join(), /文字为空/);
  assert.match(validateSheetSpec(sheetSpec({kind: 'wall-demolition', title: 't', items: [{layer: 'wall-new', kind: 'polyline', points: [[0, 0]]}]})).join(), /至少两个点/);
  assert.match(validateSheetSpec(sheetSpec({kind: 'wall-demolition', title: 't', items: [{layer: 'note', kind: 'text', at: [0, 'x'], text: 'a'}]})).join(), /缺少坐标/);
  assert.match(validateSheetSpec(sheetSpec({kind: 'wall-demolition', title: 't', items: [{layer: 'dimension', kind: 'dimension', from: [0, 0], to: [1, 1]}]})).join(), /缺少偏移/);
  assert.ok(ITEM_KINDS.includes('polygon'));
});

test('交付物路径与记录：缺设计版本或数据集一律不合法', () => {
  assert.equal(deliverableFile({kind: 'wall-demolition', scheme: 'a', seq: 2}), 'output/doc/wall-demolition/a-002.svg');
  assert.throws(() => deliverableFile({kind: 'nope', scheme: 'a', seq: 1}), /未知图种/);
  assert.throws(() => deliverableFile({kind: 'wall-demolition', scheme: '../x', seq: 1}), /方案 id/);
  assert.throws(() => deliverableFile({kind: 'wall-demolition', scheme: 'a', seq: 0}), /正整数/);
  assert.equal(docManifestFile(), 'output/doc/manifest.json');
  assert.equal(docKey({kind: 'wall-demolition', scheme: 'a', seq: 1}), 'wall-demolition:a:1');

  const inputs = inputChain({
    dataset: {id: 'd1', file: 'data/datasets/d1/dataset.json', sha256: sha('1')},
    design: {scheme: 'a', seq: 1, file: 'data/designs/a/versions/001.json', sha256: sha('2'), status: 'confirmed'},
    model: {file: 'data/datasets/d1/model.json', sha256: sha('3')},
    confirmations: [{object: 'ground', field: 'clearHeight', value: 2750, basis: '图纸'}],
    params: {scale: 100}
  });
  const doc = deliverable({
    kind: 'wall-demolition',
    title: '拆改图',
    file: 'output/doc/wall-demolition/a-001.svg',
    sha256: sha('a'),
    bytes: 1024,
    generator: {id: 'doc.wall-demolition', version: '1.0.0'},
    inputs,
    generatedAt: '2026-11-25T00:00:00.000Z'
  });
  assert.deepEqual(validateDeliverable(doc), []);

  assert.match(validateDeliverable({...doc, sha256: 'short'}).join(), /产物哈希/);
  assert.match(validateDeliverable({...doc, status: 'weird'}).join(), /状态/);
  assert.match(validateDeliverable({...doc, inputs: {dataset: {id: 'd1'}}}).join(), /设计版本/);
  assert.match(validateDeliverable({...doc, inputs: {design: {scheme: 'a', seq: 1}}}).join(), /数据集/);
});

test('交付清单：逐条校验，key 由图种与设计版本决定', () => {
  const doc = deliverable({
    kind: 'wall-demolition',
    title: '拆改图',
    file: 'output/doc/wall-demolition/a-001.svg',
    sha256: sha('b'),
    bytes: 10,
    generator: {id: 'doc.wall-demolition', version: '1.0.0'},
    inputs: inputChain({dataset: {id: 'd1', sha256: sha('1')}, design: {scheme: 'a', seq: 1, sha256: sha('2')}}),
    generatedAt: '2026-11-25T00:00:00.000Z'
  });
  const value = upsertDoc(manifest({}), doc, {at: '2026-11-25T00:00:00.000Z'});
  assert.deepEqual(validateManifest(value), []);
  assert.ok(value.docs['wall-demolition:a:1']);
  assert.deepEqual(existingDoc(value, {kind: 'wall-demolition', scheme: 'a', seq: 1})?.sha256, doc.sha256);
  assert.equal(existingDoc(value, {kind: 'wall-demolition', scheme: 'a', seq: 2}), null);
  assert.throws(() => upsertDoc(manifest({}), {...doc, sha256: 'x'}), /不合法/);
  assert.match(validateManifest({schema: 'space-doc-manifest/v1', docs: {k: {}}}).join(), /k: /);
  assert.match(validateManifest(null).join(), /必须是对象/);
});

test('失效判定：设计版本、数据集、模型或确认值变化都标待复核，不覆盖产物', () => {
  const inputs = inputChain({
    dataset: {id: 'd1', sha256: sha('1')},
    design: {scheme: 'a', seq: 1, sha256: sha('2'), status: 'confirmed'},
    model: {file: 'data/datasets/d1/model.json', sha256: sha('3')},
    confirmations: [{object: 'ground', field: 'clearHeight', value: 2750}]
  });
  const record = {...deliverable({kind: 'wall-demolition', title: 't', file: 'f', sha256: sha('a'), bytes: 1, generator: {}, inputs}), inputs};
  // 输入没变 → 状态不变
  assert.deepEqual(staleReasonOf(record, {design: {sha256: sha('2'), status: 'confirmed'}}), []);
  assert.equal(withStaleness(record, {design: {sha256: sha('2'), status: 'confirmed'}}).status, 'generated');

  // 设计版本文件变了
  const changed = staleReasonOf(record, {design: {sha256: sha('9'), status: 'confirmed'}});
  assert.match(changed.join(' '), /设计版本文件已变化/);
  // 设计版本被标待复核
  assert.match(staleReasonOf(record, {design: {sha256: sha('2'), status: 'stale'}}).join(), /待复核/);
  // 数据集与模型变化
  assert.match(staleReasonOf(record, {dataset: {sha256: sha('7')}}).join(), /数据集文件已变化/);
  assert.match(staleReasonOf(record, {model: {sha256: sha('8')}}).join(), /空间模型已变化/);
  // 确认值被改或消失
  assert.match(staleReasonOf(record, {confirmations: [{object: 'ground', field: 'clearHeight', value: 2800}]}).join(), /确认值已变/);
  assert.match(staleReasonOf(record, {confirmations: []}).join(), /确认记录已不存在/);

  const stale = withStaleness(record, {design: {sha256: sha('9'), status: 'confirmed'}});
  assert.equal(stale.status, 'stale');
  assert.match(stale.staleReason, /设计版本文件已变化/);
  assert.equal(stale.sha256, record.sha256, '标待复核不改产物哈希');
  assert.equal(stale.file, record.file);

  // 输入恢复一致后可以回到 generated
  assert.equal(withStaleness(stale, {design: {sha256: sha('2'), status: 'confirmed'}}).status, 'generated');
});

test('清单摘要与哈希可比性', () => {
  const mk = (kind, seq, status) => deliverable({
    kind, title: kind, file: `output/doc/${kind}/a-00${seq}.svg`, sha256: sha(String(seq)), bytes: 1,
    generator: {id: `doc.${kind}`, version: '1.0.0'},
    inputs: inputChain({dataset: {id: 'd1'}, design: {scheme: 'a', seq, status: 'confirmed'}}),
    status
  });
  const value = manifest({docs: {
    'wall-demolition:a:1': mk('wall-demolition', 1, 'generated'),
    'wall-demolition:a:2': mk('wall-demolition', 2, 'stale')
  }});
  const summary = summarizeManifest(value);
  assert.equal(summary.total, 2);
  assert.equal(summary.stale, 1);
  assert.deepEqual(summary.byKind['wall-demolition'], {total: 2, stale: 1});
  assert.deepEqual(summary.kinds, ['wall-demolition']);

  assert.deepEqual(sameBytes(null, sha('1')), {comparable: false, stable: null});
  assert.deepEqual(sameBytes(mk('wall-demolition', 1, 'generated'), sha('1')), {comparable: true, stable: true});
  assert.deepEqual(sameBytes(mk('wall-demolition', 1, 'generated'), sha('2')), {comparable: true, stable: false});
});
