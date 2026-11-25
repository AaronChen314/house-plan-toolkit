// L1 领域：施工图图面渲染。纯函数，无 IO、无时间、无随机数。
// 输入是契约里的 space-sheet/v1（src/contracts/documents.mjs），输出是可落盘的 SVG 文本与给人看的摘要。
// 坐标约定：图元坐标即图面毫米（1 用户单位 = 1mm，viewBox 用 mm 数），spec.scale 只进标题栏；
// 模型坐标到图面坐标的投影由能力层负责，渲染器不做自动缩放或自动套版，才能保证同输入同字节。
import {LAYERS, LAYER_IDS, SHEET_DEFAULTS, docKind, validateSheetSpec} from '../contracts/documents.mjs';

const FONT = {kind: 3.2, title: 7, subtitle: 4, scale: 3.5, meta: 3.2, note: 3.2, item: 3.5, dim: 3};
const TITLE_BAR = {minWidth: 180, pad: 5, rowHeight: 1.6};
const NOTE_AREA = {pad: 5, lineHeight: 5.6};
const DIMENSION = {overrun: 2.4, tick: 1.4, labelGap: 1.5};
const POINT_RADIUS = 1.8;

// 数字格式化：最多两位小数、去尾零、-0 归一为 0，同输入字节相同（不用 toLocaleString 之类的本地化）。
function num(value) {
  const rounded = Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
  // String(-0) 已经是 '0'；这里只处理超大数转指数记法之外的情况，坐标量级不会到那里。
  return String(rounded);
}

// XML 转义：& < > " ' 全部转，文本与属性走同一个函数。
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 粗估文字宽度（毫米）：只用于图框与标题栏排版，不做字体度量。
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;
function textWidth(text, size) {
  let units = 0;
  for (const ch of String(text)) units += WIDE_CHAR.test(ch) ? 1 : 0.56;
  return units * size;
}

function sheetBox(size) {
  const src = size && typeof size === 'object' ? size : {};
  return {
    width: src.width ?? SHEET_DEFAULTS.width,
    height: src.height ?? SHEET_DEFAULTS.height,
    margin: src.margin ?? SHEET_DEFAULTS.margin
  };
}

// 图层输出顺序：优先按 spec.layerOrder，未声明的图层按 LAYERS.order 兜底；
// 图框与说明是图面必需的，调用方漏声明时补在合理位置。
function layerPlan(spec) {
  const declared = Array.isArray(spec?.layerOrder) ? spec.layerOrder.filter(id => LAYERS[id]) : [];
  const rank = new Map();
  for (const id of declared) if (!rank.has(id)) rank.set(id, rank.size);
  const ids = declared.length ? [...declared] : [...LAYER_IDS];
  for (const required of ['frame', 'note']) if (!ids.includes(required)) ids.push(required);
  const key = (id) => rank.get(id) ?? 1000 + LAYERS[id].order;
  return [...new Set(ids)].sort((a, b) => key(a) - key(b) || LAYERS[a].order - LAYERS[b].order);
}

function isPrimitive(value) {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

// meta：排序后输出少量键值；非基本类型（时间戳对象、数组等易变内容）一律丢掉。
function metaEntries(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return [];
  return Object.keys(meta)
    .sort()
    .filter(key => key && isPrimitive(meta[key]))
    .map(key => [String(key), String(meta[key])]);
}

function pointsAttr(points) {
  return points.map(([x, y]) => `${num(x)},${num(y)}`).join(' ');
}

function lineMarkup({x1, y1, x2, y2}) {
  return `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}"/>`;
}

function rectMarkup({x, y, width, height}) {
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}"/>`;
}

function circleMarkup({cx, cy, r, color}) {
  return `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" fill="${color}" stroke="none"/>`;
}

function textMarkup({x, y, size, text, color, weight = null, anchor = null}) {
  const attrs = [
    `x="${num(x)}"`,
    `y="${num(y)}"`,
    `font-size="${num(size)}"`,
    `fill="${color}"`,
    'stroke="none"'
  ];
  if (weight) attrs.push(`font-weight="${weight}"`);
  if (anchor) attrs.push(`text-anchor="${anchor}"`);
  return `<text ${attrs.join(' ')}>${esc(text)}</text>`;
}

// 尺寸标注：两条引出线 + 平行偏移线 + 两端端点 + 标签；offset 的正负决定往法向哪一侧让。
function dimensionMarkup(item) {
  const color = LAYERS.dimension.color;
  const [x1, y1] = item.from;
  const [x2, y2] = item.to;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  const ux = length > 0 ? dx / length : 1;
  const uy = length > 0 ? dy / length : 0;
  const nx = -uy;
  const ny = ux;
  const offset = item.offset;
  const ax = x1 + nx * offset;
  const ay = y1 + ny * offset;
  const bx = x2 + nx * offset;
  const by = y2 + ny * offset;
  const overrun = (offset >= 0 ? 1 : -1) * DIMENSION.overrun;

  const out = [
    lineMarkup({x1, y1, x2: ax + nx * overrun, y2: ay + ny * overrun}),
    lineMarkup({x1: x2, y1: y2, x2: bx + nx * overrun, y2: by + ny * overrun}),
    lineMarkup({x1: ax, y1: ay, x2: bx, y2: by}),
    lineMarkup({x1: ax - nx * DIMENSION.tick, y1: ay - ny * DIMENSION.tick, x2: ax + nx * DIMENSION.tick, y2: ay + ny * DIMENSION.tick}),
    lineMarkup({x1: bx - nx * DIMENSION.tick, y1: by - ny * DIMENSION.tick, x2: bx + nx * DIMENSION.tick, y2: by + ny * DIMENSION.tick})
  ];

  const label = typeof item.label === 'string' && item.label.trim() ? item.label : num(length);
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  let lx = mx;
  let ly;
  if (ny > 0.01) ly = my - DIMENSION.labelGap;
  else if (ny < -0.01) ly = my + FONT.dim + DIMENSION.labelGap;
  else {
    lx = mx + (nx > 0 ? -DIMENSION.labelGap : DIMENSION.labelGap);
    ly = my + FONT.dim * 0.35;
  }
  out.push(textMarkup({x: lx, y: ly, size: FONT.dim, text: label, color, anchor: 'middle'}));
  return out;
}

function renderItem(item) {
  const layer = LAYERS[item.layer];
  if (!layer) return [];
  if (item.kind === 'text') {
    const size = Number.isFinite(item.height) && item.height > 0 ? item.height : FONT.item;
    return [textMarkup({x: item.at[0], y: item.at[1], size, text: item.text, color: layer.color})];
  }
  if (item.kind === 'point') {
    const r = Number.isFinite(item.r) && item.r > 0 ? item.r : POINT_RADIUS;
    return [circleMarkup({cx: item.at[0], cy: item.at[1], r, color: layer.color})];
  }
  if (item.kind === 'dimension') return dimensionMarkup(item);
  const tag = item.kind === 'polygon' ? 'polygon' : 'polyline';
  return [`<${tag} points="${pointsAttr(item.points)}"/>`];
}

// 标题栏内容：图种、图名、副题、比例、排序后的 meta；不含时间戳与文件名。
function titleBarLines(spec) {
  const lines = [];
  const kindTitle = docKind(spec.kind)?.title ?? spec.kind;
  if (kindTitle !== spec.title) lines.push({text: kindTitle, size: FONT.kind, weight: null});
  lines.push({text: spec.title, size: FONT.title, weight: 600});
  if (spec.subtitle) lines.push({text: spec.subtitle, size: FONT.subtitle, weight: null});
  lines.push({text: `比例 1:${num(spec.scale)}`, size: FONT.scale, weight: null});
  for (const [key, value] of metaEntries(spec.meta)) lines.push({text: `${key}：${value}`, size: FONT.meta, weight: null});
  return lines;
}

export function renderSheet(spec) {
  const problems = validateSheetSpec(spec);
  if (problems.length) throw new Error(`图面数据不合法：${problems.join('；')}`);

  const {width, height, margin} = sheetBox(spec.size);
  if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) {
    throw new Error(`图幅尺寸不合法：${num(width)}×${num(height)}`);
  }
  if (!(Number.isFinite(margin) && margin >= 0 && margin * 2 < Math.min(width, height))) {
    throw new Error(`图框边距不合法：${num(margin)}（图幅 ${num(width)}×${num(height)}）`);
  }

  const inner = {x: margin, y: margin, width: width - margin * 2, height: height - margin * 2};
  const buckets = new Map();
  const push = (layerId, markup) => {
    if (!buckets.has(layerId)) buckets.set(layerId, []);
    buckets.get(layerId).push(markup);
  };

  // 1. 图框与标题栏
  push('frame', rectMarkup(inner));

  const lines = titleBarLines(spec);
  const barHeight = lines.reduce((sum, line) => sum + line.size * TITLE_BAR.rowHeight, 0) + TITLE_BAR.pad * 2;
  const widest = lines.reduce((max, line) => Math.max(max, textWidth(line.text, line.size)), 0);
  const barWidth = Math.min(
    Math.max(TITLE_BAR.minWidth, widest + TITLE_BAR.pad * 2),
    Math.max(TITLE_BAR.minWidth, inner.width - 4)
  );
  const bar = {
    x: inner.x + inner.width - barWidth,
    y: inner.y + inner.height - Math.min(barHeight, inner.height),
    width: barWidth,
    height: Math.min(barHeight, inner.height)
  };
  push('frame', rectMarkup(bar));
  let cursorY = bar.y + TITLE_BAR.pad;
  for (const line of lines) {
    push('frame', textMarkup({
      x: bar.x + TITLE_BAR.pad,
      y: cursorY + line.size * 0.95,
      size: line.size,
      text: line.text,
      color: LAYERS.frame.color,
      weight: line.weight
    }));
    cursorY += line.size * TITLE_BAR.rowHeight;
  }

  // 2. 图元：按图层分桶，层内保持 items 原序
  for (const item of spec.items || []) {
    for (const markup of renderItem(item)) push(item.layer, markup);
  }

  // 3. 说明：图框左下逐行，第一条在最上方
  const notes = (spec.notes || []).map(note => String(note));
  if (notes.length) {
    const left = inner.x + NOTE_AREA.pad;
    const bottom = inner.y + inner.height - NOTE_AREA.pad;
    const firstBaseline = bottom - (notes.length - 1) * NOTE_AREA.lineHeight;
    const room = bar.x - left - NOTE_AREA.pad * 2;
    const ruleWidth = Math.min(
      Math.max(...notes.map(note => textWidth(note, FONT.note))) + NOTE_AREA.pad * 2,
      Math.max(40, room)
    );
    const ruleY = firstBaseline - FONT.note * 1.6;
    push('frame', lineMarkup({x1: left, y1: ruleY, x2: left + ruleWidth, y2: ruleY}));
    for (const [i, note] of notes.entries()) {
      push('note', textMarkup({x: left, y: firstBaseline + i * NOTE_AREA.lineHeight, size: FONT.note, text: note, color: LAYERS.note.color}));
    }
  }

  // 4. 组装：每个图层一个 <g data-layer>，样式统一挂在组上
  const groups = [];
  for (const id of layerPlan(spec)) {
    const children = buckets.get(id);
    if (!children || !children.length) continue;
    const layer = LAYERS[id];
    const attrs = [`data-layer="${id}"`, 'fill="none"', `stroke="${layer.color}"`, `stroke-width="${num(layer.width)}"`];
    if (Array.isArray(layer.dash) && layer.dash.length) attrs.push(`stroke-dasharray="${layer.dash.map(num).join(' ')}"`);
    groups.push(`  <g ${attrs.join(' ')}>`);
    for (const child of children) groups.push(`    ${child}`);
    groups.push('  </g>');
  }

  const header = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}mm" height="${num(height)}mm" viewBox="0 0 ${num(width)} ${num(height)}" role="img" aria-label="${esc(spec.title)}">`,
    `  <title>${esc(spec.title)}</title>`
  ];
  return [...header, ...groups, '</svg>', ''].join('\n');
}

// 实际输出到的图层 id（按输出顺序）：图框始终有内容，说明与图元按需。
export function svgLayerIds(spec) {
  const used = new Set(['frame']);
  if ((spec?.notes || []).length) used.add('note');
  for (const item of spec?.items || []) if (LAYERS[item?.layer]) used.add(item.layer);
  return layerPlan(spec).filter(id => used.has(id));
}

// 纯文本摘要：供 CLI 打印，方便人核对图名、比例与各图层用量。
export function renderTextSummary(spec) {
  const {width, height, margin} = sheetBox(spec?.size);
  const plan = layerPlan(spec);
  const counts = new Map();
  for (const item of spec?.items || []) {
    if (!LAYERS[item?.layer]) continue;
    counts.set(item.layer, (counts.get(item.layer) || 0) + 1);
  }
  const used = svgLayerIds(spec);
  const kindTitle = docKind(spec?.kind)?.title ?? '未知图种';
  const lines = [];
  lines.push(`图名：${spec?.title || '（未命名）'}`);
  lines.push(`图种：${kindTitle}（${spec?.kind ?? '未知'}）`);
  lines.push(`比例：1:${num(spec?.scale)}`);
  lines.push(`图幅：${num(width)} × ${num(height)} mm（图框边距 ${num(margin)}mm）`);
  lines.push(`图元：${(spec?.items || []).length} 项 · 说明 ${(spec?.notes || []).length} 条`);
  lines.push(`图层：${used.length}/${plan.length} 有用到（图元数）`);
  for (const id of plan) {
    const count = counts.get(id) || 0;
    lines.push(`  ${String(count).padStart(3)}  ${id.padEnd(14)}${LAYERS[id].name}`);
  }
  return lines.join('\n');
}
