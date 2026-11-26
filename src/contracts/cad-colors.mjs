// L0 契约：CAD 颜色与线条语义。
//
// 重要前提：**颜色语义不是国标**。GB/T 50001 约束线宽与线型，不约束颜色含义；
// 颜色对应关系来自行业/设计院模板惯例，且会被 ByLayer、打印样式（CTB）、
// 单色出图、扫描件抹掉。所以这里给的是「默认惯例 + 置信度」，
// 永远让图层名与几何特征（双线、填充、断口弧）优先。
//
// 三个消费者共用这一张表：
//   1. skills 文档（辅助 AI 读图与判断）
//   2. 识别映射（cad.vector 给实体打 category / confidence）
//   3. studio 配色（默认与 CAD 惯例一致，可切换看原始 ACI 颜色）

// ACI（AutoCAD Color Index）基础色的近似 RGB。
export const ACI_RGB = {
  1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff',
  6: '#ff00ff', 7: '#ffffff', 8: '#808080', 9: '#c0c0c0'
};

// 语义类别。aci 是常见取值（可能多个），studio 是界面里的固定配色。
// note 写清「为什么」以及常见例外，避免把惯例当规则。
export const CAD_CATEGORIES = {
  wall: {label: '墙体', aci: [1, 7], studio: '#7c3aed', note: '墙体常为白色或红色；实心涂黑的墙多为承重，需结合填充与厚度'},
  column: {label: '柱', aci: [1], studio: '#991b1b', note: '柱常与墙同色，靠形状（矩形/实心）区分'},
  door: {label: '门', aci: [2], studio: '#b45309', note: '门图层常见黄色；断口处有 90°/45° 开启弧更可靠'},
  window: {label: '窗', aci: [4], studio: '#0e7490', note: '窗图层常见青色；墙线上 3–4 条平行细线是更可靠的判断'},
  axis: {label: '轴线', aci: [6], studio: '#db2777', note: '轴线常为品红且是点划线；颜色与线型一起看'},
  dimension: {label: '尺寸', aci: [3], studio: '#15803d', note: '尺寸线常见绿色；斜杠刻度是更可靠的判断'},
  text: {label: '文字', aci: [2, 7], studio: '#334155', note: '文字颜色很杂，按图层或实体类型判断'},
  beam: {label: '梁', aci: [], studio: '#be5800', note: '梁常与墙同色，靠图层名（梁/beam）或虚线识别'},
  slab: {label: '楼板', aci: [1, 7], studio: '#475569', note: '楼板边界多为细实线；以图层名（楼板/slab）为准'},
  stair: {label: '楼梯', aci: [], studio: '#7c2d12', note: '楼梯踏步与箭头；以图层名或踏步阵列判断'},
  opening: {label: '洞口', aci: [], studio: '#0f766e', note: '洞口常由断口或标注表达；与门窗区分靠图层名'},
  furniture: {label: '家具', aci: [4, 5], studio: '#2563eb', note: '家具常为青色或蓝色；与窗的青色冲突时以图层名为准'},
  hatch: {label: '填充', aci: [8, 9], studio: '#94a3b8', note: '灰色实心多为原有砌体；斜线/网格填充多为新砌'},
  other: {label: '其他', aci: [], studio: '#64748b', note: '未识别的图层或颜色'}
};

export const CATEGORY_KEYS = Object.keys(CAD_CATEGORIES);

// 图层名匹配（中英文、常见缩写）。顺序即优先级：先精确词，再包含词。
export const LAYER_PATTERNS = [
  {category: 'axis', patterns: [/^(axis|轴线|定位轴线|ax)$/i, /轴线/i]},
  {category: 'dimension', patterns: [/^(dim|dimension|尺寸|标注)$/i, /尺寸|标注|dim/i]},
  {category: 'beam', patterns: [/^(beam|梁|梁位|kl|ll)$/i, /梁|beam/i]},
  {category: 'slab', patterns: [/^(slab|floor|楼板|板|楼面)$/i, /楼板|楼面|slab/i]},
  {category: 'stair', patterns: [/^(stair|stairs|楼梯|梯)$/i, /楼梯|stair/i]},
  {category: 'opening', patterns: [/^(opening|hole|洞口|开洞|洞)$/i, /洞口|开洞/i]},
  {category: 'door', patterns: [/^(door|门|doors|drmen|门洞)$/i, /门|door/i]},
  {category: 'window', patterns: [/^(win|window|窗|windows|chuang)$/i, /窗|window/i]},
  {category: 'column', patterns: [/^(col|column|柱|柱网)$/i, /柱/i]},
  {category: 'wall', patterns: [/^(wall|墙|墙体|walls|qiang)$/i, /墙|wall/i]},
  {category: 'furniture', patterns: [/^(furn|furniture|家具|家私|洁具|fixture)$/i, /家具|家私|洁具/i]},
  {category: 'hatch', patterns: [/^(hatch|fill|填充|剖面|pattern)$/i, /填充|剖面/i]},
  {category: 'text', patterns: [/^(text|文字|标注文字|txt)$/i, /文字|注/i]}
];

// 颜色给的是「类别候选」，不是结论：同一个青色既可能是窗也可能是家具。
export function categoriesForAci(aci) {
  const n = Number(aci);
  if (!Number.isFinite(n)) return [];
  return CATEGORY_KEYS.filter(key => (CAD_CATEGORIES[key].aci || []).includes(n));
}

export function categoryForLayer(layer) {
  const name = String(layer || '').trim();
  if (!name || name === '0') return null;
  for (const rule of LAYER_PATTERNS) {
    if (rule.patterns.some(re => re.test(name))) return rule.category;
  }
  return null;
}

// 判定：图层名优先（置信度高），颜色次之（置信度低，且候选可能多个）。
export function classifyEntity({layer, aci} = {}) {
  const byLayer = categoryForLayer(layer);
  if (byLayer) return {category: byLayer, confidence: 0.85, basis: 'layer', candidates: [byLayer]};
  const candidates = categoriesForAci(aci);
  if (candidates.length === 1) return {category: candidates[0], confidence: 0.5, basis: 'aci', candidates};
  if (candidates.length > 1) return {category: null, confidence: 0.25, basis: 'aci-ambiguous', candidates};
  return {category: null, confidence: 0, basis: 'none', candidates: []};
}

// 图元类型本身也带信息：文字/尺寸/块引用不需要看图层。
export function categoryForEntityType(type) {
  const t = String(type || '').toUpperCase();
  if (t === 'TEXT' || t === 'MTEXT' || t === 'ATTRIB') return 'text';
  if (t === 'DIMENSION') return 'dimension';
  if (t === 'INSERT') return 'other';
  return null;
}

export function categoryColor(category) {
  return (CAD_CATEGORIES[category] || CAD_CATEGORIES.other).studio;
}

// studio 用：把整张表变成 {类别: 颜色}，界面与文档取同一份，不另写一套。
export function palette() {
  return Object.fromEntries(CATEGORY_KEYS.map(key => [key, CAD_CATEGORIES[key].studio]));
}

// 项目级覆盖：不同院/不同项目配色不同，允许只覆盖差异项。
export function overrideCategories(base = CAD_CATEGORIES, patch = {}) {
  const problems = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in base)) { problems.push(`未知类别：${key}`); continue; }
    if (value?.studio && !/^#[0-9a-f]{6}$/i.test(value.studio)) problems.push(`${key}.studio 需为 #rrggbb`);
    if (value?.aci && (!Array.isArray(value.aci) || value.aci.some(n => !Number.isInteger(n) || n < 1 || n > 255))) problems.push(`${key}.aci 需为 1–255 的整数数组`);
  }
  if (problems.length) throw new Error(`颜色覆盖不合法：${problems.join('；')}`);
  return Object.fromEntries(Object.entries(base).map(([key, value]) => [key, {...value, ...(patch[key] || {})}]));
}

// 自检：类别唯一、颜色格式正确、没有歧义到无法区分的两套配色。
export function validateCategories(table = CAD_CATEGORIES) {
  const problems = [];
  const seen = new Map();
  for (const [key, value] of Object.entries(table)) {
    if (!value?.label) problems.push(`${key} 缺少 label`);
    if (!/^#[0-9a-f]{6}$/i.test(value?.studio || '')) problems.push(`${key}.studio 需为 #rrggbb`);
    if (!Array.isArray(value?.aci)) problems.push(`${key}.aci 需为数组`);
    if (seen.has(value?.studio)) problems.push(`${key} 与 ${seen.get(value.studio)} 用了同一个颜色`);
    seen.set(value?.studio, key);
  }
  return problems;
}
