// L0 契约：渲染、交付包与只读快照（M4）。
// 原则（来自 docs/architecture.md）：表现层在几何锁定之后；生成物不能反向回写数据。

export const RENDER_SCHEMA = 'space-render/v1';
export const BUNDLE_SCHEMA = 'space-bundle/v1';
export const SNAPSHOT_SCHEMA = 'space-snapshot/v1';

// implemented=false 的图只有契约：效果图需要栅格渲染器，不在确定性 SVG 链里。
export const RENDER_KINDS = [
  {id: 'colorplan', title: '彩平图', ext: 'svg', implemented: true},
  {id: 'interior', title: '室内效果图', ext: 'png', implemented: false}
];

export const RENDER_KIND_IDS = RENDER_KINDS.map(r => r.id);

export function renderKind(id) {
  return RENDER_KINDS.find(r => r.id === id) || null;
}

// 固定机位：同一组参数必须得到同一张图，所以相机只允许这几个字段。
export const CAMERA_FIELDS = ['target', 'azimuthDeg', 'elevationDeg', 'distanceMm', 'fovDeg'];

export const DEFAULT_CAMERA = {
  target: [0, 1500, 0],
  azimuthDeg: 45,
  elevationDeg: 30,
  distanceMm: 6000,
  fovDeg: 45
};

export function normalizeCamera(camera = {}) {
  const merged = {...DEFAULT_CAMERA, ...camera};
  return {
    target: Array.isArray(merged.target) && merged.target.length === 3 ? merged.target.map(Number) : DEFAULT_CAMERA.target,
    azimuthDeg: Number(merged.azimuthDeg),
    elevationDeg: Number(merged.elevationDeg),
    distanceMm: Number(merged.distanceMm),
    fovDeg: Number(merged.fovDeg)
  };
}

export function validateCamera(camera) {
  const problems = [];
  if (!camera || typeof camera !== 'object') return ['机位必须是对象'];
  if (!Array.isArray(camera.target) || camera.target.length !== 3 || camera.target.some(v => !Number.isFinite(v))) problems.push('机位 target 需要三个数字');
  for (const field of ['azimuthDeg', 'elevationDeg', 'distanceMm', 'fovDeg']) {
    if (!Number.isFinite(camera[field])) problems.push(`机位 ${field} 必须是数字`);
  }
  if (Number.isFinite(camera.distanceMm) && camera.distanceMm <= 0) problems.push('机位距离必须为正');
  if (Number.isFinite(camera.fovDeg) && (camera.fovDeg <= 0 || camera.fovDeg >= 180)) problems.push('机位视角必须在 0–180 之间');
  return problems;
}

// 效果图拆成两张：基础图锁几何，风格图只改材质与光线。契约把这两层分开。
export function styleSplit(options = {}) {
  const {base = null, style = null} = options || {};
  return {
    base: base ? {file: base.file, sha256: base.sha256 ?? null, geometryLocked: true} : null,
    style: style ? {id: style.id ?? null, seed: style.seed ?? null, params: style.params ?? {}} : null
  };
}

export function renderFile({kind, scheme, seq, ext}) {
  const spec = renderKind(kind);
  if (!spec) throw new Error(`未知渲染图种：${kind}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(scheme || ''))) throw new Error(`方案 id 不合法：${scheme}`);
  if (!Number.isInteger(seq) || seq < 1) throw new Error(`版本号需为正整数：${seq}`);
  return `output/render/${kind}/${scheme}-${String(seq).padStart(3, '0')}.${ext ?? spec.ext}`;
}

export function renderRecordFile({kind, scheme, seq}) {
  return renderFile({kind, scheme, seq, ext: 'json'});
}

export function renderRecord({kind, file, sha256, bytes, camera, inputs, style = null, deterministic = true} = {}) {
  return {
    schema: RENDER_SCHEMA,
    kind,
    file,
    sha256,
    bytes,
    camera: normalizeCamera(camera),
    inputs,
    style: styleSplit(style || {}),
    deterministic
  };
}

export function validateRender(record) {
  const problems = [];
  if (!record || typeof record !== 'object') return ['渲染记录必须是对象'];
  if (record.schema !== RENDER_SCHEMA) problems.push(`schema 应为 ${RENDER_SCHEMA}`);
  if (!RENDER_KIND_IDS.includes(record.kind)) problems.push(`未知渲染图种：${record.kind}`);
  if (!record.file) problems.push('缺少产物路径');
  if (!/^[0-9a-f]{64}$/.test(String(record.sha256 || ''))) problems.push('缺少产物哈希');
  if (!record.inputs?.design?.scheme) problems.push('缺少设计版本输入');
  if (!record.inputs?.dataset?.id) problems.push('缺少数据集输入');
  problems.push(...validateCamera(record.camera).map(p => `机位：${p}`));
  if (record.deterministic !== true) problems.push('渲染记录必须声明 deterministic: true');
  return problems;
}

// 交付包：只读目录 + 哈希清单。包里的每个文件都要有哈希，便于拷走校验。
export const BUNDLE_ROLES = ['manifest', 'design', 'dataset', 'model', 'document', 'render', 'data'];

export function bundleDir(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(name || ''))) throw new Error(`交付包名不合法：${name}`);
  return `output/bundle/${name}`;
}

export function bundleManifestFile(name) {
  return `${bundleDir(name)}/manifest.json`;
}

export function bundleManifest({name, design, entries = []} = {}) {
  return {
    schema: BUNDLE_SCHEMA,
    name,
    design: design ? {scheme: design.scheme, seq: design.seq} : null,
    entries: entries.map(e => ({path: e.path, role: e.role, sha256: e.sha256, bytes: e.bytes})),
    readOnly: true
  };
}

export function validateBundle(value) {
  const problems = [];
  if (!value || typeof value !== 'object') return ['交付包清单必须是对象'];
  if (value.schema !== BUNDLE_SCHEMA) problems.push(`schema 应为 ${BUNDLE_SCHEMA}`);
  if (!value.name) problems.push('缺少交付包名');
  if (value.readOnly !== true) problems.push('交付包必须声明 readOnly: true');
  if (!value.design?.scheme) problems.push('缺少设计版本');
  if (!Array.isArray(value.entries) || !value.entries.length) problems.push('交付包至少要包含一个文件');
  const seen = new Set();
  for (const [i, entry] of (value.entries || []).entries()) {
    const where = `entries[${i}]`;
    if (!entry?.path) problems.push(`${where} 缺少路径`);
    if (seen.has(entry?.path)) problems.push(`${where} 路径重复：${entry?.path}`);
    seen.add(entry?.path);
    if (!BUNDLE_ROLES.includes(entry?.role)) problems.push(`${where} 未知角色：${entry?.role}`);
    if (!/^[0-9a-f]{64}$/.test(String(entry?.sha256 || ''))) problems.push(`${where} 缺少哈希`);
    if (!Number.isFinite(entry?.bytes)) problems.push(`${where} 缺少大小`);
  }
  return problems;
}

// 只读快照：单文件、离线打开、不回写。体积上限防止把大模型塞进一个文件。
export const MAX_SNAPSHOT_BYTES = 40 * 1024 * 1024;

export function snapshotFile(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(name || ''))) throw new Error(`快照名不合法：${name}`);
  return `output/snapshot/${name}.html`;
}

export function snapshotRecordFile(name) {
  return snapshotFile(name).replace(/\.html$/, '.json');
}

export function snapshotRecord({name, file, bytes, hashes = [], embedded = [], design = null} = {}) {
  return {
    schema: SNAPSHOT_SCHEMA,
    name,
    file,
    bytes,
    writable: false,
    offline: true,
    design: design ? {scheme: design.scheme, seq: design.seq} : null,
    embedded,
    hashes
  };
}

export function validateSnapshot(record) {
  const problems = [];
  if (!record || typeof record !== 'object') return ['快照记录必须是对象'];
  if (record.schema !== SNAPSHOT_SCHEMA) problems.push(`schema 应为 ${SNAPSHOT_SCHEMA}`);
  if (!record.file) problems.push('缺少快照路径');
  if (record.writable !== false) problems.push('快照必须声明 writable: false');
  if (record.offline !== true) problems.push('快照必须声明 offline: true');
  if (!Number.isFinite(record.bytes) || record.bytes <= 0) problems.push('缺少快照大小');
  if (Number.isFinite(record.bytes) && record.bytes > MAX_SNAPSHOT_BYTES) problems.push(`快照超过体积上限 ${MAX_SNAPSHOT_BYTES}`);
  if (!Array.isArray(record.hashes) || !record.hashes.length) problems.push('快照必须带哈希清单');
  return problems;
}

// 写权限守卫：生成的产物永远不能当输入。这一条让「渲染结果反写数据」在结构上不可能。
export const GENERATED_ROOTS = ['output'];

export function isGenerated(rel) {
  const posix = String(rel || '').replace(/\\/g, '/');
  return GENERATED_ROOTS.some(root => posix === root || posix.startsWith(root + '/'));
}

export function assertSourceNotGenerated(rel) {
  if (isGenerated(rel)) throw new Error(`生成物不能作为输入：${rel}（渲染层不能反向回写数据）`);
  return true;
}
