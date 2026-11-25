// L1 领域：拆改可行性、净空与动线规则。纯函数，只接模型出结论，不读文件、不认项目。
// 三组规则各自独立返回 {passed, issues}，由 summarizeChecks 合并；能力层只负责编排与文案。
import {pointInPoly, polygonsIntersect} from './geometry.mjs';

// 阈值按毫米给，出处是常规住宅净宽：入户门 900、室内门 800、窗洞 600、通道 900。
export const MIN_DOOR_CLEAR_MM = 800;
export const MIN_WINDOW_CLEAR_MM = 600;
export const MIN_CORRIDOR_CLEAR_MM = 900;

// 规则标识固定，能力层与界面的 byRule 用同一套名字。
export const CHECK_RULES = ['demolition', 'openings', 'circulation'];

// 拆改要有依据：现场勘察记录、原图纸标注或复核意见，任一存在即可。
const BASIS_FIELDS = ['basis', 'basisNote', 'surveyNote', 'evidence', 'sourceNote', 'note'];

const issue = (severity, code, object, message) => ({severity, code, object, message});
const summarize = (issues) => ({passed: !issues.some(i => i.severity === 'error'), issues});

const isPoint = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const floorsOf = (data) => (Array.isArray(data?.floors) ? data.floors : []);

// 墙体、柱体在数据里可能是多边形、{polygon} 或裸环，统一取外环。
function outerRing(item) {
  const p = item?.polygon ?? item;
  if (Array.isArray(p)) return Array.isArray(p[0]) ? p.filter(isPoint) : null;
  if (Array.isArray(p?.outer)) return p.outer.filter(isPoint);
  return null;
}

const isRing = (v) => Array.isArray(v) && v.length >= 3 && isPoint(v[0]);

// footprint 三种写法都兼容：裸环、单个多边形（窗洞）、多边形数组（家具）。
function asPolys(value) {
  if (!value) return [];
  if (isRing(value)) return [{outer: value.filter(isPoint), holes: []}];
  if (Array.isArray(value)) return value.flatMap(asPolys);
  if (Array.isArray(value.outer)) return [{outer: value.outer.filter(isPoint), holes: []}];
  return [];
}

function footprintPolys(item) {
  return asPolys(item?.footprint).filter(p => p.outer.length >= 3);
}

const objectOf = (floor, key, item, index) =>
  `${floor.id}:${item?.id || `${key}:${index}`}`;

// 点到线段的距离：先投影到线段上再取模，投影超出端点时退化为端点距离。
export function segmentDistance(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));
}

// 点到多边形轮廓的最近距离；落在多边形内记 0。
export function distanceToRing(point, ring) {
  if (!ring || ring.length < 2) return Infinity;
  if (ring.length >= 3 && pointInPoly(point[0], point[1], {outer: ring, holes: []})) return 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    best = Math.min(best, segmentDistance(point, ring[i], ring[(i + 1) % ring.length]));
  }
  return best;
}

function hasBasis(item) {
  return BASIS_FIELDS.some(field => {
    const v = item?.[field];
    if (typeof v === 'string') return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    return v === true;
  });
}

// 门洞净宽：优先显式宽度字段，其次用铰链到关闭端的距离（门洞净宽）。
function doorWidth(door) {
  for (const v of [door?.widthMm, door?.openingWidthMm]) if (Number.isFinite(v)) return v;
  if (isPoint(door?.hinge) && isPoint(door?.closedEnd)) return distance(door.hinge, door.closedEnd);
  return null;
}

// 窗洞净宽：优先显式宽度字段，其次取轮廓最长边（矩形洞的长边就是洞口宽度）。
function windowWidth(win) {
  for (const v of [win?.widthMm, win?.openingWidthMm]) if (Number.isFinite(v)) return v;
  // 窗洞本身是单个多边形（footprint），不是 walls 那样直接给外环。
  const ring = footprintPolys(win)[0]?.outer || outerRing(win);
  if (!ring || ring.length < 2) return null;
  let best = 0;
  for (let i = 0; i < ring.length; i++) best = Math.max(best, distance(ring[i], ring[(i + 1) % ring.length]));
  return best > 0 ? best : null;
}

// 门扇扫掠区近似：铰链、关闭端、开启端三点构成的三角形；退化三角形不参与判断。
function swingTriangle(door) {
  const {hinge, closedEnd, openEnd} = door || {};
  if (!isPoint(hinge) || !isPoint(closedEnd) || !isPoint(openEnd)) return null;
  const area = Math.abs((closedEnd[0] - hinge[0]) * (openEnd[1] - hinge[1])
    - (openEnd[0] - hinge[0]) * (closedEnd[1] - hinge[1])) / 2;
  return area >= 1 ? {outer: [hinge, closedEnd, openEnd], holes: []} : null;
}

// 拆改：承重构件不许拆（error），非承重拆改要有勘察或图纸依据（warning）。
export function checkDemolition(data) {
  const issues = [];
  for (const floor of floorsOf(data)) {
    for (const key of ['walls', 'columns']) {
      for (const [i, item] of (floor[key] || []).entries()) {
        if (item?.demolition !== true) continue;
        const object = objectOf(floor, key, item, i);
        const label = item.label || item.id || object;
        if (item.structure === 'load-bearing') {
          issues.push(issue('error', 'demolition-bearing-wall', object,
            `${label} 属承重构件，不能按拆改处理；改回保留，确有需求时先出结构复核意见。`));
          continue;
        }
        if (!hasBasis(item)) {
          issues.push(issue('warning', 'demolition-no-basis', object,
            `${label} 标记为拆改，但没有勘察记录或原图依据；补 basis/surveyNote 后再定。`));
        }
      }
    }
  }
  return summarize(issues);
}

// 净空：门洞 < 800 是 error，窗洞 < 600 是 warning，家具挡住门扇开启范围是 error。
export function checkOpenings(data) {
  const issues = [];
  for (const floor of floorsOf(data)) {
    const furniture = (floor.furniture || []).map((item, i) => ({
      item, polys: footprintPolys(item), object: objectOf(floor, 'furniture', item, i)
    }));

    for (const [i, door] of (floor.doors || []).entries()) {
      const object = objectOf(floor, 'doors', door, i);
      const label = door.label || door.id || object;
      const width = doorWidth(door);
      if (width !== null && width < MIN_DOOR_CLEAR_MM) {
        issues.push(issue('error', 'door-too-narrow', object,
          `${label} 门洞净宽 ${Math.round(width)} mm，小于 ${MIN_DOOR_CLEAR_MM} mm，搬运与疏散都不够。`));
      }
      const sweep = swingTriangle(door);
      if (!sweep) continue;
      for (const f of furniture) {
        if (!f.polys.some(p => polygonsIntersect(sweep, p))) continue;
        const name = f.item.label || f.item.id || f.object;
        issues.push(issue('error', 'door-swing-blocked', object,
          `${label} 的开启范围与家具「${name}」相交；挪开家具或改门扇开启方向。`));
      }
    }

    for (const [i, win] of (floor.windowOpenings || []).entries()) {
      const width = windowWidth(win);
      if (width === null || width >= MIN_WINDOW_CLEAR_MM) continue;
      const object = objectOf(floor, 'windowOpenings', win, i);
      const label = win.label || win.id || object;
      issues.push(issue('warning', 'window-too-narrow', object,
        `${label} 窗洞净宽 ${Math.round(width)} mm，小于 ${MIN_WINDOW_CLEAR_MM} mm，采光与开启受限。`));
    }
  }
  return summarize(issues);
}

// 动线：每个步行入口到最近墙体/柱体轮廓的距离 < 900 视为通道过窄。
export function checkCirculation(data) {
  const issues = [];
  for (const floor of floorsOf(data)) {
    const obstacles = [];
    for (const key of ['walls', 'columns']) {
      for (const item of floor[key] || []) {
        const ring = outerRing(item);
        if (ring && ring.length >= 2) obstacles.push(ring);
      }
    }
    if (!obstacles.length) continue;

    for (const [i, entry] of (floor.walkEntries || []).entries()) {
      if (!isPoint(entry?.point)) continue;
      let nearest = Infinity;
      for (const ring of obstacles) nearest = Math.min(nearest, distanceToRing(entry.point, ring));
      if (!(nearest < MIN_CORRIDOR_CLEAR_MM)) continue;
      const object = `${floor.id}:${entry.name || `walkEntries[${i}]`}`;
      issues.push(issue('warning', 'corridor-too-narrow', object,
        `入口「${entry.name || i}」距最近墙体/柱体 ${Math.round(nearest)} mm，小于 ${MIN_CORRIDOR_CLEAR_MM} mm，通道偏窄。`));
    }
  }
  return summarize(issues);
}

// 合并多份检查结果：既能接收 {ruleId: result}，也能接收带 rule 字段的结果数组。
export function summarizeChecks(results) {
  const pairs = Array.isArray(results)
    ? results.map((r, i) => [r?.rule || CHECK_RULES[i] || `rule-${i + 1}`, r])
    : Object.entries(results || {});
  const issues = [];
  const byRule = {};
  for (const [ruleId, result] of pairs) {
    const list = Array.isArray(result?.issues) ? result.issues : [];
    byRule[ruleId] = {
      errors: list.filter(i => i.severity === 'error').length,
      warnings: list.filter(i => i.severity === 'warning').length
    };
    issues.push(...list);
  }
  return {passed: !issues.some(i => i.severity === 'error'), issues, byRule};
}
