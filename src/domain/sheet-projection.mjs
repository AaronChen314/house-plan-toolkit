// L1 领域：模型坐标 → 图纸坐标。渲染器只认毫米图纸坐标，投影在这里做，
// 同一输入得到同一结果，比例只从固定阶梯里取。
import {SHEET_DEFAULTS} from '../contracts/documents.mjs';

// 图框内留给图形的区域：去掉边距与标题栏。
export const TITLE_BLOCK_MM = 46;
export const MIN_TEXT_MM = 2.5;
export const DEFAULT_TEXT_MM = 40;
export const SCALE_LADDER = [20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500];

const round = (v) => Math.round(v * 100) / 100;

function pointOf(item) {
  if (item?.kind === 'text' || item?.kind === 'point') return item.at;
  return null;
}

// 图形范围：折线/多边形的所有点、文字的插入点、标注的两端。
export function specBounds(spec) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (p) => {
    if (!Array.isArray(p) || p.length < 2) return;
    const [x, y] = p;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const item of spec?.items || []) {
    if (item?.kind === 'dimension') { add(item.from); add(item.to); continue; }
    const at = pointOf(item);
    if (at) { add(at); continue; }
    for (const p of item?.points || []) add(p);
  }
  if (!Number.isFinite(minX)) return null;
  return {minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY};
}

export function drawingArea({size = {}, margin = SHEET_DEFAULTS.margin, titleBlock = TITLE_BLOCK_MM} = {}) {
  const width = (size.width ?? SHEET_DEFAULTS.width) - margin * 2;
  const height = (size.height ?? SHEET_DEFAULTS.height) - margin * 2 - titleBlock;
  return {width, height};
}

// 请求的比例放不下时，沿阶梯放大分母，直到能放进图框。
export function fitScale(requested, bounds, area) {
  const scale = Number.isFinite(requested) && requested > 0 ? requested : SHEET_DEFAULTS.scale;
  if (!bounds) return scale;
  const ladder = [...new Set([scale, ...SCALE_LADDER.filter(s => s > scale).sort((a, b) => a - b)])];
  for (const candidate of ladder) {
    if (bounds.width / candidate <= area.width && bounds.height / candidate <= area.height) return candidate;
  }
  return ladder.at(-1);
}

// 投影：按比例缩小后在图框内居中；文字高度与标注偏移一起换算成图纸毫米。
export function projectSheet(spec, {scale, size = {}, margin = SHEET_DEFAULTS.margin, titleBlock = TITLE_BLOCK_MM} = {}) {
  const bounds = specBounds(spec);
  const area = drawingArea({size, margin, titleBlock});
  const effective = fitScale(scale ?? spec.scale, bounds, area);
  if (!bounds) return {...spec, scale: effective, meta: {...spec.meta, projection: {scale: effective, empty: true}}};

  const paperW = bounds.width / effective;
  const paperH = bounds.height / effective;
  const offsetX = margin + (area.width - paperW) / 2;
  const offsetY = margin + (area.height - paperH) / 2;
  const project = ([x, y]) => [round(offsetX + (x - bounds.minX) / effective), round(offsetY + (y - bounds.minY) / effective)];

  const items = (spec.items || []).map(item => {
    if (item?.kind === 'dimension') {
      return {...item, from: project(item.from), to: project(item.to), offset: round(item.offset / effective)};
    }
    if (item?.kind === 'text') {
      const height = Number.isFinite(item.height) ? item.height : DEFAULT_TEXT_MM;
      return {...item, at: project(item.at), height: Math.max(MIN_TEXT_MM, round(height / effective))};
    }
    if (item?.kind === 'point') return {...item, at: project(item.at)};
    return {...item, points: (item.points || []).map(project)};
  });

  return {
    ...spec,
    scale: effective,
    items,
    meta: {
      ...spec.meta,
      projection: {scale: effective, sourceBounds: bounds, paper: {width: round(paperW), height: round(paperH)}}
    }
  };
}

// 越界检查：投影后仍有图元落在图框外时，出图前要能看见。
export function outOfFrame(spec, {size = {}, margin = SHEET_DEFAULTS.margin} = {}) {
  const width = size.width ?? SHEET_DEFAULTS.width;
  const height = size.height ?? SHEET_DEFAULTS.height;
  const outside = [];
  for (const item of spec?.items || []) {
    const points = item?.kind === 'dimension' ? [item.from, item.to] : item?.kind === 'text' || item?.kind === 'point' ? [item.at] : item?.points || [];
    for (const p of points) {
      if (!Array.isArray(p)) continue;
      if (p[0] < margin - 0.01 || p[1] < margin - 0.01 || p[0] > width - margin + 0.01 || p[1] > height - margin + 0.01) {
        outside.push({layer: item.layer, kind: item.kind, at: p});
        break;
      }
    }
  }
  return outside;
}
