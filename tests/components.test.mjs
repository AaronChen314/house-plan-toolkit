import test from 'node:test';
import assert from 'node:assert/strict';
import {COMPONENTS, SCHEMA, componentsDoc, validateComponents, summarize, fromLegacy, STRUCTURAL_KEYS} from '../src/contracts/components.mjs';

test('构件类别表：构件与辅助分开，颜色与标签齐全', () => {
  for (const k of STRUCTURAL_KEYS) {
    assert.ok(COMPONENTS[k], `${k} 必须在构件类别表里`);
    assert.match(COMPONENTS[k].label, /[\u4e00-\u9fa5]/, `${k} 的标签要是中文`);
    assert.match(COMPONENTS[k].color, /^#[0-9a-f]{6}$/i);
    assert.ok(COMPONENTS[k].basis, `${k} 要写判定依据`);
  }
  assert.ok(!STRUCTURAL_KEYS.includes('annotation'), '标注不算构件');
});

test('校验：未知类别、图元不存在、越界置信度都要报', () => {
  const doc = componentsDoc({sourceSha256: 'abc'});
  doc.assignments = {
    A1: {kind: 'wall', provenance: 'import'},
    A2: {kind: 'spaceship'},
    A3: {kind: 'beam', confidence: 1.4},
    A4: {kind: 'door', provenance: 'guess'}
  };
  const problems = validateComponents(doc, {entityIds: ['A1', 'A3', 'A4', 'A5']});
  assert.ok(problems.some(p => p.includes('未知构件类别')));
  assert.ok(problems.some(p => p.includes('A2') && p.includes('没有这个 id')));
  assert.ok(problems.some(p => p.includes('confidence')));
  assert.ok(problems.some(p => p.includes('provenance')));
});

test('旧标注（kind → sourceIds）能转成新契约，且不静默丢 id', () => {
  const legacy = {
    wall: {label: '实体墙', sourceIds: ['A1', 'A2', 'MISSING']},
    beam: {label: '梁', sourceIds: ['A3']},
    landing: {label: '平台', sourceIds: ['A4']}
  };
  const {assignments, skipped} = fromLegacy(legacy, {entityIds: ['A1', 'A2', 'A3']});
  assert.equal(assignments.A1.kind, 'wall');
  assert.equal(assignments.A3.provenance, 'import');
  assert.equal(skipped.length, 2, '缺失 id 与未知类别都要报告');
  assert.ok(skipped.some(s => s.id === 'MISSING'));
  assert.ok(skipped.some(s => s.kind === 'landing'));
});

test('统计按类别计数，未标注不计数', () => {
  const doc = {schema: SCHEMA, assignments: {A: {kind: 'wall'}, B: {kind: 'wall'}, C: {kind: 'door'}}};
  assert.deepEqual(summarize(doc), {wall: 2, door: 1});
});
