// L1 领域：竖向关系。完成面、净高、板厚、局部顶面与柜顶有效顶面都由这里推导。
import {polygonsIntersect} from './geometry.mjs';

export function resolveLevels(data, slab = data.defaults.slab) {
  const cache = new Map(), active = new Set();
  function solve(id, field) {
    const key = id + ':' + field;
    if (cache.has(key)) return cache.get(key);
    if (active.has(key)) throw new Error('Cyclic height relation: ' + key);
    const f = data.floors.find(f => f.id === id);
    if (!f) throw new Error('Unknown floor: ' + id);
    active.add(key);
    const v = expression(f[field]);
    if (!Number.isFinite(v)) throw new Error('Unknown or invalid ' + key);
    cache.set(key, v);
    active.delete(key);
    return v;
  }
  function expression(e) {
    if (typeof e === 'number') return e;
    if (!e || typeof e !== 'object') return NaN;
    return (e.floorId ? solve(e.floorId, e.field || 'elevation') : 0) + (e.valueMm ?? 0) + (e.slabFactor ?? 0) * slab;
  }
  const levels = data.floors.map(f => ({
    id: f.id,
    elevation: solve(f.id, 'elevation'),
    clearHeight: solve(f.id, 'clearHeight'),
    wallHeight: f.wallHeight === undefined ? solve(f.id, 'clearHeight') : expression(f.wallHeight),
    slab: expression(f.slabThickness ?? {slabFactor: 1})
  }));
  return {levels, byId: Object.fromEntries(levels.map(l => [l.id, l])), expression};
}

export function furnitureHeight(data, f, it, resolved) {
  if (it.cabinetRole !== 'full') return it.heightMm;
  const base = resolved.byId[f.id].elevation, limits = [resolved.byId[f.id].clearHeight];
  for (const id of f.ceilingFromFloorIds || []) {
    const other = data.floors.find(x => x.id === id), l = resolved.byId[id];
    if (!other || !l) throw new Error('Unknown ceiling floor: ' + id);
    if (l.elevation > base && other.slab.some(p => it.footprint.some(q => polygonsIntersect(p, q)))) {
      limits.push(l.elevation - l.slab - base);
    }
  }
  for (const zone of f.ceilingZones || []) {
    if (zone.footprint.some(p => it.footprint.some(q => polygonsIntersect(p, q)))) limits.push(resolved.expression(zone.top) - base);
  }
  return Math.min(...limits) - (it.baseMm || 0) - (it.topGapMm || 0);
}
