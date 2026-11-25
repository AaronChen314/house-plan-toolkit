// L0 契约：几何索引查询。索引是派生物，查询结果只读；工作台与能力都按这里取数。
// 索引不可用时调用方降级为「每次解析」，不把缺失当致命错误。

export const INDEX_SCHEMA_ID = 'space-index/v1';
export const INDEX_FORMAT = 1;

export const QUERY_LIMITS = {defaultLimit: 500, maxLimit: 5000};

// 实体行：与 cad-source/v1 的图元字段对应，坐标是毫米包围盒。
export const ENTITY_FIELDS = ['id', 'dataset', 'handle', 'type', 'layer', 'minx', 'miny', 'maxx', 'maxy'];

// 查询：包围盒（含边界相交）、图层与类型白名单、分页。
// 分页用游标探测（多取一行判断是否还有），默认不数总数——全量 COUNT 是查询里最贵的一步。
export const QUERY_FIELDS = ['dataset', 'box', 'layers', 'types', 'limit', 'offset', 'count'];

function toBox(box) {
  if (box == null) return null;
  if (Array.isArray(box) && box.length === 4 && box.every(v => Number.isFinite(v))) {
    const [minx, miny, maxx, maxy] = box;
    return minx <= maxx && miny <= maxy ? [minx, miny, maxx, maxy] : [Math.min(minx, maxx), Math.min(miny, maxy), Math.max(minx, maxx), Math.max(miny, maxy)];
  }
  if (typeof box === 'object' && ['minX', 'minY', 'maxX', 'maxY'].every(k => k in box)) {
    return toBox([box.minX, box.minY, box.maxX, box.maxY]);
  }
  return null;
}

export function normalizeQuery(input = {}) {
  const problems = [];
  const box = toBox(input.box);
  if (input.box != null && !box) problems.push('box 需要 [minX, minY, maxX, maxY] 或 {minX,minY,maxX,maxY}');

  const list = (value, field) => {
    if (value == null) return [];
    const arr = Array.isArray(value) ? value : [value];
    const cleaned = arr.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim());
    if (!cleaned.length && arr.length) problems.push(`${field} 需要非空字符串`);
    return [...new Set(cleaned)];
  };

  const limit = input.limit == null ? QUERY_LIMITS.defaultLimit : Number(input.limit);
  const offset = input.offset == null ? 0 : Number(input.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > QUERY_LIMITS.maxLimit) problems.push(`limit 需为 1–${QUERY_LIMITS.maxLimit} 的整数`);
  if (!Number.isInteger(offset) || offset < 0) problems.push('offset 需为非负整数');

  return {
    dataset: input.dataset == null ? null : String(input.dataset),
    box,
    layers: list(input.layers, 'layers'),
    types: list(input.types, 'types'),
    limit,
    offset,
    count: input.count === true,
    problems
  };
}

export function queryProblems(input = {}) {
  return normalizeQuery(input).problems;
}

// 分页结果：有 nextOffset 就继续取；total 只在你显式要 count 时才有值。
export function pageOf(rows, {limit, offset, total = null, hasMore = false}) {
  const nextOffset = hasMore ? offset + rows.length : null;
  return {rows, total, limit, offset, nextOffset, hasMore};
}

// 索引摘要：工作台显示「已索引多少图元、覆盖多大范围」用它。
export function indexSummaryOf({entities, layers, types, bounds, bytes, builtAt, nodes}) {
  return {
    schema: INDEX_SCHEMA_ID,
    entities,
    layers,
    types,
    nodes: nodes || {},
    bounds: bounds || null,
    bytes: bytes ?? null,
    builtAt: builtAt || null
  };
}
