// L0 契约：底图描图（人在 studio 上把没识别出来的构件画出来）。
// 原则：任何识别结果都可以被人工修正；人工画的构件必须带来源与操作者，能追溯。

export const TRACE_SCHEMA = 'space-trace/v1';

// 构件来源：识别脚本、人工描图、导入的模型。
export const PROVENANCE = ['cadvec', 'dxf', 'manual', 'import'];
export const DEFAULT_PROVENANCE = 'manual';

// 允许的描图项。房间暂不入模型（space-model 还没有房间数组），先只收墙。
export const TRACE_ITEM_KINDS = ['wall', 'invalid'];

// 底图：图片路径 + 比例 + 原点（图片左上角对应的模型毫米坐标）。
// 比例与原点允许人工改，因为自动识别经常差一点。
export function underlay({file, mmPerPx, origin = [0, 0], rotationDeg = 0} = {}) {
  return {file: file ?? null, mmPerPx: Number(mmPerPx), origin: [Number(origin[0]), Number(origin[1])], rotationDeg: Number(rotationDeg) || 0};
}

export function validateUnderlay(value) {
  const problems = [];
  if (!value || typeof value !== 'object') return ['底图必须是对象'];
  if (!value.file) problems.push('底图缺少图片路径');
  if (!Number.isFinite(value.mmPerPx) || value.mmPerPx <= 0) problems.push('底图比例 mmPerPx 必须是正数');
  if (!Array.isArray(value.origin) || value.origin.length !== 2 || value.origin.some(v => !Number.isFinite(v))) problems.push('底图原点需要两个数字');
  if (![0, 90, 180, 270].includes(Number(value.rotationDeg) || 0)) problems.push('底图旋转只支持 0/90/180/270');
  return problems;
}

export function traceItem(item) {
  if (item?.kind === 'invalid') return {kind: 'invalid', handle: item.handle ?? null, reason: item.reason ?? null};
  return {
    kind: 'wall',
    from: [Number(item?.from?.[0]), Number(item?.from?.[1])],
    to: [Number(item?.to?.[0]), Number(item?.to?.[1])],
    thicknessMm: Number(item?.thicknessMm),
    provenance: item?.provenance || DEFAULT_PROVENANCE
  };
}

export function validateTraceItem(item) {
  const problems = [];
  if (!item || typeof item !== 'object') return ['描图项必须是对象'];
  if (!TRACE_ITEM_KINDS.includes(item.kind)) { problems.push(`未知描图项类型：${item.kind}`); return problems; }
  if (item.kind === 'invalid') {
    if (!item.handle) problems.push('判无效需要 handle');
    return problems;
  }
  const pair = (p) => Array.isArray(p) && p.length === 2 && p.every(v => Number.isFinite(v));
  if (!pair(item.from) || !pair(item.to)) problems.push('墙需要 from / to 两个点');
  else if (Math.hypot(item.to[0] - item.from[0], item.to[1] - item.from[1]) < 1) problems.push('墙的两点重合');
  if (!Number.isFinite(item.thicknessMm) || item.thicknessMm <= 0 || item.thicknessMm > 1000) problems.push('墙厚需在 1–1000mm 之间');
  if (!PROVENANCE.includes(item.provenance || DEFAULT_PROVENANCE)) problems.push(`未知来源：${item.provenance}`);
  return problems;
}

// 一次描图提交：数据集 + 楼层 + 底图 + 构件 + 操作者。
export function traceSpec({dataset, floor = null, items = [], underlay: ul = null, actor = null, note = ''} = {}) {
  return {schema: TRACE_SCHEMA, dataset, floor, underlay: ul, items, actor, note};
}

export function validateTraceSpec(spec) {
  const problems = [];
  if (!spec || typeof spec !== 'object') return ['描图提交必须是对象'];
  if (spec.schema !== TRACE_SCHEMA) problems.push(`schema 应为 ${TRACE_SCHEMA}`);
  if (!spec.dataset) problems.push('缺少数据集 id');
  if (!spec.actor) problems.push('缺少操作者（人工改动要能追溯）');
  if (!Array.isArray(spec.items) || !spec.items.length) problems.push('至少提交一个描图项');
  else spec.items.forEach((item, i) => validateTraceItem(item).forEach(p => problems.push(`items[${i}]: ${p}`)));
  if (spec.underlay) problems.push(...validateUnderlay(spec.underlay).map(p => `底图：${p}`));
  return problems;
}

// 人工改动的记录：写进数据集，供追溯与失效分析使用。
export function traceRecord({at, actor, floor, items = [], underlay: ul = null, note = ''} = {}) {
  const walls = items.filter(i => i.kind === 'wall').length;
  const invalid = items.filter(i => i.kind === 'invalid').length;
  return {at, actor, floor: floor ?? null, walls, invalid, underlay: ul ?? null, note};
}
