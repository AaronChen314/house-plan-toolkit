import test from 'node:test';
import assert from 'node:assert/strict';
import {sheetSpec, SHEET_DEFAULTS} from '../src/contracts/index.mjs';
import {specBounds, drawingArea, fitScale, projectSheet, outOfFrame, MIN_TEXT_MM, TITLE_BLOCK_MM} from '../src/domain/sheet-projection.mjs';
import {renderSheet} from '../src/domain/sheet.mjs';
import {demolitionSpec} from '../src/domain/demolition.mjs';

const box = (w, h) => sheetSpec({
  kind: 'wall-demolition',
  title: '测试图',
  items: [
    {layer: 'wall-existing', kind: 'polyline', points: [[0, 0], [w, 0], [w, h], [0, h], [0, 0]]},
    {layer: 'note', kind: 'text', at: [w / 2, h / 2], text: '客厅'},
    {layer: 'dimension', kind: 'dimension', from: [0, 0], to: [w, 0], offset: -120}
  ]
});

test('图形范围：折线、文字与标注都算进去', () => {
  const b = specBounds(box(12000, 8000));
  assert.deepEqual(b, {minX: 0, minY: 0, maxX: 12000, maxY: 8000, width: 12000, height: 8000});
  assert.equal(specBounds(sheetSpec({kind: 'wall-demolition', title: 't', items: []})), null);
  const area = drawingArea({size: SHEET_DEFAULTS});
  assert.equal(area.width, SHEET_DEFAULTS.width - SHEET_DEFAULTS.margin * 2);
  assert.equal(area.height, SHEET_DEFAULTS.height - SHEET_DEFAULTS.margin * 2 - TITLE_BLOCK_MM);
});

test('比例：放得下就保持请求值，放不下就沿阶梯放大', () => {
  const area = drawingArea({size: SHEET_DEFAULTS});
  assert.equal(fitScale(100, specBounds(box(12000, 8000)), area), 100, '12m 在 1:100 下是 120mm，放得下');
  assert.equal(fitScale(100, specBounds(box(200000, 100000)), area), 250, '200m 需要 1:250（800mm 刚好放进 821mm）');
  assert.equal(fitScale(undefined, specBounds(box(12000, 8000)), area), 100, '缺省 1:100');
  assert.equal(fitScale(500, specBounds(box(12000, 8000)), area), 500, '不主动缩小用户给的比例');
});

test('投影：按比例换算并在图框内居中，文字与标注一起换算', () => {
  const spec = projectSheet(box(12000, 8000), {scale: 100});
  assert.equal(spec.scale, 100);
  const xs = spec.items[0].points.map(p => p[0]);
  const ys = spec.items[0].points.map(p => p[1]);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  assert.equal(width, 120);
  assert.equal(height, 80);
  assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - SHEET_DEFAULTS.width / 2) < 0.5, '水平居中');
  const text = spec.items.find(i => i.kind === 'text');
  assert.ok(text.height >= MIN_TEXT_MM && text.height < 5, `文字略高 ${text.height}`);
  const dim = spec.items.find(i => i.kind === 'dimension');
  assert.equal(dim.offset, -1.2, '标注偏移按同一比例换算');
  assert.equal(spec.meta.projection.scale, 100);
  assert.deepEqual(outOfFrame(spec), []);
});

test('确定性：同一输入两次投影、两次渲染都字节相同', () => {
  const once = projectSheet(box(12000, 8000), {scale: 100});
  const twice = projectSheet(box(12000, 8000), {scale: 100});
  assert.deepEqual(once, twice);
  assert.equal(renderSheet(once), renderSheet(twice));
});

test('空图面也能投影，越界图元能被发现', () => {
  const empty = projectSheet(sheetSpec({kind: 'wall-demolition', title: '空图', items: []}), {scale: 100});
  assert.equal(empty.meta.projection.empty, true);
  assert.equal(renderSheet(empty).includes('<svg'), true);

  const outside = sheetSpec({kind: 'wall-demolition', title: '越界', items: [
    {layer: 'wall-existing', kind: 'polyline', points: [[0, 0], [5000, 0]]}
  ]});
  assert.equal(outOfFrame(outside).length, 1, '未投影的模型坐标落在图框外');
});

test('真实模型：拆改图经过投影后没有图元越界', () => {
  const model = {
    schema: 'space-model/v1',
    units: 'mm',
    projectId: 'demo',
    floors: [{
      id: 'ground',
      walls: [
        {handle: 'W1', outer: [[0, 0], [6000, 0], [6000, 4000]]},
        {handle: 'W2', outer: [[0, 0], [0, 4000]], demolition: true},
        {handle: 'W3', outer: [[6000, 4000], [0, 4000]], built: false}
      ],
      doors: [], windowOpenings: []
    }]
  };
  const spec = projectSheet(demolitionSpec(model), {scale: 100});
  assert.deepEqual(outOfFrame(spec), []);
  const svg = renderSheet(spec);
  assert.match(svg, /Wall|拆/);
  assert.equal(renderSheet(projectSheet(demolitionSpec(model), {scale: 100})), svg, '同输入同字节');
});
