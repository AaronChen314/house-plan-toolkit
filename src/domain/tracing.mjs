// L1 领域：底图坐标与描图合并。纯函数，不读写文件。
import {DEFAULT_PROVENANCE, LOW_CONFIDENCE} from '../contracts/tracing.mjs';

const round = (v) => Math.round(v * 10) / 10;

// 图片像素 → 模型毫米。rotationDeg 只做 90° 的整数倍，先旋转再平移。
export function imageToModel(underlay, [px, py]) {
  const k = underlay.mmPerPx;
  const rot = Number(underlay.rotationDeg) || 0;
  let x = px * k;
  let y = py * k;
  if (rot === 90) [x, y] = [y, -x];
  else if (rot === 180) [x, y] = [-x, -y];
  else if (rot === 270) [x, y] = [-y, x];
  return [round(underlay.origin[0] + x), round(underlay.origin[1] + y)];
}

// 中心线 + 墙厚 → 墙体多边形。方向无关，结果稳定（同一墙永远得到同一环）。
export function wallPolygon(from, to, thicknessMm) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (!Number.isFinite(len) || len < 1) throw new Error('墙的两点重合');
  const half = thicknessMm / 2;
  const nx = -(y2 - y1) / len * half;
  const ny = (x2 - x1) / len * half;
  return [[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]].map(([x, y]) => [round(x), round(y)]);
}

// 人工墙的 handle 由几何决定：同一面墙重复提交得到同一个 handle，可幂等覆盖。
export function traceHandle(from, to, thicknessMm) {
  const key = [...from, ...to, thicknessMm].map(v => round(v)).join('_').replace(/\./g, 'p').replace(/-/g, 'm');
  return `TR-${key}`;
}

// 把描图项合并进模型：同 handle 的墙替换，其余保持；判无效的 handle 记进结果。
export function mergeTrace(model, {floor, items, actor, at = null}) {
  if (!model || !Array.isArray(model.floors) || !model.floors.length) throw new Error('模型没有楼层，无法合并描图');
  const targetId = floor || model.floors[0].id;
  const target = model.floors.find(f => f.id === targetId);
  if (!target) throw new Error(`模型里没有楼层：${targetId}`);

  const next = structuredClone(model);
  const floorNext = next.floors.find(f => f.id === targetId);
  floorNext.walls = Array.isArray(floorNext.walls) ? floorNext.walls : [];

  const applied = [];
  const invalidHandles = [];
  for (const item of items) {
    if (item.kind === 'invalid') {
      if (item.handle) invalidHandles.push(item.handle);
      continue;
    }
    const handle = traceHandle(item.from, item.to, item.thicknessMm);
    const wall = {
      handle,
      polygon: {outer: wallPolygon(item.from, item.to, item.thicknessMm)},
      thicknessMm: item.thicknessMm,
      provenance: item.provenance || DEFAULT_PROVENANCE,
      ...(Number.isFinite(item.confidence) ? {confidence: item.confidence} : {}),
      tracedAt: at,
      tracedBy: actor ?? null
    };
    const index = floorNext.walls.findIndex(w => w.handle === handle);
    if (index >= 0) floorNext.walls[index] = {...floorNext.walls[index], ...wall};
    else floorNext.walls.push(wall);
    applied.push({handle, replaced: index >= 0});
  }

  // 保持墙体顺序稳定：按 handle 排序，避免数组顺序随提交顺序漂移。
  floorNext.walls.sort((a, b) => String(a.handle).localeCompare(String(b.handle)));
  return {model: next, applied, invalidHandles, floor: targetId};
}

// 统计一面墙的几何：长度与中心，供摘要与界面显示。
export function wallLength(from, to) {
  return round(Math.hypot(to[0] - from[0], to[1] - from[1]));
}

// 审查：按来源统计墙体，列出低置信度（需要人看一眼）的墙。
export function reviewWalls(walls = []) {
  const byProvenance = {};
  const lowConfidence = [];
  let untyped = 0;
  for (const wall of walls) {
    const source = wall?.provenance || DEFAULT_PROVENANCE;
    byProvenance[source] = (byProvenance[source] || 0) + 1;
    if (wall?.provenance === undefined) untyped += 1;
    if (Number.isFinite(wall?.confidence) && wall.confidence < LOW_CONFIDENCE) lowConfidence.push(wall.handle);
  }
  return {total: walls.length, byProvenance, lowConfidence, untyped};
}

export function traceSummary({applied = [], invalidHandles = [], floor}) {
  const replaced = applied.filter(a => a.replaced).length;
  const created = applied.length - replaced;
  const parts = [`新增 ${created} 面墙`];
  if (replaced) parts.push(`更新 ${replaced} 面`);
  if (invalidHandles.length) parts.push(`判无效 ${invalidHandles.length} 个`);
  return {text: `${floor}：${parts.join('，')}`, created, replaced, invalid: invalidHandles.length};
}
