import test from 'node:test';
import assert from 'node:assert/strict';
import {SCHEMA, componentsDoc, validateComponents, summarize, fromLegacy, kindOrder, kindLabel, kindColor} from '../src/contracts/components.mjs';

test('类别由数据定义：文档里没有 kinds，就不许有标注', () => {
  const doc = componentsDoc({sourceSha256: 'x'});
  doc.assignments = {A1: {kind: 'wall'}};
  const problems = validateComponents(doc);
  assert.ok(problems.some(p => p.includes('kinds 是空的')), '不能靠脚本里内置类别表兜底');
});

test('校验：类别未声明、缺 label、颜色格式、id 不存在都要报', () => {
  const doc = componentsDoc({sourceSha256: 'x', kinds: {
    wall: {label: '墙'},
    bad: {color: 'red'},
    door: {label: '门', color: '#bf1670', group: 'auxiliary'}
  }});
  doc.assignments = {A1: {kind: 'wall'}, A2: {kind: 'window'}, A3: {kind: 'door', confidence: 2}};
  const problems = validateComponents(doc, {entityIds: ['A1', 'A3']});
  assert.ok(problems.some(p => p.includes('kinds.bad: 缺 label')));
  assert.ok(problems.some(p => p.includes('color 必须是 #rrggbb')));
  assert.ok(problems.some(p => p.includes('kinds 里没有 window')));
  assert.ok(problems.some(p => p.includes('A2') && p.includes('没有这个 id')));
  assert.ok(problems.some(p => p.includes('confidence')));
});

test('geometry 是几何用法提示：只认 ring / open / span，写错要报', () => {
  const doc = componentsDoc({kinds: {
    wall: {label: '墙', geometry: 'open'},
    pier: {label: '柱', geometry: 'ring'},
    floor: {label: '地面', geometry: 'area'},
    odd: {label: '怪', geometry: 'closed'}
  }});
  const problems = validateComponents(doc);
  assert.ok(problems.some(p => p.includes('kinds.odd') && p.includes('geometry')), '未知 geometry 值要报');
  assert.ok(!problems.some(p => p.includes('kinds.wall')), '合法值不该报');
});

test('旧标注（kind → sourceIds）转成数据定义的 kinds + 标注', () => {
  const legacy = {
    wall: {label: '实体墙', color: '#65409a', basis: '双线加粗', sourceIds: ['A1', 'A2', 'MISSING']},
    note: {label: '注记', sourceIds: ['A3']}
  };
  const {kinds, assignments, skipped} = fromLegacy(legacy, {entityIds: ['A1', 'A2', 'A3']});
  assert.equal(kinds.wall.label, '实体墙');
  assert.equal(kinds.wall.color, '#65409a');
  assert.equal(assignments.A1.kind, 'wall');
  assert.equal(assignments.A1.basis, '双线加粗');
  assert.equal(assignments.A3.provenance, 'import');
  assert.ok(skipped.some(s => s.id === 'MISSING'), '缺失 id 必须报告');
});

test('显示顺序与取值：构件在前、辅助在后，未声明回退原键名', () => {
  const doc = componentsDoc({kinds: {
    wall: {label: '墙', group: 'structural', color: '#111111'},
    annotation: {label: '标注', group: 'auxiliary'},
    other: {label: '其他'}
  }, assignments: {A: {kind: 'wall'}, B: {kind: 'wall'}, C: {kind: 'annotation'}}});
  assert.deepEqual(kindOrder(doc), ['wall', 'other', 'annotation']);
  assert.deepEqual(summarize(doc), {wall: 2, annotation: 1});
  assert.equal(kindLabel(doc, 'wall'), '墙');
  assert.equal(kindLabel(doc, 'nope'), 'nope');
  assert.equal(kindColor(doc, 'annotation'), '#7d8f86');
});
