// L1 领域：cadvec 识别结果 → 结构化数据。
// cadvec 的 cad.json 已经按类型分好了（墙段/门窗/文字/轴线/尺寸），这里只做映射：
// 同一份识别结果同时产出 cad-source/v1（studio 展示用）与 space-model 草稿（下游用）。

export const CADVEC_KINDS = {
  solid: {label: '实心墙（承重）', confidence: 0.92, structure: 'load-bearing'},
  grey: {label: '灰实心墙', confidence: 0.85},
  outline: {label: '双线墙', confidence: 0.72},
  hatch: {label: '填充墙（新砌）', confidence: 0.7}
};

const DOOR_TYPES = ['door', 'double', 'unequal', 'sliding'];
const WINDOW_TYPES = ['window', 'slideWindow'];

const round = (v) => Math.round(v * 10) / 10;

// 墙段：orient='h' 时 a..b 是 x 范围、c 是中心 y；'v' 反之。
export function wallRect(wall) {
  const half = wall.t / 2;
  if (wall.orient === 'h') {
    return [[round(wall.a), round(wall.c - half)], [round(wall.b), round(wall.c - half)],
      [round(wall.b), round(wall.c + half)], [round(wall.a), round(wall.c + half)]];
  }
  return [[round(wall.c - half), round(wall.a)], [round(wall.c - half), round(wall.b)],
    [round(wall.c + half), round(wall.b)], [round(wall.c + half), round(wall.a)]];
}

// 洞口：沿墙方向的 s0..s1，横向按墙厚加一点外扩，便于在图上看出来。
export function openingRect(wall, opening) {
  const half = wall.t / 2 + 40;
  if (wall.orient === 'h') {
    return [[round(opening.s0), round(wall.c - half)], [round(opening.s1), round(wall.c - half)],
      [round(opening.s1), round(wall.c + half)], [round(opening.s0), round(wall.c + half)]];
  }
  return [[round(wall.c - half), round(opening.s0)], [round(wall.c - half), round(opening.s1)],
    [round(wall.c + half), round(opening.s1)], [round(wall.c + half), round(opening.s0)]];
}

export function openingCenter(wall, opening) {
  const mid = (opening.s0 + opening.s1) / 2;
  return wall.orient === 'h' ? [round(mid), round(wall.c)] : [round(wall.c), round(mid)];
}

export function classifyOpening(opening) {
  if (DOOR_TYPES.includes(opening.type)) return 'door';
  if (WINDOW_TYPES.includes(opening.type)) return 'window';
  return 'other';
}

// 结构化实体：墙、门窗、文字、轴线、尺寸，各自带来源与置信度。
export function structuredEntities(cad) {
  const walls = (cad.walls || []).map(wall => ({
    handle: `CV-${wall.id}`,
    rect: wallRect(wall),
    thicknessMm: round(wall.t),
    kind: wall.kind || 'outline',
    provenance: 'cadvec',
    confidence: (CADVEC_KINDS[wall.kind] || {confidence: 0.6}).confidence,
    ...(CADVEC_KINDS[wall.kind]?.structure ? {structure: CADVEC_KINDS[wall.kind].structure} : {})
  }));

  const byId = new Map((cad.walls || []).map(w => [w.id, w]));
  const openings = (cad.openings || [])
    .map(opening => {
      const wall = byId.get(opening.wall);
      if (!wall) return null;
      const kind = classifyOpening(opening);
      return {
        handle: `CO-${opening.id}`,
        kind,
        type: opening.type,
        rect: openingRect(wall, opening),
        center: openingCenter(wall, opening),
        wall: `CV-${wall.id}`,
        span: [round(opening.s0), round(opening.s1)],
        orientation: wall.orient,
        thicknessMm: round(wall.t),
        provenance: 'cadvec',
        confidence: kind === 'other' ? 0.4 : 0.8
      };
    })
    .filter(Boolean);

  const texts = (cad.texts || []).map((text, i) => ({
    handle: `CT-${i}`, text: text.text, at: [round(text.at[0]), round(text.at[1])], provenance: 'cadvec', confidence: 0.9
  }));
  const axes = (cad.axes || []).map((axis, i) => ({handle: `CA-${i}`, ...axis, provenance: 'cadvec'}));
  const dims = (cad.dims || []).map((dim, i) => ({handle: `CD-${i}`, ...dim, provenance: 'cadvec'}));
  const structs = (cad.structs || []).map((s, i) => ({handle: `CS-${i}`, ...s, provenance: 'cadvec'}));

  return {walls, openings, texts, axes, dims, structs};
}

// cad-source/v1：studio 能直接画的线稿（墙/门窗/文字/轴线）。
export function toCadSource(cad, {sourceFile = 'cadvec', underlay = null} = {}) {
  const {walls, openings, texts, axes} = structuredEntities(cad);
  const entities = [];
  for (const wall of walls) {
    entities.push({id: wall.handle, handle: wall.handle, type: 'POLYLINE', layer: 'WALL', points: wall.rect, confidence: wall.confidence, provenance: wall.provenance});
  }
  for (const opening of openings) {
    const layer = opening.kind === 'door' ? 'DOOR' : opening.kind === 'window' ? 'WINDOW' : 'OPENING';
    entities.push({id: opening.handle, handle: opening.handle, type: 'POLYLINE', layer, points: opening.rect, confidence: opening.confidence, provenance: opening.provenance});
  }
  for (const text of texts) {
    entities.push({id: text.handle, handle: text.handle, type: 'TEXT', layer: 'TEXT', text: text.text, at: text.at, height: 200, provenance: text.provenance});
  }
  for (const axis of axes) {
    entities.push({id: axis.handle, handle: axis.handle, type: 'AXIS', layer: 'AXIS', at: axis.at ?? null, provenance: axis.provenance});
  }
  return {
    schema: 'cad-source/v1',
    source: {file: sourceFile, units: 'mm', mmPerUnit: cad.mmPerUnit ?? null, scaleFrom: cad.scale_from ?? null, underlay},
    entities,
    issues: [],
    stats: {walls: walls.length, doors: openings.filter(o => o.kind === 'door').length, windows: openings.filter(o => o.kind === 'window').length, texts: texts.length, axes: axes.length}
  };
}

// space-model 草稿：墙进模型的 walls，门窗进 doors/windowOpenings。
// 竖向值是识别不出来的，按预览值写入并由调用方记为假设。
export function toModelDraft(cad, {floor = 'ground', height = 2800, clearHeight = 3000} = {}) {
  const {walls, openings} = structuredEntities(cad);
  const doors = openings.filter(o => o.kind === 'door').map(o => ({
    id: o.handle,
    kind: 'door',
    handle: o.handle,
    hinge: o.rect[0],
    closedEnd: o.rect[1],
    openEnd: o.rect[2],
    heightMm: 2100,
    thicknessMm: o.thicknessMm,
    provenance: 'cadvec',
    confidence: o.confidence
  }));
  const windows = openings.filter(o => o.kind === 'window').map(o => ({
    id: o.handle,
    kind: 'window',
    handle: o.handle,
    // space-model 的窗 footprint 是单个多边形，不是多边形数组。
    footprint: {outer: o.rect, holes: []},
    sillMm: 900,
    headMm: 2400,
    provenance: 'cadvec',
    confidence: o.confidence
  }));
  return {
    schema: 'space-model/v1',
    units: 'mm',
    projectId: null,
    defaults: {slab: 150},
    floors: [{
      id: floor,
      name: '首层（识别草稿）',
      elevation: 0,
      clearHeight,
      wallHeight: height,
      slabThickness: 150,
      slab: [], columns: [], outdoor: [], roofSlab: [], treads: [], guards: [], walkEntries: [], ceilingZones: [], furniture: [],
      walls: walls.map(w => ({handle: w.handle, polygon: {outer: w.rect}, thicknessMm: w.thicknessMm, provenance: w.provenance, confidence: w.confidence, ...(w.structure ? {structure: w.structure} : {})})),
      doors,
      windowOpenings: windows,
      trace: []
    }],
    notes: ['由 cadvec 识别生成；门窗尺寸与竖向值按预览值写入，需人工确认']
  };
}

export function recognitionSummary(cad) {
  const s = toCadSource(cad).stats;
  return `识别：墙 ${s.walls} · 门 ${s.doors} · 窗 ${s.windows} · 文字 ${s.texts} · 轴线 ${s.axes}`;
}
