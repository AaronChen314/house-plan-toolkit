import test from 'node:test';
import assert from 'node:assert/strict';
import {LAYERS, LAYER_IDS, SHEET_DEFAULTS, sheetSpec} from '../src/contracts/index.mjs';
import {renderSheet, renderTextSummary, svgLayerIds} from '../src/domain/sheet.mjs';

const items = () => [
  {layer: 'wall-existing', kind: 'polyline', points: [[0, 0], [1000, 0], [1000, 800]]},
  {layer: 'wall-demolish', kind: 'polyline', points: [[0, 800], [1000, 800]]},
  {layer: 'wall-new', kind: 'polygon', points: [[0, 0], [500, 0], [500, 500]]},
  {layer: 'opening', kind: 'point', at: [1000, 400]},
  {layer: 'dimension', kind: 'dimension', from: [0, 0], to: [1000, 0], offset: -120, label: '1000'},
  {layer: 'note', kind: 'text', at: [20, 20], text: '保留原墙', height: 40}
];

function spec(overrides = {}) {
  return sheetSpec({
    kind: 'wall-demolition',
    title: '一层拆改图',
    subtitle: '示例方案 A',
    items: items(),
    notes: ['拆除前现场复核', '承重墙以结构图为准'],
    meta: {设计版本: 'a-002', 比例备注: '出图按 A1'},
    ...overrides
  });
}

// 取某个图层组的内容（含开闭标签），便于按层核对。
function groupOf(svg, id) {
  const match = svg.match(new RegExp(`  <g data-layer="${id}"[^>]*>[\\s\\S]*?  </g>`));
  return match ? match[0] : '';
}

test('同一份图面数据两次渲染字节相同', () => {
  const one = renderSheet(spec());
  const two = renderSheet(spec());
  assert.equal(two, one);
  assert.equal(renderTextSummary(spec()), renderTextSummary(spec()));
  // 结构信息本身也不带时间戳等易变内容
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(one), '不应出现时间戳');
  assert.ok(one.startsWith('<?xml'), '缺少 XML 声明');
  assert.ok(one.trimEnd().endsWith('</svg>'));
});

test('图层顺序符合 LAYERS.order，层内保持 items 原序', () => {
  assert.deepEqual(svgLayerIds(spec()), ['frame', 'wall-existing', 'wall-demolish', 'wall-new', 'opening', 'dimension', 'note']);
  // 与 LAYERS.order 一致（图框排在最前）
  const expected = LAYER_IDS.filter(id => svgLayerIds(spec()).includes(id));
  assert.deepEqual(svgLayerIds(spec()), expected);

  const svg = renderSheet(spec());
  const positions = svgLayerIds(spec()).map(id => svg.indexOf(`<g data-layer="${id}"`));
  assert.ok(positions.every(p => p > 0), '有图层组没输出');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), '图层组顺序不对');
  assert.equal(svg.match(/<g data-layer="/g).length, svgLayerIds(spec()).length);
  assert.equal(svg.match(/<g /g).length, svg.match(/<\/g>/g).length);

  // 同层内保持 items 原序：两条保留墙体折线按传入顺序出现
  const many = spec({
    items: [
      {layer: 'wall-existing', kind: 'polyline', points: [[0, 0], [100, 0]]},
      {layer: 'wall-existing', kind: 'polyline', points: [[0, 200], [100, 200]]}
    ]
  });
  const lines = groupOf(renderSheet(many), 'wall-existing');
  assert.ok(lines.indexOf('200') > 0);
  assert.ok(lines.indexOf('0,0 100,0') < lines.indexOf('0,200 100,200'));
});

test('文本与属性做 XML 转义', () => {
  const svg = renderSheet(spec({
    title: '拆改图 <A&B>',
    items: [{layer: 'note', kind: 'text', at: [10, 10], text: '管井 & 检修口 <净宽> "600" \'最小\''}],
    notes: ['说明 <不要> & "引号"'],
    meta: {依据: 'A&B'}
  }));
  assert.ok(svg.includes('拆改图 &lt;A&amp;B&gt;'));
  assert.ok(svg.includes('管井 &amp; 检修口 &lt;净宽&gt; &quot;600&quot; &apos;最小&apos;'));
  assert.ok(svg.includes('说明 &lt;不要&gt; &amp; &quot;引号&quot;'));
  assert.ok(svg.includes('依据：A&amp;B'));
  assert.ok(!svg.includes('<净宽>'), '出现了未转义文本');
  // 除合法实体外不应有裸 &（含裸引号导致的属性断裂）
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(svg), '出现了未转义 &');
  assert.ok(!svg.includes('管井 & 检修口'), '文本里的 & 未转义');
  assert.ok(!svg.includes('说明 <不要>'), '说明里的 < 未转义');
  assert.ok(!svg.includes('"最小"'), '文本里的引号未转义');
});

test('数字格式化稳定：两位小数内、去尾零、无浮点长尾', () => {
  const svg = renderSheet(spec({
    items: [
      {layer: 'wall-existing', kind: 'polyline', points: [[1000.5, 0.1 + 0.2], [1.15, 2]]},
      {layer: 'opening', kind: 'point', at: [1000.5, 0.30000000000000004]}
    ]
  }));
  assert.ok(svg.includes('1000.5'), '整数带小数应保持 1000.5');
  assert.ok(!svg.includes('1000.50'), '不应保留尾零');
  assert.ok(svg.includes('1000.5,0.3 1.15,2'), '0.1 + 0.2 应格式化为 0.3');
  assert.ok(svg.includes('1.15'));
  assert.ok(!/\d\.\d{3,}/.test(svg), '出现了超过两位小数的数字');
  assert.ok(!/e[+-]\d/i.test(svg), '出现了指数记法');
  // 尺寸标签同样走同一套格式化
  const dim = renderSheet(spec({
    items: [{layer: 'dimension', kind: 'dimension', from: [0, 0], to: [1000.5, 0], offset: 12}]
  }));
  assert.ok(dim.includes('>1000.5</text>'), '标注默认标签应为格式化后的长度');
});

test('空图元也能生成合法图框', () => {
  const empty = sheetSpec({kind: 'wall-demolition', title: '空图面'});
  const svg = renderSheet(empty);
  assert.deepEqual(svgLayerIds(empty), ['frame']);
  assert.match(svg, /viewBox="0 0 841 594"/);
  assert.equal(SHEET_DEFAULTS.width, 841);
  assert.ok(svg.includes(`width="${SHEET_DEFAULTS.width}mm"`));
  assert.ok(svg.includes('data-layer="frame"'));
  assert.equal(svg.match(/<g /g).length, 1);
  assert.equal(svg.match(/<g /g).length, svg.match(/<\/g>/g).length);

  const custom = sheetSpec({kind: 'wall-demolition', title: '小图幅', size: {width: 420, height: 297, margin: 8}});
  assert.match(renderSheet(custom), /viewBox="0 0 420 297"/);
});

test('非法图面数据直接抛错，问题拼进消息', () => {
  // 未知图层（该图种不允许的水电图层）
  assert.throws(
    () => renderSheet(spec({items: [{layer: 'mep-point', kind: 'point', at: [0, 0]}]})),
    /图面数据不合法：.*不在该图种的规范里/
  );
  // 缺坐标
  assert.throws(
    () => renderSheet(spec({items: [{layer: 'note', kind: 'text', text: '没有坐标'}]})),
    /图面数据不合法：.*缺少坐标/
  );
  // 未知图种
  assert.throws(() => renderSheet(spec({kind: 'nope'})), /未知图种/);
  // 图幅尺寸不合法（契约不校验 size，渲染器自己拦）
  assert.throws(() => renderSheet(spec({size: {width: 0, height: 594}})), /图幅尺寸不合法/);
});

test('notes 按传入顺序逐行渲染在图框左下', () => {
  const svg = renderSheet(spec({items: [], notes: ['第一条', '第二条', '第三条']}));
  const group = groupOf(svg, 'note');
  assert.equal(group.match(/<text /g).length, 3, '每条说明应独立一行');
  assert.ok(group.indexOf('第一条') < group.indexOf('第二条'));
  assert.ok(group.indexOf('第二条') < group.indexOf('第三条'));
  // 说明文字在图框左下：x 靠近左边距，y 靠近底边
  const lines = [...group.matchAll(/<text x="([\d.-]+)" y="([\d.-]+)"/g)].map(m => [Number(m[1]), Number(m[2])]);
  const first = lines[0];
  assert.ok(first[0] < SHEET_DEFAULTS.width / 2, '说明不在左侧');
  assert.ok(first[1] > SHEET_DEFAULTS.height / 2, '说明不在下方');
});

test('dimension 与 text 都能渲染，offset 符号决定标注方向', () => {
  const dimension = (offset) => renderSheet(spec({
    items: [{layer: 'dimension', kind: 'dimension', from: [0, 0], to: [1000, 0], offset}]
  }));
  const below = dimension(-120);
  const above = dimension(120);
  // from→to 沿 +x，法向 (0,1)：负偏移把标注线挪到 y=-120，正偏移挪到 y=120
  assert.ok(below.includes('<line x1="0" y1="-120" x2="1000" y2="-120"/>'));
  assert.ok(above.includes('<line x1="0" y1="120" x2="1000" y2="120"/>'));
  assert.ok(!above.includes('y1="-120"'));
  // 两端点、引出线、标签齐备
  const group = groupOf(below, 'dimension');
  assert.ok(group.match(/<line /g).length >= 5, '标注线不足');
  assert.match(group, /<text [^>]*text-anchor="middle"[^>]*>1000<\/text>/);
  assert.ok(groupOf(renderSheet(spec()), 'dimension').includes('>1000</text>'), '自定义标签应原样输出');

  // 文本图元按图层样式与自带字高输出
  const text = groupOf(renderSheet(spec()), 'note');
  assert.match(text, /<text x="20" y="20" font-size="40"/);
  assert.ok(text.includes('保留原墙'));
});

test('标题栏：图名、比例、排序后的 meta，不带易变信息', () => {
  const svg = renderSheet(spec({meta: {比例备注: 'A1', 设计版本: 'a-002', 忽略: {at: '2026-01-01'}}}));
  const frame = groupOf(svg, 'frame');
  assert.ok(frame.includes('一层拆改图'));
  assert.ok(frame.includes('比例 1:100'));
  assert.ok(frame.includes('示例方案 A'));
  assert.ok(frame.indexOf('比例备注：A1') < frame.indexOf('设计版本：a-002'), 'meta 未按 key 排序');
  assert.ok(!frame.includes('忽略'), '非基本类型的 meta 应被丢弃');
  assert.ok(!frame.includes('2026-01-01'));

  // 图种标题与图名相同则不重复输出
  const same = renderSheet(sheetSpec({kind: 'wall-demolition', title: '拆改图'}));
  assert.equal(groupOf(same, 'frame').match(/>拆改图</g).length, 1);
});

test('文本摘要：图名、比例与图层计数', () => {
  const summary = renderTextSummary(spec());
  assert.match(summary, /图名：一层拆改图/);
  assert.match(summary, /图种：拆改图（wall-demolition）/);
  assert.match(summary, /比例：1:100/);
  assert.match(summary, /图幅：841 × 594 mm/);
  assert.match(summary, /图元：6 项 · 说明 2 条/);
  assert.match(summary, /图层：7\/7 有用到/);
  assert.match(summary, /\s+1 {2}wall-existing 保留墙体/);
  assert.match(summary, /\s+1 {2}opening\s+门窗洞口/);
  const rows = summary.split('\n').filter(line => line.startsWith('  '));
  assert.deepEqual(rows.map(row => row.trim().split(/\s+/)[1]), svgLayerIds(spec()));
  assert.ok(!summary.includes('\u0000'));
});
