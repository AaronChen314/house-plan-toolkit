// L1 领域：几何纯函数。毫米、平面 X 向右 Y 向下、高度向上为正。
// 本层禁止读文件、发请求、碰 DOM（由 tests/domain.test.mjs 的静态检查兜底）。

export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPoly(x, y, p) {
  return pointInRing(x, y, p.outer) && !(p.holes || []).some(h => pointInRing(x, y, h));
}

export function boundsOf(polys) {
  const ps = polys.flatMap(p => p.outer);
  if (!ps.length) return [0, 0, 0, 0];
  return ps.reduce((b, p) => [
    Math.min(b[0], p[0]), Math.min(b[1], p[1]),
    Math.max(b[2], p[0]), Math.max(b[3], p[1])
  ], [Infinity, Infinity, -Infinity, -Infinity]);
}

export function polygonsIntersect(a, b) {
  if (a.outer.some(p => pointInPoly(...p, b)) || b.outer.some(p => pointInPoly(...p, a))) return true;
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  for (let i = 0; i < a.outer.length; i++) {
    for (let j = 0; j < b.outer.length; j++) {
      const p = a.outer[i], q = a.outer[(i + 1) % a.outer.length];
      const r = b.outer[j], s = b.outer[(j + 1) % b.outer.length];
      if (cross(p, q, r) * cross(p, q, s) < 0 && cross(r, s, p) * cross(r, s, q) < 0) return true;
    }
  }
  return false;
}

