import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAD_CATEGORIES, CATEGORY_KEYS, ACI_RGB, LAYER_PATTERNS,
  classifyEntity, categoryForLayer, categoriesForAci, categoryColor, palette,
  overrideCategories, validateCategories
} from '../src/contracts/index.mjs';

test('颜色约定表：类别齐全、配色格式正确且互不重复', () => {
  assert.deepEqual(validateCategories(), []);
  assert.deepEqual(CATEGORY_KEYS.sort(), ['axis', 'column', 'dimension', 'door', 'furniture', 'hatch', 'other', 'text', 'wall', 'window'].sort());
  for (const key of CATEGORY_KEYS) {
    const entry = CAD_CATEGORIES[key];
    assert.ok(entry.label && entry.note, `${key} 缺 label 或 note`);
    assert.match(entry.studio, /^#[0-9a-f]{6}$/i);
  }
  for (const [aci, hex] of Object.entries(ACI_RGB)) {
    assert.ok(Number(aci) >= 1 && Number(aci) <= 255);
    assert.match(hex, /^#[0-9a-f]{6}$/i);
  }
  // 反例：重复配色应被自检抓出来
  const dup = {...CAD_CATEGORIES, wall: {...CAD_CATEGORIES.wall, studio: CAD_CATEGORIES.door.studio}};
  assert.match(validateCategories(dup).join(), /同一个颜色/);
});

test('判定顺序：图层名优先，颜色只给候选', () => {
  assert.equal(categoryForLayer('WALL'), 'wall');
  assert.equal(categoryForLayer('墙体'), 'wall');
  assert.equal(categoryForLayer('A-WALL-FULL'), 'wall');
  assert.equal(categoryForLayer('门窗表'), 'door');
  assert.equal(categoryForLayer('0'), null, '图层 0 不提供语义');
  assert.equal(categoryForLayer('随便画的'), null);

  const byLayer = classifyEntity({layer: 'WINDOW', aci: 4});
  assert.equal(byLayer.category, 'window');
  assert.equal(byLayer.basis, 'layer');
  assert.ok(byLayer.confidence > 0.8, '图层名比颜色可靠');

  const byAci = classifyEntity({layer: '0', aci: 6});
  assert.equal(byAci.category, 'axis', '品红只对应轴线');
  assert.equal(byAci.basis, 'aci');
  assert.ok(byAci.confidence < 0.8, '颜色置信度必须更低');

  const yellow = classifyEntity({layer: '0', aci: 2});
  assert.equal(yellow.category, null, '黄色同时是门和文字，不能直接下结论');
  assert.deepEqual(yellow.candidates.sort(), ['door', 'text']);

  const ambiguous = classifyEntity({layer: 'x', aci: 4});
  assert.equal(ambiguous.category, null, '青色同时是窗和家具，不能直接下结论');
  assert.deepEqual(ambiguous.candidates.sort(), ['furniture', 'window']);
  assert.equal(ambiguous.basis, 'aci-ambiguous');

  assert.equal(classifyEntity({}).category, null);
  assert.deepEqual(categoriesForAci(999), []);
  assert.equal(categoryColor('door'), palette().door);
  assert.equal(categoryColor('nope'), palette().other);
});

test('项目覆盖：只改差异项，非法值被拒', () => {
  const custom = overrideCategories(CAD_CATEGORIES, {wall: {studio: '#123456'}});
  assert.equal(custom.wall.studio, '#123456');
  assert.equal(custom.door.studio, CAD_CATEGORIES.door.studio, '未覆盖的保持默认');
  assert.equal(CAD_CATEGORIES.wall.studio, '#7c3aed', '不得修改基础表');
  assert.throws(() => overrideCategories(CAD_CATEGORIES, {nope: {}}), /未知类别/);
  assert.throws(() => overrideCategories(CAD_CATEGORIES, {wall: {studio: 'red'}}), /#rrggbb/);
  assert.throws(() => overrideCategories(CAD_CATEGORIES, {wall: {aci: [0]}}), /1–255/);
});

test('图层规则有序且可读，避免互相覆盖', () => {
  assert.ok(LAYER_PATTERNS.length >= 8);
  const seen = new Set();
  for (const rule of LAYER_PATTERNS) {
    assert.ok(rule.patterns.length >= 1, `${rule.category} 没有匹配规则`);
    assert.equal(seen.has(rule.category), false, `${rule.category} 重复登记`);
    seen.add(rule.category);
  }
});
