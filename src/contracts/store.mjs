// L0 契约：存储接口。实现可以替换（文件存储、只读交付包、未来的数据库权威模式），
// 调用方只依赖这些方法签名与不变量。

// 写入模式决定权限与锁要求：
// - artifact：派生物，默认允许，不需要基准哈希（output/ 或可重建目录）。
// - data：权威数据，必须带基准哈希与确认，否则拒绝。
export const WRITE_MODES = ['artifact', 'data'];

export const STORE_DIR = '.space';
export const FILES_REGISTRY = '.space/files.json';
export const EVENT_LOG = '.space/events.jsonl';
export const OBJECT_DIR = '.space/objects';
export const STAGING_DIR = '.space/tmp';

export const EVENT_TYPES = ['op', 'write', 'derived', 'verify', 'rebuild'];

// 派生存储：写在 .space/ 内部的高频小事务库（索引、解析缓存）。
// 它们自己管文件（SQLite 要 WAL），存储层只管位置、项目锁与一条汇总事件——
// 不能按 artifact 处理：每次写都哈希整个库既慢又会把事件日志冲爆。
export const DERIVED_STORES = [
  {name: 'index', path: '.space/project.sqlite', description: '几何索引（M1）'},
  {name: 'cache', path: '.space/cache', description: '解析缓存（M1）'}
];

export const DERIVED_NAMES = DERIVED_STORES.map(d => d.name);

export function derivedSpec(name) {
  return DERIVED_STORES.find(d => d.name === name) || null;
}

// 方法清单：kind 用于静态核对——读方法不得写，写方法必须进事件日志。
export const STORE_METHODS = [
  {name: 'rel', kind: 'query', signature: '(abs) => string'},
  {name: 'resolve', kind: 'query', signature: '(rel) => string'},
  {name: 'exists', kind: 'query', signature: '(rel) => boolean'},
  {name: 'readText', kind: 'read', signature: '(rel) => string'},
  {name: 'readJson', kind: 'read', signature: '(rel) => object'},
  {name: 'readBuffer', kind: 'read', signature: '(rel) => Buffer'},
  {name: 'hashOf', kind: 'read', signature: '(rel) => string | null'},
  {name: 'staging', kind: 'query', signature: '() => string'},
  {name: 'writeArtifact', kind: 'write', signature: '(rel, content, opts) => WriteResult'},
  {name: 'writeData', kind: 'write', signature: '(rel, content, opts) => WriteResult'},
  {name: 'ingest', kind: 'write', signature: '(stagingDir, relDir, opts) => WriteResult[]'},
  {name: 'putObject', kind: 'write', signature: '(buffer, opts) => {sha256, rel}'},
  {name: 'getObject', kind: 'read', signature: '(sha256) => Buffer | null'},
  {name: 'events', kind: 'read', signature: '(opts) => Event[]'},
  {name: 'files', kind: 'query', signature: '() => object'},
  {name: 'operation', kind: 'write', signature: '(event) => Event'},
  {name: 'derived', kind: 'write', signature: '(name) => DerivedHandle'},
  {name: 'verify', kind: 'query', signature: '() => VerifyReport'},
  {name: 'rebuild', kind: 'write', signature: '(opts) => RebuildReport'}
];

export const STORE_METHOD_NAMES = STORE_METHODS.map(m => m.name);

// 不变量（由 tests/store.test.mjs 与 space store verify 共同核对）：
// 1. 任何写入都经临时文件加改名完成，中断只留可清理的临时文件，不留半截目标文件。
// 2. writeData 必须传 baseHash；与磁盘现状不一致即拒绝，不做隐式覆盖。
// 3. 每次写入追加一条 write 事件，载明路径、模式、哈希与操作者。
// 4. 写入路径必须落在项目内；权威目录（source/、data/、docs/）只能走 writeData。
// 5. 派生物与对象缓存可删可重建；删除 .space/ 不影响项目可用性。
// 6. 事件日志只追加，不重写；重建只补登记，不改历史。
// 7. 派生存储只能落在 .space/ 内；每次提交记一条汇总事件（位置、大小、计数），不逐行记录，
//    也不进文件登记——删掉 .space/ 必须能原样重建。
export const STORE_INVARIANTS = [
  'atomic-write',
  'base-hash-required',
  'one-event-per-write',
  'inside-project',
  'authoritative-needs-data-mode',
  'rebuildable-index',
  'append-only-events',
  'derived-summary-events'
];

// 权威目录：这些路径下的文件只能通过 writeData 写入。
export const AUTHORITATIVE_ROOTS = ['source', 'data', 'docs', 'checks'];
// 派生物目录：writeArtifact 默认落点。
export const ARTIFACT_ROOTS = ['output'];

// 项目根上的权威文件：只能经 writeData 写入。
export const AUTHORITATIVE_FILES = ['project.json', 'space.lock.json'];

export function writeModeFor(rel) {
  const posix = String(rel);
  if (AUTHORITATIVE_FILES.includes(posix)) return 'data';
  const top = posix.split('/')[0];
  if (ARTIFACT_ROOTS.includes(top)) return 'artifact';
  if (AUTHORITATIVE_ROOTS.includes(top)) return 'data';
  return 'artifact';
}

// 派生物不能落在权威位置：能力声明 write:artifact 时由这里拒绝。
export function artifactBlocked(rel) {
  const posix = String(rel);
  if (AUTHORITATIVE_FILES.includes(posix)) return true;
  return AUTHORITATIVE_ROOTS.includes(posix.split('/')[0]);
}

export function assertStoreInterface(store) {
  const missing = STORE_METHOD_NAMES.filter(name => typeof store?.[name] !== 'function');
  if (missing.length) throw new Error(`存储实现缺少方法：${missing.join('、')}`);
  return true;
}
