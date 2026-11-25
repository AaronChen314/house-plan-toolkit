import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHECK_RULES, MIN_CORRIDOR_CLEAR_MM, MIN_DOOR_CLEAR_MM, MIN_WINDOW_CLEAR_MM,
  checkCirculation, checkDemolition, checkOpenings, distanceToRing, segmentDistance, summarizeChecks
} from '../src/domain/checks.mjs';
import {validateCapability} from '../src/contracts/capability.mjs';
import {capabilities as programCapabilities} from '../src/capabilities/program.mjs';

// 内存里搭最小模型：不合法的部分由各用例显式传入，避免默认值带来的误报。
const poly = (x1, y1, x2, y2) => ({outer: [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]], holes: []});

function model({walls = [], columns = [], doors = [], windows = [], furniture = [], walkEntries = []} = {}) {
  return {
    schema: 'space-model/v1',
    units: 'mm',
    projectId: 'checks-test',
    name: '拆改检查用例',
    floors: [{
      id: 'f1', name: '首层', elevation: 0, clearHeight: 2900,
      slab: [poly(0, 0, 8000, 6000)],
      walls, columns, doors, windowOpenings: windows, furniture, walkEntries
    }]
  };
}

const door = (over = {}) => ({
  id: 'd1', kind: 'door', label: '室内门',
  hinge: [3000, 1200], closedEnd: [4000, 1200], openEnd: [3000, 2200],
  heightMm: 2100, thicknessMm: 40, heightFrom: 'preview', ...over
});

const chair = (over = {}) => ({
  id: 'chair', kind: 'chair', label: '椅子',
  footprint: [poly(6000, 4500, 7000, 5500)],
  heightMm: 800, heightFrom: 'preview', ...over
});

const codes = (result) => result.issues.map(i => i.code);
const issued = (result, code) => result.issues.filter(i => i.code === code);

test('拆改：承重墙被标拆是 error', () => {
  const data = model({walls: [poly(0, 0, 8000, 200), {...poly(0, 5000, 4000, 5200), demolition: true, structure: 'load-bearing'}]});
  const result = checkDemolition(data);
  assert.equal(result.passed, false);
  assert.deepEqual(codes(result), ['demolition-bearing-wall']);
  assert.equal(result.issues[0].severity, 'error');
  assert.equal(result.issues[0].object, 'f1:walls:1');
  assert.match(result.issues[0].message, /承重/);
});

test('拆改：非承重墙无依据是 warning，补依据后不再提示', () => {
  const bare = checkDemolition(model({walls: [{...poly(0, 5000, 4000, 5200), demolition: true}]}));
  assert.equal(bare.passed, true, 'warning 不判失败');
  assert.deepEqual(codes(bare), ['demolition-no-basis']);
  assert.equal(bare.issues[0].severity, 'warning');

  const documented = checkDemolition(model({walls: [{...poly(0, 5000, 4000, 5200), demolition: true, basis: '现场复核：轻质隔墙'}]}));
  assert.deepEqual(documented, {passed: true, issues: []});

  const surveyed = checkDemolition(model({walls: [{...poly(0, 5000, 4000, 5200), demolition: true, surveyNote: '原图标注为非承重'}]}));
  assert.deepEqual(surveyed.issues, []);
});

test('净空：门洞 700 是 error，900 通过', () => {
  const narrow = checkOpenings(model({doors: [door({hinge: [3000, 1200], closedEnd: [3700, 1200], openEnd: [3000, 1900]})]}));
  assert.equal(narrow.passed, false);
  assert.deepEqual(codes(narrow), ['door-too-narrow']);
  assert.equal(narrow.issues[0].severity, 'error');
  assert.equal(narrow.issues[0].object, 'f1:d1');
  assert.match(narrow.issues[0].message, /700 mm/);

  const wide = checkOpenings(model({doors: [door({hinge: [3000, 1200], closedEnd: [3900, 1200], openEnd: [3000, 2100]})]}));
  assert.deepEqual(wide, {passed: true, issues: []});
});

test('净空：显式宽度字段优先，兼容 widthMm / openingWidthMm', () => {
  const result = checkOpenings(model({doors: [door({widthMm: 750})], windows: [door({id: 'w1', kind: 'window', openingWidthMm: 500})]}));
  assert.deepEqual(codes(result), ['door-too-narrow', 'window-too-narrow']);
  assert.equal(result.passed, false, '门洞窄是 error');
});

test('净空：窗洞 500 是 warning', () => {
  const win = {id: 'w1', kind: 'window', label: '卫生间窗', footprint: poly(5000, 0, 5500, 200), sillMm: 900, headMm: 2100, heightFrom: 'preview'};
  const result = checkOpenings(model({windows: [win]}));
  assert.equal(result.passed, true);
  assert.deepEqual(codes(result), ['window-too-narrow']);
  assert.equal(result.issues[0].severity, 'warning');
});

test('净空：门扇开启区被家具挡住是 error', () => {
  const data = model({
    doors: [door({hinge: [3000, 0], closedEnd: [4000, 0], openEnd: [3000, 1000]})],
    furniture: [chair({footprint: [poly(3300, 200, 3800, 700)]})]
  });
  const result = checkOpenings(data);
  assert.equal(result.passed, false);
  assert.deepEqual(codes(result), ['door-swing-blocked']);
  assert.equal(result.issues[0].object, 'f1:d1');
  assert.match(result.issues[0].message, /椅子/);
});

test('净空：家具在开启区外不误报', () => {
  const data = model({
    doors: [door({hinge: [3000, 0], closedEnd: [4000, 0], openEnd: [3000, 1000]})],
    furniture: [chair({footprint: [poly(4200, 400, 4800, 1000)]})]
  });
  assert.deepEqual(checkOpenings(data), {passed: true, issues: []});
});

test('动线：入口贴墙 500 是 warning，1500 通过', () => {
  const near = checkCirculation(model({walls: [poly(0, 0, 8000, 200)], walkEntries: [{name: '客厅入口', point: [4000, 700]}]}));
  assert.equal(near.passed, true);
  assert.deepEqual(codes(near), ['corridor-too-narrow']);
  assert.equal(near.issues[0].object, 'f1:客厅入口');
  assert.match(near.issues[0].message, /500 mm/);

  const far = checkCirculation(model({walls: [poly(0, 0, 8000, 200)], walkEntries: [{name: '客厅入口', point: [4000, 1700]}]}));
  assert.deepEqual(far, {passed: true, issues: []});
});

test('动线：柱体也计入最近距离', () => {
  const result = checkCirculation(model({columns: [poly(500, 500, 800, 800)], walkEntries: [{name: '过道', point: [1600, 650]}]}));
  assert.deepEqual(codes(result), ['corridor-too-narrow']);
  assert.match(result.issues[0].message, /800 mm/);
});

test('几何工具：点到线段距离在端点外退化', () => {
  assert.equal(segmentDistance([5, 3], [0, 0], [10, 0]), 3);
  assert.equal(segmentDistance([-4, 3], [0, 0], [10, 0]), 5);
  assert.equal(segmentDistance([5, 5], [2, 2], [2, 2]), Math.hypot(3, 3));
  assert.equal(distanceToRing([0, 0], [[0, 0], [10, 0], [10, 10], [0, 10]]), 0, '落在轮廓上记 0');
  assert.equal(distanceToRing([5, 5], [[0, 0], [10, 0], [10, 10], [0, 10]]), 0, '落在多边形内记 0');
  assert.equal(distanceToRing([15, 5], [[0, 0], [10, 0], [10, 10], [0, 10]]), 5);
});

test('干净模型：三类检查全部通过且不误报', () => {
  const data = model({
    walls: [poly(0, 0, 8000, 200), poly(0, 5800, 8000, 6000)],
    columns: [poly(500, 500, 800, 800)],
    doors: [door()],
    windows: [{id: 'w1', kind: 'window', footprint: poly(5000, 0, 6200, 200), sillMm: 900, headMm: 2100, heightFrom: 'preview'}],
    furniture: [chair()],
    walkEntries: [{name: '客厅入口', point: [4000, 2000]}]
  });
  const results = {demolition: checkDemolition(data), openings: checkOpenings(data), circulation: checkCirculation(data)};
  for (const rule of CHECK_RULES) {
    assert.deepEqual(results[rule], {passed: true, issues: []}, `${rule} 不应误报`);
  }
  const merged = summarizeChecks(results);
  assert.equal(merged.passed, true);
  assert.deepEqual(merged.issues, []);
  assert.deepEqual(merged.byRule, {demolition: {errors: 0, warnings: 0}, openings: {errors: 0, warnings: 0}, circulation: {errors: 0, warnings: 0}});
});

test('summarizeChecks：合并结果并统计 byRule', () => {
  const results = {
    demolition: checkDemolition(model({walls: [{...poly(0, 0, 1000, 200), demolition: true, structure: 'load-bearing'}]})),
    openings: checkOpenings(model({doors: [door({widthMm: 700})], windows: [{id: 'w1', kind: 'window', widthMm: 500}]})),
    circulation: checkCirculation(model({walls: [poly(0, 0, 8000, 200)], walkEntries: [{name: 'a', point: [4000, 500]}]}))
  };
  const merged = summarizeChecks(results);
  assert.equal(merged.passed, false);
  assert.equal(merged.issues.length, 4);
  assert.deepEqual(merged.byRule, {
    demolition: {errors: 1, warnings: 0},
    openings: {errors: 1, warnings: 1},
    circulation: {errors: 0, warnings: 1}
  });
  // 只有 warning 时判通过
  const warnOnly = summarizeChecks({circulation: results.circulation});
  assert.equal(warnOnly.passed, true);
  assert.deepEqual(warnOnly.byRule, {circulation: {errors: 0, warnings: 1}});
  // 也接受带 rule 字段的数组
  const asArray = summarizeChecks([{rule: 'openings', ...results.openings}]);
  assert.deepEqual(asArray.byRule, {openings: {errors: 1, warnings: 1}});
});

test('program.check：契约合法、只读', () => {
  assert.equal(programCapabilities.length, 1);
  const cap = programCapabilities[0];
  assert.deepEqual(validateCapability(cap), []);
  assert.equal(cap.id, 'program.check');
  assert.equal(cap.stage, 'data');
  assert.deepEqual(cap.sideEffects, ['none']);
  assert.deepEqual(cap.inputs, {model: 'space-model/v1'});
  assert.deepEqual(cap.outputs, {});
  assert.deepEqual(cap.requires, []);
  assert.equal(cap.idempotent, true);
});

// 最小合法模型：能被 loadProject 读入并通过 validateModel。
function projectDir(modelData) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'program-check-'));
  fs.mkdirSync(path.join(dir, 'data'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    schema: 'space-project/v1', id: 'tmp-check', name: '临时检查项目', model: 'data/model.json', output: 'output'
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'data/model.json'), JSON.stringify(modelData, null, 2));
  return {dir, file: path.join(dir, 'project.json')};
}

const ctxOf = (file) => ({file, dir: path.dirname(file), project: null, logs: [], log() {}, store: null});

test('program.check：返回 passed 与 byRule', async () => {
  const cap = programCapabilities[0];
  const dirty = model({
    walls: [{...poly(0, 0, 8000, 200), demolition: true, structure: 'load-bearing'}],
    doors: [door()],
    walkEntries: [{name: '客厅入口', point: [4000, 2000]}]
  });
  const a = projectDir(dirty);
  const result = await cap.run(ctxOf(a.file));
  assert.equal(result.data.passed, false);
  assert.ok(result.data.byRule.demolition.errors >= 1);
  assert.ok(result.data.byRule.openings && result.data.byRule.circulation && result.data.byRule.model);
  assert.deepEqual(result.outputs, []);
  assert.ok(result.data.issues.some(i => i.code === 'demolition-bearing-wall'));
  assert.match(result.summary, /错误/);

  const clean = model({
    walls: [poly(0, 0, 8000, 200)],
    doors: [door()],
    walkEntries: [{name: '客厅入口', point: [4000, 2000]}]
  });
  const b = projectDir(clean);
  const ok = await cap.run(ctxOf(b.file));
  assert.equal(ok.data.passed, true);
  assert.deepEqual(ok.data.issues, []);
  assert.deepEqual(ok.data.byRule.demolition, {errors: 0, warnings: 0});
  assert.match(ok.summary, /通过/);
});

test('program.check：数据读不到时给可读结论而不是静默', async () => {
  const cap = programCapabilities[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'program-check-missing-'));
  const file = path.join(dir, 'project.json');
  fs.writeFileSync(file, JSON.stringify({schema: 'space-project/v1', id: 'tmp-check', name: '临时', model: null}));
  const broken = await cap.run(ctxOf(file));
  assert.equal(broken.data.passed, false);
  assert.equal(broken.data.issues[0].code, 'model-unreadable');
  assert.match(broken.summary, /无法读取空间数据/);

  const missing = await cap.run(ctxOf(path.join(dir, 'nope.json')));
  assert.equal(missing.data.passed, false);
  assert.match(missing.summary, /无法读取空间数据/);
});
