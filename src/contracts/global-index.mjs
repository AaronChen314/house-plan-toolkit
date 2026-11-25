// L0 契约：只读全局索引（跨项目检索）。
// 只存摘要：项目 id、名称、路径、各类计数与工具版本。不复制几何，不存文件内容。
// 位置在项目之外，删掉可重建；它不参与发布物，也不进任何项目的 .space/。

export const GLOBAL_INDEX_SCHEMA = 'space-global-index/v1';

export const GLOBAL_RECORD_FIELDS = [
  'projectId', 'name', 'path', 'toolkit', 'updatedAt',
  'entities', 'layers', 'datasets', 'designs', 'documents', 'renders'
];

// 任何几何/文件内容字段都不该出现在这里：这条列表就是隐私边界的自检依据。
export const FORBIDDEN_FIELDS = ['geom', 'geometry', 'points', 'polygon', 'footprint', 'content', 'model'];

export function globalRecord({projectId, name = null, path, toolkit = null, updatedAt, entities = 0, layers = 0, datasets = 0, designs = 0, documents = 0, renders = 0} = {}) {
  return {projectId, name, path, toolkit, updatedAt, entities, layers, datasets, designs, documents, renders};
}

export function validateGlobalRecord(record) {
  const problems = [];
  if (!record || typeof record !== 'object') return ['全局索引记录必须是对象'];
  if (!record.projectId) problems.push('缺少项目 id');
  if (!record.path) problems.push('缺少项目路径');
  for (const field of FORBIDDEN_FIELDS) {
    if (field in record) problems.push(`全局索引不能存几何或内容字段：${field}`);
  }
  for (const field of ['entities', 'layers', 'datasets', 'designs', 'documents', 'renders']) {
    if (!Number.isInteger(record[field]) || record[field] < 0) problems.push(`${field} 需为非负整数`);
  }
  if (!record.updatedAt) problems.push('缺少同步时间');
  return problems;
}

export function normalizeQuery(text) {
  const q = String(text ?? '').trim();
  return q.length > 200 ? q.slice(0, 200) : q;
}
