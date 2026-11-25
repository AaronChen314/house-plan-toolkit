// L3 能力：设计版本。方案与版本是权威数据（data/designs/），只经 ctx.store 写。
//
// 三条记录方式必须分开（见 src/contracts/graph.mjs）：
//   版本链   同一方案的第 N 次修改，用版本文件里的 parent 指向上一个 seq；
//   复制     design.fork 在新方案 001 里记 forkedFrom，之后两边互不影响；
//   派生边   设计之间不允许派生，也不写边——图的投影由图内核 lane 负责。
// 状态权威在版本文件里：design.json 的版本清单只是目录，两处一起更新，避免读到过期状态。
import {canTransition, datasetFile, designFile, designVersionFile} from '../contracts/graph.mjs';
import {
  DATASET_SCHEMA,
  currentVersion,
  designVersion,
  emptyDesign,
  nextSeq,
  validateDataset,
  validateDesign,
  validateDesignVersion
} from '../contracts/datasets.mjs';
import {withStatus} from '../domain/datasets.mjs';
import {fail} from '../contracts/errors.mjs';

// 构件清单：允许逗号或空格分隔，去重排序由契约的 normalizeUses 兜住。
function parseUses(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value;
  return String(value).split(/[,\s]+/).filter(Boolean);
}

// 方案 / 数据集 id 的合法性由契约定；契约抛的是普通 Error，这里统一转成参数错误。
function relOf(fn) {
  try {
    return fn();
  } catch (e) {
    throw fail('E_EXEC_PARAM', e.message);
  }
}

// 校验失败按 schema 与内容分两种码：schema 对不上是契约问题，其余是数据问题。
function rejectProblems(problems, label) {
  if (!problems.length) return;
  const schemaIssue = problems.some(p => p.includes('schema 应为'));
  throw fail(schemaIssue ? 'E_DATA_SCHEMA' : 'E_DATA_INVALID', `${label}：${problems.join('；')}`, {problems});
}

// design.json 里的目录项：不重复存 dataVersion 的 payload，只留定位与状态。
function catalogEntry(version) {
  return {
    seq: version.seq,
    status: version.status,
    at: version.createdAt,
    ...(version.note ? {note: version.note} : {}),
    ...(version.forkedFrom ? {forkedFrom: version.forkedFrom} : {})
  };
}

function requireVersion(ctx, scheme, seq) {
  const rel = relOf(() => designVersionFile(scheme, seq));
  const baseHash = ctx.store.hashOf(rel);
  if (!baseHash) throw fail('E_DATA_REFERENCE', `版本不存在：${scheme}#${seq}（${rel}）`);
  const version = ctx.store.readJson(rel);
  rejectProblems(validateDesignVersion(version), rel);
  return {rel, baseHash, version};
}

// 状态迁移：权威在版本文件，先写它，再同步 design.json 的目录项。
async function transition(ctx, {scheme, seq, to}) {
  const {rel, baseHash, version} = requireVersion(ctx, scheme, Number(seq));
  if (!canTransition(version.status, to)) {
    throw fail('E_DATA_RULE', `状态机拒绝 ${version.status} → ${to}：${scheme}#${version.seq}`);
  }
  const next = withStatus(version, to);
  ctx.store.writeData(rel, next, {baseHash, confirm: true});

  const designRel = relOf(() => designFile(scheme));
  const designHash = ctx.store.hashOf(designRel);
  if (designHash) {
    const design = ctx.store.readJson(designRel);
    const index = (design.versions || []).findIndex(v => v.seq === version.seq);
    if (index >= 0) {
      const versions = design.versions.map((v, i) => (i === index ? {...v, status: to, at: next.statusChangedAt} : v));
      const updated = {...design, versions};
      rejectProblems(validateDesign(updated), designRel);
      ctx.store.writeData(designRel, updated, {baseHash: designHash, confirm: true});
    }
  }
  return {rel, version: next};
}

export const capabilities = [
  {
    id: 'design.create',
    version: '1.0.0',
    stage: 'design',
    title: '新建设计方案',
    description: '引用一份已校验的数据集，建立方案与 001 草稿版本。',
    params: [
      {key: 'scheme', label: '方案 id', type: 'text', required: true},
      {key: 'dataset', label: '数据集 id', type: 'text', required: true},
      {key: 'uses', label: '用到的构件（handle，逗号分隔；留空表示依赖整个数据集）', type: 'text'}
    ],
    inputs: {dataset: 'space-dataset/v1'},
    outputs: {design: 'space-design/v1', version: 'space-design-version/v1'},
    sideEffects: ['write:data'],
    requires: [],
    idempotent: false,
    errors: [
      'E_EXEC_PARAM', 'E_DATA_SCHEMA', 'E_DATA_INVALID', 'E_DATA_REFERENCE',
      'E_STORE_CONFLICT', 'E_STORE_LOCK_REQUIRED', 'E_DATA_CONFIRM_REQUIRED', 'E_STORE_PATH', 'E_STORE_IO'
    ],
    async run(ctx, {scheme, dataset, uses}) {
      const designRel = relOf(() => designFile(scheme));
      const versionRel = relOf(() => designVersionFile(scheme, 1));
      if (typeof dataset !== 'string' || !dataset.trim()) throw fail('E_EXEC_PARAM', '缺少数据集 id');
      const dsRel = relOf(() => datasetFile(dataset));

      if (!ctx.store.exists(dsRel)) throw fail('E_DATA_REFERENCE', `数据集不存在：${dataset}（${dsRel}）`);
      const ds = ctx.store.readJson(dsRel);
      if (ds?.schema !== DATASET_SCHEMA) throw fail('E_DATA_SCHEMA', `${dsRel} 不是 ${DATASET_SCHEMA}`);
      rejectProblems(validateDataset(ds), dsRel);

      const design = emptyDesign({scheme, dataset});
      const version = designVersion({scheme, seq: 1, dataset, status: 'draft', uses: parseUses(uses)});
      rejectProblems(validateDesignVersion(version), versionRel);
      design.versions.push(catalogEntry(version));
      rejectProblems(validateDesign(design), designRel);

      // 先写清单再写版本文件：方案已存在时第一步就以 E_STORE_CONFLICT 拒绝，不留孤儿版本。
      ctx.store.writeData(designRel, design, {baseHash: null, confirm: true});
      ctx.store.writeData(versionRel, version, {baseHash: null, confirm: true});

      return {
        summary: `${scheme}#001（数据集 ${dataset}）`,
        outputs: [
          {path: designRel, kind: 'design'},
          {path: versionRel, kind: 'design-version'}
        ],
        data: {scheme, dataset, seq: 1, status: 'draft', uses: version.uses, designFile: designRel, versionFile: versionRel}
      };
    }
  },
  {
    id: 'design.version',
    version: '1.0.0',
    stage: 'design',
    title: '新增设计版本',
    description: '沿同一方案的版本链递增序号，parent 指向上一个版本，状态为草稿。',
    params: [
      {key: 'scheme', label: '方案 id', type: 'text', required: true},
      {key: 'note', label: '版本说明', type: 'text'},
      {key: 'uses', label: '用到的构件（留空则继承上一版本）', type: 'text'}
    ],
    inputs: {design: 'space-design/v1'},
    outputs: {design: 'space-design/v1', version: 'space-design-version/v1'},
    sideEffects: ['write:data'],
    requires: [],
    idempotent: false,
    errors: [
      'E_EXEC_PARAM', 'E_DATA_SCHEMA', 'E_DATA_INVALID', 'E_DATA_REFERENCE',
      'E_STORE_CONFLICT', 'E_STORE_LOCK_REQUIRED', 'E_DATA_CONFIRM_REQUIRED', 'E_STORE_PATH', 'E_STORE_IO'
    ],
    async run(ctx, {scheme, note = '', uses}) {
      const designRel = relOf(() => designFile(scheme));
      // 读取时记录基准哈希，写入时带回去：并发改动由存储层报 E_STORE_CONFLICT，不静默覆盖。
      const baseHash = ctx.store.hashOf(designRel);
      if (!baseHash) throw fail('E_DATA_REFERENCE', `方案不存在：${scheme}（${designRel}）`);
      const design = ctx.store.readJson(designRel);
      rejectProblems(validateDesign(design), designRel);

      const seq = nextSeq(design);
      const previous = currentVersion(design);
      const parent = previous?.seq ?? null;
      const versionRel = relOf(() => designVersionFile(scheme, seq));
      // 没有显式给 uses 时继承上一版本（读版本文件，catalog 里不带 uses）。
      const previousRel = parent == null ? null : relOf(() => designVersionFile(scheme, parent));
      const inherited = previousRel && ctx.store.exists(previousRel) ? (ctx.store.readJson(previousRel).uses ?? []) : [];
      const version = designVersion({
        scheme, seq, dataset: design.dataset, parent, status: 'draft', note,
        uses: uses === undefined ? inherited : parseUses(uses)
      });
      rejectProblems(validateDesignVersion(version), versionRel);

      const updated = {...design, versions: [...design.versions, catalogEntry(version)]};
      rejectProblems(validateDesign(updated), designRel);
      ctx.store.writeData(designRel, updated, {baseHash, confirm: true});
      // 版本文件是新建文件，基准哈希必须是 null：同名序号已存在时要报冲突，不能覆盖历史。
      ctx.store.writeData(versionRel, version, {baseHash: null, confirm: true});

      return {
        summary: `${scheme}#${String(seq).padStart(3, '0')}${parent ? `（承接 #${String(parent).padStart(3, '0')}）` : ''}`,
        outputs: [
          {path: designRel, kind: 'design'},
          {path: versionRel, kind: 'design-version'}
        ],
        data: {scheme, seq, parent, status: 'draft', dataset: design.dataset, uses: version.uses, versionFile: versionRel}
      };
    }
  },
  {
    id: 'design.fork',
    version: '1.0.0',
    stage: 'design',
    title: '复制设计方案',
    description: '从某个方案的某一版抄一份，新方案从 001 重新开始，只记录来源。',
    params: [
      {key: 'from', label: '来源（方案#版本）', type: 'text', required: true},
      {key: 'scheme', label: '新方案 id', type: 'text', required: true}
    ],
    inputs: {version: 'space-design-version/v1'},
    outputs: {design: 'space-design/v1', version: 'space-design-version/v1'},
    sideEffects: ['write:data'],
    requires: [],
    idempotent: false,
    errors: [
      'E_EXEC_PARAM', 'E_DATA_SCHEMA', 'E_DATA_INVALID', 'E_DATA_REFERENCE',
      'E_STORE_CONFLICT', 'E_STORE_LOCK_REQUIRED', 'E_DATA_CONFIRM_REQUIRED', 'E_STORE_PATH', 'E_STORE_IO'
    ],
    async run(ctx, {from, scheme}) {
      const source = parseForkFrom(from);
      const sourceRel = relOf(() => designVersionFile(source.scheme, source.seq));
      if (!ctx.store.exists(sourceRel)) {
        throw fail('E_DATA_REFERENCE', `来源版本不存在：${source.scheme}#${source.seq}（${sourceRel}）`);
      }
      const sourceVersion = ctx.store.readJson(sourceRel);
      rejectProblems(validateDesignVersion(sourceVersion), sourceRel);

      // 版本文件可能没写 dataset（历史数据），退回来源方案的 design.json。
      const sourceDesignRel = relOf(() => designFile(source.scheme));
      const sourceDesign = ctx.store.exists(sourceDesignRel) ? ctx.store.readJson(sourceDesignRel) : null;
      const dataset = sourceVersion.dataset || sourceDesign?.dataset || null;
      if (!dataset) throw fail('E_DATA_REFERENCE', `来源版本未记录数据集：${source.scheme}#${source.seq}`);
      const dsRel = relOf(() => datasetFile(dataset));
      if (!ctx.store.exists(dsRel)) throw fail('E_DATA_REFERENCE', `数据集不存在：${dataset}（${dsRel}）`);

      const designRel = relOf(() => designFile(scheme));
      const versionRel = relOf(() => designVersionFile(scheme, 1));
      const design = emptyDesign({scheme, dataset});
      // 复制只记录来源：forkedFrom 指向抄自哪一版，parent 为 null——副本自己从 001 起链。
      // 这里不写任何 edge（role='fork' 的图投影由图内核 lane 负责），复制不传播失效。
      const version = designVersion({
        scheme,
        seq: 1,
        dataset,
        parent: null,
        forkedFrom: {scheme: source.scheme, seq: source.seq},
        status: 'draft',
        note: `复制自 ${source.scheme}#${String(source.seq).padStart(3, '0')}`
      });
      rejectProblems(validateDesignVersion(version), versionRel);
      design.versions.push(catalogEntry(version));
      rejectProblems(validateDesign(design), designRel);

      ctx.store.writeData(designRel, design, {baseHash: null, confirm: true});
      ctx.store.writeData(versionRel, version, {baseHash: null, confirm: true});

      return {
        summary: `${scheme}#001 复制自 ${source.scheme}#${String(source.seq).padStart(3, '0')}`,
        outputs: [
          {path: designRel, kind: 'design'},
          {path: versionRel, kind: 'design-version'}
        ],
        data: {scheme, seq: 1, dataset, forkedFrom: {scheme: source.scheme, seq: source.seq}, status: 'draft', versionFile: versionRel}
      };
    }
  },
  {
    id: 'design.confirm',
    version: '1.0.0',
    stage: 'design',
    title: '确认设计版本',
    description: '按状态机把草稿或已失效的版本改为已确认，只改状态不重算。',
    params: [
      {key: 'scheme', label: '方案 id', type: 'text', required: true},
      {key: 'seq', label: '版本号', type: 'number', required: true}
    ],
    inputs: {version: 'space-design-version/v1'},
    outputs: {version: 'space-design-version/v1', design: 'space-design/v1'},
    sideEffects: ['write:data'],
    requires: [],
    idempotent: false,
    errors: [
      'E_EXEC_PARAM', 'E_DATA_SCHEMA', 'E_DATA_INVALID', 'E_DATA_REFERENCE', 'E_DATA_RULE',
      'E_STORE_CONFLICT', 'E_STORE_LOCK_REQUIRED', 'E_DATA_CONFIRM_REQUIRED', 'E_STORE_PATH', 'E_STORE_IO'
    ],
    async run(ctx, {scheme, seq}) {
      const {rel, version} = await transition(ctx, {scheme, seq, to: 'confirmed'});
      return {
        summary: `${scheme}#${String(version.seq).padStart(3, '0')} 已确认`,
        outputs: [{path: rel, kind: 'design-version'}],
        data: {scheme, seq: version.seq, status: version.status}
      };
    }
  },
  {
    id: 'design.stale',
    version: '1.0.0',
    stage: 'design',
    title: '标记设计待复核',
    description: '上游变化后把已确认的版本标为待复核：只改状态，不删除、不自动重算。',
    params: [
      {key: 'scheme', label: '方案 id', type: 'text', required: true},
      {key: 'seq', label: '版本号', type: 'number', required: true}
    ],
    inputs: {version: 'space-design-version/v1'},
    outputs: {version: 'space-design-version/v1', design: 'space-design/v1'},
    sideEffects: ['write:data'],
    requires: [],
    idempotent: false,
    errors: [
      'E_EXEC_PARAM', 'E_DATA_SCHEMA', 'E_DATA_INVALID', 'E_DATA_REFERENCE', 'E_DATA_RULE',
      'E_STORE_CONFLICT', 'E_STORE_LOCK_REQUIRED', 'E_DATA_CONFIRM_REQUIRED', 'E_STORE_PATH', 'E_STORE_IO'
    ],
    async run(ctx, {scheme, seq}) {
      const {rel, version} = await transition(ctx, {scheme, seq, to: 'stale'});
      return {
        summary: `${scheme}#${String(version.seq).padStart(3, '0')} 待复核`,
        outputs: [{path: rel, kind: 'design-version'}],
        data: {scheme, seq: version.seq, status: version.status}
      };
    }
  }
];

// 'scheme#seq' 字符串与 {scheme, seq} 两种写法都接受；其它一律参数错误。
export function parseForkFrom(from) {
  if (from && typeof from === 'object' && !Array.isArray(from)) {
    const seq = Number(from.seq);
    if (typeof from.scheme !== 'string' || !from.scheme.trim()) throw fail('E_EXEC_PARAM', 'from 缺少 scheme');
    if (!Number.isInteger(seq) || seq < 1) throw fail('E_EXEC_PARAM', `from.seq 需为正整数：${from.seq}`);
    return {scheme: from.scheme.trim(), seq};
  }
  const m = /^([^#\s]+)#(\d+)$/.exec(String(from ?? '').trim());
  if (!m) throw fail('E_EXEC_PARAM', `from 需为「方案#版本」或 {scheme, seq}：${from}`);
  const seq = Number(m[2]);
  if (seq < 1) throw fail('E_EXEC_PARAM', `版本号需为正整数：${m[2]}`);
  return {scheme: m[1], seq};
}
