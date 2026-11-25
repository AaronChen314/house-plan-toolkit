// L0 契约：数据 schema 登记表。版本号独立演进，与工具包版本无关。
// 每条登记指向 schemas/ 下的定义文件；新增 schema 必须先在此登记，才能被能力引用。

export const SCHEMAS = [
  {id: 'space-project/v1', file: 'schemas/project.schema.json', role: 'authoritative', description: '项目配置'},
  {id: 'space-model/v1', file: 'schemas/space-model.schema.json', role: 'authoritative', description: '空间模型（楼层、构件、竖向关系）'},
  {id: 'design-sync/v1', file: 'schemas/design-sync.schema.json', role: 'authoritative', description: '设计到三维的同步清单'},
  {id: 'cad-source/v1', file: null, role: 'derived', description: 'DXF 图元索引（解析产物，可重建）'},
  {id: 'space-dataset/v1', file: null, role: 'authoritative', description: '数据集与确认记录（data/datasets/<id>/dataset.json）'},
  {id: 'space-design/v1', file: null, role: 'authoritative', description: '设计方案，引用一个数据集（data/designs/<方案>/design.json）'},
  {id: 'space-design-version/v1', file: null, role: 'authoritative', description: '设计版本，同一条链（data/designs/<方案>/versions/<seq>.json）'},
  {id: 'space-sheet/v1', file: null, role: 'derived', description: '施工图图面数据（渲染前）'},
  {id: 'space-doc/v1', file: null, role: 'derived', description: '交付物记录（清单条目）'},
  {id: 'space-doc-manifest/v1', file: null, role: 'derived', description: '交付清单（output/doc/manifest.json）'},
  {id: 'space-render/v1', file: null, role: 'derived', description: '渲染记录（output/render/<图种>/<方案>-<版本>.json）'},
  {id: 'space-bundle/v1', file: null, role: 'derived', description: '交付包清单（output/bundle/<名>/manifest.json）'},
  {id: 'space-snapshot/v1', file: null, role: 'derived', description: '只读快照记录（output/snapshot/<名>.json）'},
  {id: 'space-lock/v1', file: null, role: 'authoritative', description: '项目版本锁与数据指纹'},
  {id: 'space-files/v1', file: null, role: 'derived', description: '存储层文件登记（.space/files.json）'},
  {id: 'space-events/v1', file: null, role: 'derived', description: '存储层事件日志（.space/events.jsonl）'},
  {id: 'space-index/v1', file: null, role: 'derived', description: '几何索引（.space/project.sqlite，M1）'}
];

export const SCHEMA_IDS = SCHEMAS.map(s => s.id);
export const SCHEMA_SET = new Set(SCHEMA_IDS);
export const AUTHORITATIVE_SCHEMAS = SCHEMAS.filter(s => s.role === 'authoritative').map(s => s.id);

// 兼容窗口：同一大版本下相邻小版本可读。
export function parseSchemaVersion(id) {
  const m = /^([a-z0-9-]+)\/v(\d+)$/.exec(String(id || ''));
  return m ? {name: m[1], version: Number(m[2])} : null;
}

export function schemaCompatible(declared, supported) {
  const a = parseSchemaVersion(declared), b = parseSchemaVersion(supported);
  if (!a || !b) return false;
  return a.name === b.name && Math.abs(a.version - b.version) <= 1;
}

export function requireSchema(declared, supported) {
  if (declared === supported) return declared;
  if (!SCHEMA_SET.has(supported)) throw new Error(`未登记的 schema：${supported}`);
  if (!schemaCompatible(declared, supported)) throw new Error(`schema 不兼容：读到 ${declared}，支持 ${supported}`);
  return declared;
}
