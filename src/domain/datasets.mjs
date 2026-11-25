// L1 领域：数据集与设计版本的纯逻辑。读写由能力层负责，这里只判断与比较。
import {DESIGN_STATUSES} from '../contracts/datasets.mjs';

// 同一份数据集版本内的确认记录查找：object + field 唯一。
export function confirmationKey(entry) {
  return `${entry?.object}::${entry?.field}`;
}

export function confirmedValue(dataset, object, field) {
  const hit = (dataset?.confirmations || []).find(c => c.object === object && c.field === field);
  return hit ? hit.value : undefined;
}

export function hasConfirmation(dataset, object, field) {
  return confirmedValue(dataset, object, field) !== undefined;
}

// 失效标记：只改状态，不删记录、不重算值。
export function withStatus(record, status) {
  if (!DESIGN_STATUSES.includes(status)) throw new Error(`未知状态：${status}`);
  return {...record, status, statusChangedAt: new Date().toISOString()};
}

// 构件级影响：设计版本声明用到哪些 handle，校正后据此判断是否受影响。
// uses 为空表示依赖整个数据集——宁可多复核，不漏。
export function matchesChanged(uses, changedHandles) {
  const own = (uses || []).filter(Boolean);
  const changed = new Set((changedHandles || []).filter(Boolean));
  if (!own.length) return {affected: changed.size > 0, matched: [], reason: 'depends-on-dataset'};
  const matched = own.filter(handle => changed.has(handle)).sort();
  return {affected: matched.length > 0, matched, reason: matched.length ? 'touches-changed' : 'untouched'};
}

// 数据集差异：按 sources 与确认记录比较，用于 dataset.diff 的元数据部分。
// 图元级差异由能力层用索引或 cad-source 计算，这里只管记录层。
export function diffRecords(a, b) {
  const mapOf = (list, keyFn) => new Map((list || []).map(item => [keyFn(item), item]));
  const compare = (x, y, label) => {
    const left = mapOf(x, label.key), right = mapOf(y, label.key);
    const added = [...right.keys()].filter(k => !left.has(k)).sort();
    const removed = [...left.keys()].filter(k => !right.has(k)).sort();
    const changed = [...left.keys()].filter(k => right.has(k) && JSON.stringify(left.get(k)) !== JSON.stringify(right.get(k))).sort();
    return {added, removed, changed};
  };
  return {
    sources: compare(a?.sources, b?.sources, {key: (s) => `${s?.file}::${s?.sha256 ?? ''}`}),
    assumptions: compare(a?.assumptions, b?.assumptions, {key: confirmationKey}),
    confirmations: compare(a?.confirmations, b?.confirmations, {key: confirmationKey})
  };
}
