// L1 领域：空间模型的归一化与校验。只接数据、出数据，不读文件。
import {boundsOf, pointInPoly} from './geometry.mjs';
import {furnitureHeight, resolveLevels} from './levels.mjs';

export function prepareModel(input) {
  const data = structuredClone(input);
  data.defaults = {slab: 150, ...data.defaults};
  data.view = {explodeGapMm: 3500, cutWallMm: 1400, ...data.view};
  const normalizePoly = (p) => { if (p && Array.isArray(p.outer)) p.holes ??= []; };

  for (const f of data.floors || []) {
    for (const k of ['walls', 'columns', 'slab', 'outdoor', 'doors', 'windowOpenings', 'furniture', 'trace', 'walkEntries', 'guards', 'treads', 'ceilingZones']) f[k] ??= [];
    f.windows = f.windowOpenings.map(w => w.footprint);
    for (const k of ['walls', 'columns', 'slab', 'outdoor', 'roofSlab']) for (const p of f[k] || []) normalizePoly(p);
    for (const t of f.treads) normalizePoly(t.polygon || t);
    for (const z of f.ceilingZones) for (const p of z.footprint || []) normalizePoly(p);
    for (const w of f.windowOpenings) normalizePoly(w.footprint);
    for (const it of f.furniture) for (const p of it.footprint || []) normalizePoly(p);
    for (const it of [...f.furniture, ...f.doors, ...f.windowOpenings]) {
      it.sourceHandles ??= [];
      it.heightFrom ??= 'unknown';
      it.baseMm ??= 0;
      it.detail ??= [];
      if (it.footprint && Array.isArray(it.footprint)) it.bounds ??= boundsOf(it.footprint);
    }
  }
  const bounds = boundsOf(data.floors.flatMap(f => [...f.slab, ...f.outdoor]));
  data.view.centerMm ??= [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  return data;
}

export function validateModel(data) {
  const issues = [];
  const issue = (severity, code, object, message) => issues.push({severity, code, object, message});
  if (data.schema !== 'space-model/v1') issue('error', 'schema', 'document', 'Expected space-model/v1');
  if (data.units !== 'mm') issue('error', 'units', 'document', 'Only explicit millimetres supported');
  if (!data.projectId) issue('error', 'project-id', 'document', 'projectId is required for isolated settings');
  if (!Array.isArray(data.floors) || !data.floors.length) {
    return {passed: false, issues: [...issues, {severity: 'error', code: 'floors', message: 'At least one floor is required'}]};
  }

  const ids = new Set();
  let resolved;
  for (const f of data.floors) {
    if (!f.id || ids.has(f.id)) issue('error', 'floor-id', f.id, 'Missing or duplicate floor id');
    ids.add(f.id);
  }
  try { resolved = resolveLevels(data); } catch (e) { issue('error', 'height-relations', 'document', e.message); }

  const polyCheck = (p, id) => {
    if (!p || !Array.isArray(p.outer) || p.outer.length < 3) { issue('error', 'polygon', id, 'Missing polygon ring'); return; }
    for (const ring of [p.outer, ...(p.holes || [])]) {
      if (!Array.isArray(ring)) { issue('error', 'coordinates', id, 'Invalid coordinates'); continue; }
      if (ring.some(p => !Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v)))) issue('error', 'coordinates', id, 'Invalid coordinates');
    }
  };

  for (const f of data.floors) {
    const names = new Set();
    for (const key of ['slab', 'outdoor', 'walls', 'columns', 'roofSlab', 'treads']) {
      for (const [i, p] of (f[key] || []).entries()) polyCheck(p.polygon || p, f.id + ':' + key + ':' + i);
    }
    for (const [i, z] of f.ceilingZones.entries()) {
      for (const p of z.footprint || []) polyCheck(p, f.id + ':ceiling:' + i);
      if (resolved) {
        try { if (!Number.isFinite(resolved.expression(z.top))) throw new Error('Invalid local ceiling top'); }
        catch (e) { issue('error', 'ceiling-height', f.id + ':ceiling:' + i, e.message); }
      }
    }
    const l = resolved?.byId[f.id];
    if (l && (l.clearHeight <= 0 || l.wallHeight <= 0 || l.slab <= 0)) issue('error', 'height', f.id, 'Height and slab must be positive');
    for (const ref of [...(f.ceilingFromFloorIds || []), ...(f.stairsTo ? [f.stairsTo] : [])]) {
      if (!ids.has(ref)) issue('error', 'floor-reference', f.id, 'Unknown floor ' + ref);
    }
    if (f.treads?.length && !f.stairsTo) issue('error', 'stairs-target', f.id, 'Treads require stairsTo');

    for (const it of [...(f.furniture || []), ...(f.doors || []), ...(f.windowOpenings || [])]) {
      const id = f.id + ':' + it.id;
      if (!it.id || names.has(it.id)) issue('error', 'object-id', id, 'Missing or duplicate object id');
      names.add(it.id);
      if (it.heightFrom === 'unknown') issue('warning', 'height-source', id, 'Vertical source not specified');
      if (it.kind === 'window') {
        if (!(it.headMm > it.sillMm && it.sillMm >= 0)) issue('error', 'window-height', id, 'Head must be above sill');
        polyCheck(it.footprint, id);
      } else if (it.kind === 'door') {
        for (const key of ['hinge', 'closedEnd', 'openEnd']) {
          if (!Array.isArray(it[key]) || it[key].length !== 2 || it[key].some(v => !Number.isFinite(v))) issue('error', 'door-geometry', id, 'Missing ' + key);
        }
        if (!(it.heightMm > 0 && it.thicknessMm > 0)) issue('error', 'door-height', id, 'Positive door height/thickness required');
      } else {
        for (const p of it.footprint || []) polyCheck(p, id);
        if (!it.footprint?.length) issue('error', 'furniture-footprint', id, 'Footprint required');
        if (it.cabinetRole !== 'full' && !Number.isFinite(it.heightMm)) issue('error', 'unknown-height', id, 'Supply an explicit height or preview assumption');
      }
      if (l) {
        try {
          const h = it.kind === 'window' ? it.headMm
            : it.kind === 'door' ? it.heightMm
            : furnitureHeight(data, f, it, resolved) + (it.baseMm || 0);
          if (h <= 0 || h > l.clearHeight + 1) issue('warning', 'clearance', id, 'Component height conflicts with clear height');
        } catch (e) { issue('error', 'component-relations', id, e.message); }
      }
    }
    for (const e of f.walkEntries || []) {
      if (!f.slab.concat(f.outdoor || []).some(p => pointInPoly(...e.point, p))) issue('error', 'entry-support', f.id + ':' + e.name, 'Walk entry is outside floor support');
    }
  }
  return {passed: !issues.some(i => i.severity === 'error'), issues};
}
