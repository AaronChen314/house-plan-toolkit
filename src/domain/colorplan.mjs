// L1 领域：确定性彩平图。纯函数：只接空间模型，输出 SVG 文本、统计与图层清单，不读文件、不写文件。
// 坐标就是模型毫米（viewBox 直接用模型毫米），彩平因此能直接叠在空间模型上；
// scale（1:scale）只换算文字高度、线宽与图例尺寸，不缩放几何——同一份模型换个比例不挪墙。
// 无时间戳、无随机数、不用本地化格式：同一份模型任意次调用字节相同。
// 彩平不画尺寸线（尺寸归施工图），空间关系统一用图例表达，图层顺序固定。

export const COLORMAP_LAYERS = [
  {id: 'slab', name: '地面填充'},
  {id: 'walls', name: '墙体'},
  {id: 'openings', name: '门窗'},
  {id: 'furniture', name: '家具'},
  {id: 'text', name: '文字'},
  {id: 'legend', name: '图例'}
];

// 图层顺序的唯一来源：输出顺序与测试断言都取这里，不在别处复制一份顺序。
export function colorplanLayerIds() {
  return COLORMAP_LAYERS.map(layer => layer.id);
}

// 配色只影响表现，不影响几何；每个主题都必须把颜色写全，缺项才不会被环境变量之类的东西左右。
export const COLORMAP_THEMES = {
  plan: {
    name: '彩平',
    background: '#ffffff',
    slab: '#f4ecdd',
    wall: '#6f6154',
    wallStroke: '#3f372f',
    opening: '#a2947f',
    furniture: '#dbc9a9',
    text: '#2b2521',
    legend: '#2b2521'
  },
  cool: {
    name: '冷调',
    background: '#ffffff',
    slab: '#e6eef2',
    wall: '#4d5a63',
    wallStroke: '#2c353c',
    opening: '#7f939f',
    furniture: '#c8d6de',
    text: '#1f262b',
    legend: '#1f262b'
  },
  mono: {
    name: '灰阶',
    background: '#ffffff',
    slab: '#f0f0f0',
    wall: '#5a5a5a',
    wallStroke: '#2f2f2f',
    opening: '#8c8c8c',
    furniture: '#d2d2d2',
    text: '#1c1c1c',
    legend: '#1c1c1c'
  }
};

// 主题可传 id 或部分颜色对象；结果键顺序固定（先展开默认主题），保证序列化稳定。
export function normalizeTheme(theme) {
  if (theme === undefined || theme === null || theme === '') return {...COLORMAP_THEMES.plan};
  if (typeof theme === 'string') {
    const found = COLORMAP_THEMES[theme];
    if (!found) throw new Error(`未知彩平配色：${theme}`);
    return {...found};
  }
  if (typeof theme !== 'object' || Array.isArray(theme)) throw new Error('彩平配色必须是配色 id 或颜色对象');
  const merged = {...COLORMAP_THEMES.plan};
  for (const key of Object.keys(COLORMAP_THEMES.plan)) {
    if (key === 'name') continue;
    if (typeof theme[key] === 'string' && theme[key].trim()) merged[key] = theme[key].trim();
  }
  if (typeof theme.name === 'string' && theme.name.trim()) merged.name = theme.name.trim();
  return merged;
}

// —— 数字与文本 ——
// 固定两位小数、去尾零、-0 归一为 0：不用 toFixed 之外的本地化格式，同输入同字节。
function num(value) {
  const v = Number.isFinite(value) ? value : 0;
  const rounded = Math.round(v * 100) / 100;
  return String(rounded === 0 ? 0 : rounded);
}

// XML 转义：文本与属性走同一个函数，模型里的 & < > 不会破坏 SVG。
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 粗估文字宽度（毫米）：只用于图例排版，不做字体度量。
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;
function textWidth(text, size) {
  let units = 0;
  for (const ch of String(text)) units += WIDE_CHAR.test(ch) ? 1 : 0.56;
  return units * size;
}

// —— 多边形 ——
const isPoint = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const asPoint = (p) => [p[0], p[1]];
const isRing = (v) => Array.isArray(v) && v.length >= 3 && isPoint(v[0]);

// 环的三种写法：裸点数组、{outer, holes}、{polygon: {outer, holes}}（模型契约的墙体写法）。
function ringOf(value) {
  if (Array.isArray(value)) return isRing(value) ? value.filter(isPoint).map(asPoint) : null;
  if (Array.isArray(value?.outer)) {
    const ring = value.outer.filter(isPoint);
    return ring.length >= 3 ? ring.map(asPoint) : null;
  }
  return null;
}

function polygonOf(value) {
  if (!value || typeof value !== 'object') return null;
  const source = value.polygon && typeof value.polygon === 'object' ? value.polygon : value;
  const outer = ringOf(source.outer);
  if (!outer) return null;
  const holes = (Array.isArray(source.holes) ? source.holes : []).map(ringOf).filter(Boolean);
  const label = [value.label, source.label, value.name, source.name]
    .find(v => typeof v === 'string' && v.trim());
  return {outer, holes, label: label ? label.trim() : null};
}

// 槽位可以是单个多边形、多边形数组（家具 footprint）或空值；顺序即原序，不做排序。
function polygonList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    if (isRing(value)) {
      const poly = polygonOf({outer: value});
      return poly ? [poly] : [];
    }
    return value.flatMap(item => polygonList(item));
  }
  const poly = polygonOf(value);
  return poly ? [poly] : [];
}

// 鞋带公式（毫米²）：环面积取绝对值，holes 逐个扣掉。
export function ringAreaMm2(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}

export function polygonAreaMm2(poly) {
  if (!poly?.outer) return 0;
  const holes = (poly.holes || []).reduce((sum, ring) => sum + ringAreaMm2(ring), 0);
  return Math.max(0, ringAreaMm2(poly.outer) - holes);
}

// 面积文字的统一格式：保留一位小数，"20.0 ㎡" 这样的固定写法。
export function formatAreaMm2(areaMm2) {
  const m2 = (Number.isFinite(areaMm2) ? areaMm2 : 0) / 1e6;
  return `${m2.toFixed(1)} ㎡`;
}

// 面积加权质心；退化（面积为 0）时退回顶点平均。标签落点只由几何决定。
function centroidOf(ring) {
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(area) < 1e-9) {
    const sum = ring.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
    return [sum[0] / ring.length, sum[1] / ring.length];
  }
  return [cx / (3 * area), cy / (3 * area)];
}

function boundsOfRings(rings) {
  const points = rings.flat();
  if (!points.length) return null;
  return points.reduce((b, [x, y]) => [
    Math.min(b[0], x), Math.min(b[1], y),
    Math.max(b[2], x), Math.max(b[3], y)
  ], [Infinity, Infinity, -Infinity, -Infinity]);
}

// —— SVG 标记 ——
function ringPath(ring) {
  return `${ring.map(([x, y], i) => `${i ? 'L' : 'M'}${num(x)} ${num(y)}`).join(' ')} Z`;
}

function pathMarkup(rings) {
  return `<path d="${rings.map(ringPath).join(' ')}"/>`;
}

function lineMarkup(a, b) {
  return `<line x1="${num(a[0])}" y1="${num(a[1])}" x2="${num(b[0])}" y2="${num(b[1])}"/>`;
}

function rectMarkup({x, y, width, height, fill = null, stroke = null, strokeWidth = null}) {
  const attrs = [`x="${num(x)}"`, `y="${num(y)}"`, `width="${num(width)}"`, `height="${num(height)}"`];
  if (fill) attrs.push(`fill="${fill}"`);
  if (stroke) attrs.push(`stroke="${stroke}"`);
  if (Number.isFinite(strokeWidth)) attrs.push(`stroke-width="${num(strokeWidth)}"`);
  return `<rect ${attrs.join(' ')}/>`;
}

function textMarkup({x, y, size, text, color, anchor = null, weight = null}) {
  const attrs = [`x="${num(x)}"`, `y="${num(y)}"`, `font-size="${num(size)}"`, `fill="${color}"`, 'stroke="none"'];
  if (anchor) attrs.push(`text-anchor="${anchor}"`);
  if (weight) attrs.push(`font-weight="${weight}"`);
  return `<text ${attrs.join(' ')}>${esc(text)}</text>`;
}

// 门的画法：洞口线 + 门扇 + 开启弧；缺端点时退回 footprint，再缺就跳过。
function doorMarkup(door, {color, width}) {
  const hinge = isPoint(door?.hinge) ? asPoint(door.hinge) : null;
  const closed = isPoint(door?.closedEnd) ? asPoint(door.closedEnd) : null;
  const open = isPoint(door?.openEnd) ? asPoint(door.openEnd) : null;
  if (!hinge || !closed) return polygonList(door?.footprint).map(poly => pathMarkup([poly.outer, ...poly.holes]));
  const out = [lineMarkup(hinge, closed)];
  const radius = Math.hypot(closed[0] - hinge[0], closed[1] - hinge[1]);
  if (open && radius > 0) {
    out.push(lineMarkup(hinge, open));
    const cross = (closed[0] - hinge[0]) * (open[1] - hinge[1]) - (closed[1] - hinge[1]) * (open[0] - hinge[0]);
    out.push(`<path d="M ${num(closed[0])} ${num(closed[1])} A ${num(radius)} ${num(radius)} 0 0 ${cross >= 0 ? 1 : 0} ${num(open[0])} ${num(open[1])}" fill="none"/>`);
  }
  return out;
}

const CANVAS = {padMm: 6, emptyCanvasMm: {width: 240, height: 160}};

function floorNameOf(floor) {
  if (typeof floor?.name === 'string' && floor.name.trim()) return floor.name.trim();
  if (floor?.id !== undefined && floor.id !== null) return String(floor.id);
  return '未命名楼层';
}

// 空间模型 → 彩平 SVG。纯函数：同一份模型 + 同一组参数，输出字节相同。
// 彩平是单层正投影：不指定 floor 时取模型里的第一层（确定性），多层几何不叠在一张图上。
export function buildColorplan(modelData, {floor, scale = 100, title, theme} = {}) {
  const s = Number(scale);
  if (!Number.isFinite(s) || s <= 0) throw new Error(`彩平比例必须是正数：${scale}`);
  const colors = normalizeTheme(theme);

  const floors = (Array.isArray(modelData?.floors) ? modelData.floors : []).filter(f => f && typeof f === 'object');
  const wanted = floor === undefined || floor === null || floor === '' ? null : String(floor);
  const picked = wanted ? floors.filter(f => String(f.id) === wanted) : floors.slice(0, 1);

  const notes = [];
  if (wanted && !picked.length) notes.push(`未找到楼层 ${wanted}，彩平为空平面`);
  if (!wanted && floors.length > 1) notes.push(`未指定楼层，取模型第一层 ${floorNameOf(floors[0])}`);

  const unit = s; // 图面 1 毫米 = s 个模型毫米
  const font = {title: unit * 6, area: unit * 3.2, label: unit * 2.8, legend: unit * 2.8};
  const stroke = {wall: unit * 0.25, opening: unit * 0.2, furniture: unit * 0.12};

  const content = {slab: [], walls: [], openings: [], furniture: [], text: [], legend: []};
  const surfaces = [];
  const rings = [];
  let wallCount = 0;
  let openingCount = 0;
  let furnitureCount = 0;
  const floorAreas = new Map();

  const addRings = (poly) => {
    rings.push(poly.outer);
    for (const hole of poly.holes) rings.push(hole);
  };

  for (const f of picked) {
    const floorId = f.id ?? null;
    const floorName = floorNameOf(f);
    floorAreas.set(String(floorId), 0);

    // 1. 地面：填充 + 面积文字。面积只来自几何（鞋带公式），不读任何手填数字。
    for (const poly of polygonList(f.slab)) {
      content.slab.push(pathMarkup([poly.outer, ...poly.holes]));
      addRings(poly);
      const areaMm2 = polygonAreaMm2(poly);
      floorAreas.set(String(floorId), floorAreas.get(String(floorId)) + areaMm2);
      surfaces.push({floor: floorId, label: poly.label, areaMm2});
      const [cx, cy] = centroidOf(poly.outer);
      if (poly.label) {
        content.text.push(textMarkup({x: cx, y: cy - font.area * 0.7, size: font.label, text: poly.label, color: colors.text, anchor: 'middle'}));
      }
      content.text.push(textMarkup({
        x: cx,
        y: cy + (poly.label ? font.area * 0.75 : font.area * 0.35),
        size: font.area,
        text: `面积 ${formatAreaMm2(areaMm2)}`,
        color: colors.text,
        anchor: 'middle'
      }));
    }

    // 2. 墙体：墙与柱都是结构填充，同一图层同一种颜色。
    for (const poly of [...polygonList(f.walls), ...polygonList(f.columns)]) {
      content.walls.push(pathMarkup([poly.outer, ...poly.holes]));
      addRings(poly);
      wallCount += 1;
    }

    // 3. 门窗：窗取 footprint（填充），门取铰链 / 关闭端 / 开启端（线 + 弧）。
    for (const [key, kind] of [['doors', 'door'], ['windowOpenings', 'window']]) {
      for (const item of (Array.isArray(f[key]) ? f[key] : [])) {
        if (!item || typeof item !== 'object') continue;
        const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : null;
        let drawn = false;
        let anchor = null;
        if (kind === 'door') {
          const markup = doorMarkup(item, {color: colors.opening, width: stroke.opening});
          if (markup.length) {
            content.openings.push(...markup);
            drawn = true;
            const pts = [item.hinge, item.closedEnd, item.openEnd].filter(isPoint).map(asPoint);
            if (pts.length) anchor = centroidOf(pts.length >= 3 ? pts : [...pts, pts[0]]);
            // 退化成 footprint 的门也要进包围盒，否则画布会裁掉它。
            for (const poly of polygonList(item.footprint)) addRings(poly);
          }
        } else {
          const polys = polygonList(item.footprint);
          if (polys.length) {
            content.openings.push(...polys.map(poly => pathMarkup([poly.outer, ...poly.holes])));
            for (const poly of polys) addRings(poly);
            anchor = centroidOf(polys[0].outer);
            drawn = true;
          }
        }
        if (!drawn) continue;
        openingCount += 1;
        if (label && anchor) {
          content.text.push(textMarkup({x: anchor[0], y: anchor[1], size: font.label, text: label, color: colors.text, anchor: 'middle'}));
        }
      }
    }

    // 4. 家具：footprint 填色 + 构件标签（标签来自模型，没有就退回 id）。
    for (const item of (Array.isArray(f.furniture) ? f.furniture : [])) {
      if (!item || typeof item !== 'object') continue;
      const polys = polygonList(item.footprint);
      if (!polys.length) continue;
      content.furniture.push(...polys.map(poly => pathMarkup([poly.outer, ...poly.holes])));
      for (const poly of polys) addRings(poly);
      furnitureCount += 1;
      const label = [item.label, item.name, item.id].find(v => typeof v === 'string' && v.trim());
      if (label) {
        const [cx, cy] = centroidOf(polys[0].outer);
        content.text.push(textMarkup({x: cx, y: cy + font.label * 0.35, size: font.label, text: label.trim(), color: colors.text, anchor: 'middle'}));
      }
    }
  }

  const areaMm2 = surfaces.reduce((sum, surface) => sum + surface.areaMm2, 0);
  const floorName = picked.length ? floorNameOf(picked[0]) : '';
  const resolvedTitle = typeof title === 'string' && title.trim()
    ? title.trim()
    : (floorName ? `${floorName} 彩平图` : '彩平图');

  // 5. 画布：viewBox 用模型毫米；没有几何时给一块固定画布（不含任何项目信息）。
  const pad = unit * CANVAS.padMm;
  const bounds = boundsOfRings(rings);
  const frame = bounds
    ? {minX: bounds[0] - pad, minY: bounds[1] - pad - font.title * 2.2, maxX: bounds[2] + pad, maxY: bounds[3] + pad}
    : {minX: 0, minY: 0, maxX: CANVAS.emptyCanvasMm.width * unit, maxY: CANVAS.emptyCanvasMm.height * unit};

  // 楼层名放在文字层最前：先读楼层，再读面积与构件标签。
  if (floorName) {
    content.text.unshift(textMarkup({x: frame.minX + pad * 0.2, y: frame.minY + font.title * 1.4, size: font.title, text: floorName, color: colors.text, weight: 600}));
  }

  // 6. 图例：替掉彩平不画的尺寸线。条目与统计全部由本图的图层与面积推导。
  const legendRows = [
    {color: colors.slab, label: COLORMAP_LAYERS[0].name},
    {color: colors.wall, label: COLORMAP_LAYERS[1].name},
    {color: colors.opening, label: COLORMAP_LAYERS[2].name},
    {color: colors.furniture, label: COLORMAP_LAYERS[3].name},
    {text: `合计面积 ${formatAreaMm2(areaMm2)}`},
    {text: `比例 1:${num(s)}`}
  ];
  const legendTitle = COLORMAP_LAYERS[5].name;
  const legendInner = font.legend * 1.15;
  const legendRowHeight = font.legend * 2.2;
  const legendTitleHeight = font.legend * 1.8;
  const swatch = {width: font.legend * 2.4, height: font.legend * 1.2, gap: font.legend * 1.2};
  const rowWidth = (row) => (row.color
    ? swatch.width + swatch.gap + textWidth(row.label, font.legend)
    : textWidth(row.text, font.legend));
  const legendWidth = Math.max(
    textWidth(legendTitle, font.legend),
    ...legendRows.map(rowWidth)
  ) + legendInner * 2;
  const legendHeight = legendInner * 1.4 + legendTitleHeight + legendRows.length * legendRowHeight;
  const legendX = frame.minX;
  const legendY = frame.maxY + unit * 4;
  const maxX = Math.max(frame.maxX, legendX + legendWidth);
  const maxY = legendY + legendHeight + pad;
  const view = {x: frame.minX, y: frame.minY, width: maxX - frame.minX, height: maxY - frame.minY};

  content.legend.push(rectMarkup({
    x: legendX, y: legendY, width: legendWidth, height: legendHeight,
    fill: 'none', stroke: colors.legend, strokeWidth: unit * 0.2
  }));
  content.legend.push(textMarkup({
    x: legendX + legendInner,
    y: legendY + legendInner + font.legend * 1.1,
    size: font.legend,
    text: legendTitle,
    color: colors.legend,
    weight: 600
  }));
  const rowsTop = legendY + legendInner * 1.4 + legendTitleHeight;
  for (const [i, row] of legendRows.entries()) {
    const top = rowsTop + i * legendRowHeight;
    const baseline = top + legendRowHeight * 0.5 + font.legend * 0.35;
    if (row.color) {
      content.legend.push(rectMarkup({
        x: legendX + legendInner,
        y: top + (legendRowHeight - swatch.height) / 2,
        width: swatch.width,
        height: swatch.height,
        fill: row.color
      }));
      content.legend.push(textMarkup({
        x: legendX + legendInner + swatch.width + swatch.gap,
        y: baseline,
        size: font.legend,
        text: row.label,
        color: colors.legend
      }));
    } else {
      content.legend.push(textMarkup({
        x: legendX + legendInner,
        y: baseline,
        size: font.legend,
        text: row.text,
        color: colors.legend
      }));
    }
  }

  // 7. 组装：图层顺序固定；空图层只有 slab（背景）与 text / legend 一定在。
  const format = (id, extras) => [`  <g data-layer="${id}"${extras}>`];
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(view.width / unit)}mm" height="${num(view.height / unit)}mm" viewBox="${num(view.x)} ${num(view.y)} ${num(view.width)} ${num(view.height)}" role="img" aria-label="${esc(resolvedTitle)}" font-family="sans-serif">`,
    `  <title>${esc(resolvedTitle)}</title>`
  ];

  const slabGroup = format('slab', ` fill="${colors.slab}" fill-rule="evenodd" stroke="none"`);
  slabGroup.push(`    ${rectMarkup({x: view.x, y: view.y, width: view.width, height: view.height, fill: colors.background})}`);
  for (const child of content.slab) slabGroup.push(`    ${child}`);
  slabGroup.push('  </g>');
  out.push(...slabGroup);

  if (content.walls.length) {
    const group = format('walls', ` fill="${colors.wall}" fill-rule="evenodd" stroke="${colors.wallStroke}" stroke-width="${num(stroke.wall)}"`);
    for (const child of content.walls) group.push(`    ${child}`);
    group.push('  </g>');
    out.push(...group);
  }

  if (content.openings.length) {
    const group = format('openings', ` fill="${colors.opening}" fill-rule="evenodd" stroke="${colors.opening}" stroke-width="${num(stroke.opening)}"`);
    for (const child of content.openings) group.push(`    ${child}`);
    group.push('  </g>');
    out.push(...group);
  }

  if (content.furniture.length) {
    const group = format('furniture', ` fill="${colors.furniture}" fill-rule="evenodd" stroke="${colors.wallStroke}" stroke-width="${num(stroke.furniture)}"`);
    for (const child of content.furniture) group.push(`    ${child}`);
    group.push('  </g>');
    out.push(...group);
  }

  const textGroup = format('text', ` fill="${colors.text}" stroke="none"`);
  for (const child of content.text) textGroup.push(`    ${child}`);
  textGroup.push('  </g>');
  out.push(...textGroup);

  const legendGroup = format('legend', ` fill="${colors.legend}" stroke="none"`);
  for (const child of content.legend) legendGroup.push(`    ${child}`);
  legendGroup.push('  </g>');
  out.push(...legendGroup);

  out.push('</svg>', '');

  const layers = COLORMAP_LAYERS.map(layer => ({
    id: layer.id,
    name: layer.name,
    count: content[layer.id].length
  }));

  const stats = {
    title: resolvedTitle,
    theme: colors.name,
    scale: s,
    floor: picked.length ? (picked[0].id ?? null) : null,
    floors: picked.map(f => ({
      id: f.id ?? null,
      name: floorNameOf(f),
      areaMm2: floorAreas.get(String(f.id ?? null)) || 0,
      areaM2: Number(((floorAreas.get(String(f.id ?? null)) || 0) / 1e6).toFixed(1))
    })),
    surfaces: surfaces.map(surface => ({
      floor: surface.floor,
      label: surface.label,
      areaMm2: surface.areaMm2,
      areaM2: Number((surface.areaMm2 / 1e6).toFixed(1))
    })),
    areaMm2,
    areaM2: Number((areaMm2 / 1e6).toFixed(1)),
    slabs: surfaces.length,
    walls: wallCount,
    openings: openingCount,
    furniture: furnitureCount,
    labels: content.text.length,
    view,
    notes
  };

  return {svg: out.join('\n'), stats, layers};
}
