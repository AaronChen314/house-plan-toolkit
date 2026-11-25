// L1 领域：拆改图图面数据。纯函数：只接空间模型、出图面数据（space-sheet/v1），不读文件、不写文件。
// 分类规则只在 classifyWalls 里，图层映射只在 demolitionSpec 里；两者都不含 I/O 与时间/随机量，
// 同一输入任意次调用结果深相等（数组顺序取自 floors/walls/doors 的原序，不做对象键遍历）。
import {sheetSpec} from '../contracts/documents.mjs';

// 墙体分类 → 图层。跨图种混用由 validateSheetSpec 拒绝，这里只给拆改图允许的图层。
const WALL_LAYER = {existing: 'wall-existing', demolish: 'wall-demolish', new: 'wall-new'};
const WALL_CLASSES = ['existing', 'demolish', 'new'];
// 图面文字用中文，和图层名一一对应：保留 / 拆除 / 新建。
const WALL_LABEL = {existing: '保留', demolish: '拆除', new: '新建'};

// 缺 thicknessMm 时的默认墙厚（毫米）：CAD 转出来的模型常常只给轮廓。
export const DEFAULT_WALL_THICKNESS_MM = 200;
// 尺寸标注的偏移量（毫米，负值=画在墙体另一侧），契约要求 dimension 必须带 offset。
export const DIMENSION_OFFSET_MM = -120;

const isPoint = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const asPoint = (p) => [p[0], p[1]];
const isRing = (v) => Array.isArray(v) && v.length >= 2 && isPoint(v[0]);

// 墙体的写法有三种：{polygon:{outer}}（模型契约）、裸环（示例模型的实际形状）、{outer}。
// model.mjs 与 checks.mjs 都同时兼容，这里保持一致；只认 polygon.outer 会把示例模型整份跳过。
function ringOf(item) {
  const p = item?.polygon ?? item;
  if (Array.isArray(p)) return isRing(p) ? p.filter(isPoint).map(asPoint) : null;
  if (Array.isArray(p?.outer)) {
    const ring = p.outer.filter(isPoint);
    return ring.length >= 2 ? ring.map(asPoint) : null;
  }
  return null;
}

// 门窗洞口：窗取 footprint 外环；门多数只有铰链/关闭端（示例模型即如此），退化为洞口的门线。
function openingRing(item, kind) {
  const footprint = item?.footprint;
  const first = Array.isArray(footprint) ? footprint[0] : footprint;
  const ring = ringOf(first);
  if (ring) return ring;
  if (kind === 'door' && isPoint(item?.hinge) && isPoint(item?.closedEnd)) {
    return [asPoint(item.hinge), asPoint(item.closedEnd)];
  }
  return null;
}

// 图元标识：优先模型给的 handle，其次 id，最后用「楼层:集合:序号」兜底。
// 兜底必须确定性，才能让同一份模型的两次输出深相等。
function handleOf(item, floorId, key, index) {
  return String(item?.handle ?? item?.id ?? `${floorId}:${key}:${index}`);
}

function boundsOfPoints(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

// 多边形质心（面积加权）；退化（面积为 0）时退回顶点平均。
function centroidOf(points) {
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(area) < 1e-9) {
    const sum = points.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
    return [sum[0] / points.length, sum[1] / points.length];
  }
  return [cx / (3 * area), cy / (3 * area)];
}

// 分类优先级（顺序即优先级，先命中先返回）：
// 1. demolition === true  → demolish  拆除优先于一切：同一面墙又被标新砌时，现场做法仍是「先拆」；
// 2. built === false | status === 'new' | new === true → new  新建（新砌墙体，可来自设计或建模标注）；
// 3. 其余 → existing  保留。
function classifyWall(wall) {
  if (wall?.demolition === true) return 'demolish';
  if (wall?.built === false || wall?.status === 'new' || wall?.new === true) return 'new';
  return 'existing';
}

// 门窗只有 existing / new 两态：新开（改门洞、加窗）标 new，其余保留。
// 判定与墙体第 2 条一致：inserted === true 或 status === 'new' → new。
function classifyOpening(opening) {
  if (opening?.inserted === true || opening?.status === 'new') return 'new';
  return 'existing';
}

function selectedFloors(modelData, floor) {
  const floors = Array.isArray(modelData?.floors) ? modelData.floors : [];
  if (floor === undefined || floor === null) return {floors, found: true};
  return {floors: floors.filter(f => f?.id === floor), found: floors.some(f => f?.id === floor)};
}

// 空间模型 → 拆改分类结果。只分类，不排版；图层与标注在 demolitionSpec 里加。
export function classifyWalls(modelData, {floor} = {}) {
  const {floors, found} = selectedFloors(modelData, floor);
  const walls = [];
  const openings = [];
  const notes = [];
  let missingThickness = 0;
  let skippedWalls = 0;
  let skippedOpenings = 0;

  if (!found) notes.push(`未找到楼层 ${floor}，拆改分类为空`);

  for (const f of floors) {
    if (!f) continue;
    for (const [i, wall] of (Array.isArray(f.walls) ? f.walls : []).entries()) {
      const points = ringOf(wall);
      if (!points) { skippedWalls += 1; continue; }
      const hasThickness = Number.isFinite(wall?.thicknessMm);
      if (!hasThickness) missingThickness += 1;
      walls.push({
        class: classifyWall(wall),
        points,
        thicknessMm: hasThickness ? wall.thicknessMm : DEFAULT_WALL_THICKNESS_MM,
        handle: handleOf(wall, f.id, 'walls', i)
      });
    }

    // 顺序固定：每层先门后窗，各自按模型数组原序——同一份模型输出必然一致。
    for (const [key, kind] of [['doors', 'door'], ['windowOpenings', 'window']]) {
      for (const [i, item] of (Array.isArray(f[key]) ? f[key] : []).entries()) {
        const points = openingRing(item, kind);
        if (!points) { skippedOpenings += 1; continue; }
        openings.push({class: classifyOpening(item), points, kind, handle: handleOf(item, f.id, key, i)});
      }
    }
  }

  if (skippedWalls) notes.push(`${skippedWalls} 面墙缺少轮廓，已跳过`);
  if (skippedOpenings) notes.push(`${skippedOpenings} 处门窗缺少轮廓，已跳过`);
  if (missingThickness) notes.push(`${missingThickness} 面墙未给厚度，按 ${DEFAULT_WALL_THICKNESS_MM} 毫米处理`);

  return {walls, openings, notes, floorIds: floors.map(f => f?.id).filter(id => typeof id === 'string')};
}

// 统计只数分类结果，供图面说明与上层核对；不做推断。
export function demolitionStats(result) {
  const stats = {existing: 0, demolish: 0, new: 0, openings: 0};
  for (const wall of result?.walls || []) {
    if (WALL_CLASSES.includes(wall.class)) stats[wall.class] += 1;
  }
  stats.openings = (result?.openings || []).length;
  return stats;
}

// 分类结果 → 拆改图图面数据。每面墙三件：轮廓（按分类进图层）+ 外包矩尺寸标注 + 质心处的做法说明。
export function demolitionSpec(modelData, {title = '拆改图', scale = 100, floor, notes = []} = {}) {
  const result = classifyWalls(modelData, {floor});
  const stats = demolitionStats(result);
  const items = [];

  for (const wall of result.walls) {
    items.push({layer: WALL_LAYER[wall.class], kind: 'polyline', points: wall.points, handle: wall.handle});
    const [minX, minY, maxX, maxY] = boundsOfPoints(wall.points);
    // 外包矩的两个对角点定标注跨度；offset 固定 -120，标注统一画在墙体外侧。
    // 不给 label：长度由渲染层按 from/to 现算，避免这里算出一份会被改写的数字。
    items.push({
      layer: 'dimension', kind: 'dimension',
      from: [minX, minY], to: [maxX, maxY], offset: DIMENSION_OFFSET_MM,
      handle: wall.handle
    });
    items.push({
      layer: 'note', kind: 'text', at: centroidOf(wall.points),
      text: `${WALL_LABEL[wall.class]} ${wall.thicknessMm} 厚`,
      handle: wall.handle
    });
  }

  for (const opening of result.openings) {
    items.push({layer: 'opening', kind: 'polyline', points: opening.points, handle: opening.handle});
  }

  const givenNotes = (Array.isArray(notes) ? notes : [notes]).filter(n => typeof n === 'string' && n.trim());
  const sheetNotes = [
    ...givenNotes,
    ...result.notes,
    `${WALL_LABEL.existing} ${stats.existing} · ${WALL_LABEL.demolish} ${stats.demolish} · ${WALL_LABEL.new} ${stats.new}`,
    `门窗洞口 ${stats.openings} 处`
  ];

  return sheetSpec({
    kind: 'wall-demolition',
    title,
    scale,
    items,
    notes: sheetNotes,
    meta: {floorIds: result.floorIds, stats}
  });
}
