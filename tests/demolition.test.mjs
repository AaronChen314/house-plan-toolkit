import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {KIND_LAYERS, LAYERS, validateSheetSpec} from '../src/contracts/documents.mjs';
import {DEFAULT_WALL_THICKNESS_MM, DIMENSION_OFFSET_MM, classifyWalls, demolitionSpec, demolitionStats} from '../src/domain/demolition.mjs';

// 用例里搭最小模型：墙体默认写模型契约形状 {polygon:{outer, holes}}，个别用例再换写法。
const ring = (x1, y1, x2, y2) => ({
  outer: [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]],
  holes: []
});
const wall = (x1, y1, x2, y2, over = {}) => ({polygon: ring(x1, y1, x2, y2), ...over});
const floor = (id, over = {}) => ({id, name: id, elevation: 0, clearHeight: 2900, walls: [], doors: [], windowOpenings: [], ...over});
const model = (floors = []) => ({schema: 'space-model/v1', units: 'mm', projectId: 'demolition-test', name: '拆改用例', floors});

const classes = (result) => result.walls.map(w => w.class);

test('墙体分类优先级：demolition 先于 new，其次 new 的三种写法，其余保留', () => {
  const data = model([floor('f1', {
    walls: [
      wall(0, 0, 1000, 200, {demolition: true, new: true}),
      wall(0, 300, 1000, 500, {demolition: true, built: false}),
      wall(0, 600, 1000, 800, {demolition: true, status: 'new'}),
      wall(0, 900, 1000, 1100, {built: false}),
      wall(0, 1200, 1000, 1400, {status: 'new'}),
      wall(0, 1500, 1000, 1700, {new: true}),
      wall(0, 1800, 1000, 2000, {structure: 'load-bearing'}),
      wall(0, 2100, 1000, 2300)
    ]
  })]);
  assert.deepEqual(classes(classifyWalls(data)), ['demolish', 'demolish', 'demolish', 'new', 'new', 'new', 'existing', 'existing']);
  // 承重只影响程序检查，不改变拆改分类。
  assert.equal(classifyWalls(data).walls[6].class, 'existing');
});

test('多楼层：顺序按 floors 原序，可只取一层，未知楼层返回空结果', () => {
  const data = model([
    floor('ground', {walls: [wall(0, 0, 3000, 200), wall(0, 200, 3000, 400, {demolition: true})]}),
    floor('upper', {walls: [wall(0, 0, 3000, 200, {new: true})]})
  ]);

  const all = classifyWalls(data);
  assert.deepEqual(all.floorIds, ['ground', 'upper']);
  assert.deepEqual(all.walls.map(w => w.handle), ['ground:walls:0', 'ground:walls:1', 'upper:walls:0']);
  assert.deepEqual(classes(all), ['existing', 'demolish', 'new']);

  const only = classifyWalls(data, {floor: 'upper'});
  assert.deepEqual(only.floorIds, ['upper']);
  assert.deepEqual(classes(only), ['new']);

  const missing = classifyWalls(data, {floor: 'roof'});
  assert.deepEqual(missing.walls, []);
  assert.deepEqual(missing.floorIds, []);
  assert.match(missing.notes.join('；'), /未找到楼层 roof/);
});

test('厚度与轮廓：缺省 200，显式值保留，handle 取自模型，裸环写法同样识别', () => {
  const data = model([floor('f1', {
    walls: [
      wall(0, 0, 1000, 200),
      wall(0, 300, 1000, 500, {thicknessMm: 240}),
      {handle: 'W-9', polygon: ring(0, 600, 1000, 800), thicknessMm: 120},
      // 示例模型的实际形状：墙本身就是多边形，没有 polygon 包裹。
      {outer: [[0, 900], [1000, 900], [1000, 1100], [0, 1100], [0, 900]], holes: [], thicknessMm: 100}
    ]
  })]);

  const result = classifyWalls(data);
  assert.equal(result.walls.length, 4, '两种写法都要认，不能整份跳过');
  assert.equal(result.walls[0].thicknessMm, DEFAULT_WALL_THICKNESS_MM);
  assert.equal(result.walls[1].thicknessMm, 240);
  assert.equal(result.walls[2].handle, 'W-9');
  assert.equal(result.walls[3].thicknessMm, 100);
  assert.deepEqual(result.walls[0].points, [[0, 0], [1000, 0], [1000, 200], [0, 200], [0, 0]]);
  assert.match(result.notes.join('；'), /1 面墙未给厚度，按 200 毫米处理/);
  // 轮廓是拷贝，不把模型里的数组直接交出去。
  assert.notEqual(result.walls[0].points, data.floors[0].walls[0].polygon.outer);
});

test('门窗分类：inserted/status 判新开，其余保留；门缺轮廓时退化为洞口线', () => {
  const data = model([floor('f1', {
    walls: [wall(0, 0, 4000, 200)],
    doors: [
      {id: 'door-new', kind: 'door', inserted: true, hinge: [1000, 200], closedEnd: [1900, 200]},
      {id: 'door-status', kind: 'door', status: 'new', hinge: [2000, 200], closedEnd: [2900, 200]},
      {id: 'door-keep', kind: 'door', hinge: [3000, 200], closedEnd: [3900, 200]}
    ],
    windowOpenings: [
      {id: 'win-new', kind: 'window', inserted: true, footprint: ring(1000, 0, 1900, 200)},
      {id: 'win-keep', kind: 'window', footprint: ring(2000, 0, 2900, 200)}
    ]
  })]);

  const result = classifyWalls(data);
  assert.deepEqual(result.openings.map(o => [o.handle, o.kind, o.class]), [
    ['door-new', 'door', 'new'],
    ['door-status', 'door', 'new'],
    ['door-keep', 'door', 'existing'],
    ['win-new', 'window', 'new'],
    ['win-keep', 'window', 'existing']
  ]);
  assert.deepEqual(result.openings[2].points, [[3000, 200], [3900, 200]], '门只有铰链与关闭端时画洞口线');
  assert.deepEqual(result.openings[4].points, ring(2000, 0, 2900, 200).outer, '窗有 footprint 时取外环');
  assert.equal(result.notes.filter(n => /跳过/.test(n)).length, 0, '门窗都有轮廓');
});

test('缺少 walls 字段、空模型、非对象输入都不报错', () => {
  const noWalls = classifyWalls(model([{id: 'f1'}]));
  assert.deepEqual(noWalls.walls, []);
  assert.deepEqual(noWalls.openings, []);
  assert.deepEqual(noWalls.floorIds, ['f1']);
  assert.deepEqual(noWalls.notes, []);

  for (const empty of [{}, {floors: []}, {floors: [null]}, undefined]) {
    const result = classifyWalls(empty);
    assert.deepEqual(result.walls, []);
    assert.deepEqual(result.openings, []);
    assert.deepEqual(result.floorIds, []);
  }
  assert.deepEqual(demolitionStats(classifyWalls(undefined)), {existing: 0, demolish: 0, new: 0, openings: 0});
});

test('确定性：同一输入两次调用深相等，且不改动输入', () => {
  const data = model([
    floor('ground', {
      walls: [wall(0, 0, 3000, 200, {demolition: true}), wall(0, 200, 3000, 400, {status: 'new'})],
      doors: [{id: 'd1', kind: 'door', inserted: true, hinge: [1000, 200], closedEnd: [1900, 200]}],
      windowOpenings: [{id: 'w1', kind: 'window', footprint: ring(0, 0, 900, 200)}]
    }),
    floor('upper', {walls: [wall(0, 0, 3000, 200)]})
  ]);
  const snapshot = structuredClone(data);

  assert.deepEqual(classifyWalls(data), classifyWalls(data));
  assert.deepEqual(demolitionSpec(data, {title: '拆改图'}), demolitionSpec(data, {title: '拆改图'}));
  assert.deepEqual(data, snapshot, '纯函数不改输入');
});

test('统计：保留/拆除/新建与门窗计数', () => {
  const data = model([floor('f1', {
    walls: [
      wall(0, 0, 1000, 200),
      wall(0, 300, 1000, 500),
      wall(0, 600, 1000, 800, {demolition: true}),
      wall(0, 900, 1000, 1100, {new: true})
    ],
    doors: [{id: 'd1', kind: 'door', hinge: [0, 0], closedEnd: [900, 0]}],
    windowOpenings: [{id: 'w1', kind: 'window', footprint: ring(0, 0, 900, 200), inserted: true}]
  })]);
  assert.deepEqual(demolitionStats(classifyWalls(data)), {existing: 2, demolish: 1, new: 1, openings: 2});
});

test('拆改图面数据：通过契约校验，图层只用该图种允许的，每面墙有轮廓/标注/文字', () => {
  const data = model([floor('f1', {
    walls: [
      wall(0, 0, 3000, 200, {handle: 'W1'}),
      wall(0, 200, 3000, 400, {demolition: true, thicknessMm: 240}),
      wall(0, 400, 3000, 600, {new: true})
    ],
    doors: [{id: 'd1', kind: 'door', hinge: [1000, 200], closedEnd: [1900, 200]}],
    windowOpenings: [{id: 'w1', kind: 'window', footprint: ring(0, 0, 900, 200)}]
  })]);

  const spec = demolitionSpec(data, {title: '拆改图 · 首层', scale: 50, notes: ['现场复核后再拆']});
  assert.deepEqual(validateSheetSpec(spec), [], '图面数据必须能过契约校验');
  assert.equal(spec.kind, 'wall-demolition');
  assert.equal(spec.title, '拆改图 · 首层');
  assert.equal(spec.scale, 50);
  assert.deepEqual(spec.layerOrder, KIND_LAYERS['wall-demolition']);

  const allowed = new Set(KIND_LAYERS['wall-demolition']);
  for (const item of spec.items) {
    assert.ok(allowed.has(item.layer), `图层不在规范里：${item.layer}`);
    assert.ok(LAYERS[item.layer], `图层未登记：${item.layer}`);
  }

  const count = (layer, kind) => spec.items.filter(i => i.layer === layer && i.kind === kind).length;
  assert.equal(count('wall-existing', 'polyline'), 1);
  assert.equal(count('wall-demolish', 'polyline'), 1);
  assert.equal(count('wall-new', 'polyline'), 1);
  assert.equal(count('opening', 'polyline'), 2);
  assert.equal(count('dimension', 'dimension'), 3, '每面墙一条尺寸标注');
  assert.equal(count('note', 'text'), 3, '每面墙一条文字说明');
  assert.equal(spec.items.length, 3 * 3 + 2);

  const dimensions = spec.items.filter(i => i.kind === 'dimension');
  for (const dim of dimensions) assert.equal(dim.offset, DIMENSION_OFFSET_MM);
  const demolishDim = dimensions[1];
  assert.deepEqual(demolishDim.from, [0, 200]);
  assert.deepEqual(demolishDim.to, [3000, 400]);
  const notes = spec.items.filter(i => i.layer === 'note').map(i => i.text);
  assert.deepEqual(notes, ['保留 200 厚', '拆除 240 厚', '新建 200 厚']);
  const noteAt = spec.items.find(i => i.layer === 'note').at;
  assert.ok(Math.abs(noteAt[0] - 1500) < 1e-6 && Math.abs(noteAt[1] - 100) < 1e-6, '文字落在墙质心');

  assert.ok(spec.notes.includes('现场复核后再拆'));
  assert.ok(spec.notes.includes('保留 1 · 拆除 1 · 新建 1'));
  assert.ok(spec.notes.includes('门窗洞口 2 处'));
  assert.deepEqual(spec.meta.floorIds, ['f1']);
  assert.deepEqual(spec.meta.stats, {existing: 1, demolish: 1, new: 1, openings: 2});
});

test('拆改图面数据：空模型也能过校验，说明里统计为 0', () => {
  const spec = demolitionSpec({});
  assert.deepEqual(validateSheetSpec(spec), []);
  assert.deepEqual(spec.items, []);
  assert.equal(spec.title, '拆改图');
  assert.equal(spec.scale, 100);
  assert.ok(spec.notes.includes('保留 0 · 拆除 0 · 新建 0'));
  assert.ok(spec.notes.includes('门窗洞口 0 处'));
});

test('合成示例模型（裸环墙体）能出图，不被整份跳过', () => {
  const file = fileURLToPath(new URL('../examples/two-level/data/model.json', import.meta.url));
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = classifyWalls(data);
  assert.deepEqual(result.floorIds, data.floors.map(f => f.id));
  assert.ok(result.walls.length >= data.floors.length, '每层至少有一面墙被识别');
  assert.ok(result.walls.every(w => w.points.length >= 3 && w.thicknessMm === DEFAULT_WALL_THICKNESS_MM));
  assert.ok(result.openings.length >= data.floors.length, '门按铰链与关闭端画洞口线');
  const spec = demolitionSpec(data, {title: '示例拆改图'});
  assert.deepEqual(validateSheetSpec(spec), []);
  assert.deepEqual(spec, demolitionSpec(data, {title: '示例拆改图'}));
});
