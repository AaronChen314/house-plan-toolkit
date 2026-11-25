// L1 领域：渲染与交付包的纯逻辑（无 IO、无 crypto）。
import {BUNDLE_ROLES, MAX_SNAPSHOT_BYTES, normalizeCamera} from '../contracts/rendering.mjs';

// 机位指纹：同一组参数必须稳定，供记录与比对使用。
export function cameraKey(camera) {
  const c = normalizeCamera(camera);
  return [c.azimuthDeg, c.elevationDeg, c.distanceMm, c.fovDeg, ...c.target].map(v => Number(v).toFixed(3)).join('|');
}

// 交付包条目：按路径排序去重，保证清单字节稳定。
export function canonicalEntries(entries = []) {
  const byPath = new Map();
  for (const entry of entries) {
    if (!entry?.path) continue;
    byPath.set(entry.path, {path: entry.path, role: entry.role, sha256: entry.sha256, bytes: entry.bytes});
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function bundleSummary(manifest) {
  const byRole = {};
  for (const entry of manifest?.entries || []) byRole[entry.role] = (byRole[entry.role] || 0) + 1;
  const bytes = (manifest?.entries || []).reduce((n, e) => n + (Number.isFinite(e.bytes) ? e.bytes : 0), 0);
  return {files: (manifest?.entries || []).length, bytes, byRole};
}

// 缺失与不一致分开报：缺失说明包不完整，不一致说明包被改过。
export function bundleProblems(manifest, actual = {}) {
  const missing = [], mismatched = [];
  for (const entry of manifest?.entries || []) {
    const sha = actual[entry.path];
    if (sha === undefined || sha === null) missing.push(entry.path);
    else if (sha !== entry.sha256) mismatched.push(entry.path);
  }
  return {missing, mismatched};
}

export function snapshotWithinLimit(bytes, limit = MAX_SNAPSHOT_BYTES) {
  return Number.isFinite(bytes) && bytes > 0 && bytes <= limit;
}

// 基础图与风格图的分工：基础图锁几何，风格图不许改几何。
export function assertStyleOnly(style, base) {
  if (!style) return true;
  if (style.geometry || style.vertices || style.footprint) throw new Error('风格参数不能包含几何字段');
  if (base?.geometryLocked !== true) throw new Error('效果图必须基于锁定几何的基础图');
  return true;
}

export function entryRoleOf(rel) {
  const posix = String(rel || '');
  if (posix.endsWith('/manifest.json') || posix === 'manifest.json') return 'manifest';
  if (posix.startsWith('data/designs/')) return 'design';
  if (posix.startsWith('data/datasets/')) {
    if (/\/dataset\.json$/.test(posix)) return 'dataset';
    if (/\/model(\.json)?$/.test(posix)) return 'model';
    return 'data';
  }
  if (posix.startsWith('output/doc/')) return 'document';
  if (posix.startsWith('output/render/')) return 'render';
  if (posix.startsWith('output/model/') || /\.(glb|gltf)$/i.test(posix)) return 'model';
  return BUNDLE_ROLES.includes('data') ? 'data' : 'data';
}
