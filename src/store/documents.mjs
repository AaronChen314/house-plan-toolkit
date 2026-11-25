// L2 存储：交付清单与施工图产物的读写。清单是派生物，写在 output/doc/ 下。
import {validateDeliverable, validateManifest, docManifestFile, manifest as emptyManifest} from '../contracts/documents.mjs';
import {fail} from '../contracts/errors.mjs';

function stableDocs(docs) {
  return Object.fromEntries(Object.keys(docs || {}).sort().map(key => [key, docs[key]]));
}

// 清单字节必须稳定：键排序、无随机字段，重复生成才有可比哈希。
export function manifestText(value) {
  return JSON.stringify({...value, docs: stableDocs(value?.docs)}, null, 2) + '\n';
}

export function readManifest(store) {
  const rel = docManifestFile();
  if (!store.exists(rel)) return emptyManifest({});
  try {
    const value = store.readJson(rel);
    return value?.schema === emptyManifest({}).schema ? value : emptyManifest({});
  } catch {
    return emptyManifest({});
  }
}

export function writeManifest(store, value, {baseHash, op = 'doc.manifest'} = {}) {
  const problems = validateManifest(value);
  if (problems.length) throw fail('E_DATA_INVALID', `交付清单不合法：${problems.join('；')}`, {problems});
  const rel = docManifestFile();
  const base = baseHash === undefined ? store.hashOf(rel) : baseHash;
  const written = store.writeArtifact(rel, manifestText(value), {kind: 'json', op});
  return {...written, baseHash: base};
}

// 写一张图：产物先落盘，再登记清单条目。产物内容相同则不重写。
export function putDeliverable(store, {file, content, record, op = 'doc.render'} = {}) {
  const problems = validateDeliverable(record);
  if (problems.length) throw fail('E_DATA_INVALID', `交付物记录不合法：${problems.join('；')}`, {problems});
  if (record.file !== file) throw fail('E_DATA_INVALID', `记录路径与写入路径不一致：${record.file} ≠ ${file}`);
  const written = store.writeArtifact(file, content, {kind: 'drawing', op});
  return {...written, record: {...record, sha256: written.sha256, bytes: written.size}};
}
