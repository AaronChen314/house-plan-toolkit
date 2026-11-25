// L1 领域：交付物与交付清单的纯逻辑。
// 失效判定只看「记录的输入」与「当前文件」，不读磁盘、不写清单。
import {DOC_KINDS, docKey, manifest, validateDeliverable} from '../contracts/documents.mjs';

// 记录里的输入是否已经过期：设计版本换了、状态变了、确认值变了都算。
export function staleReasonOf(record, live = {}) {
  const recorded = record?.inputs || {};
  const reasons = [];

  if (live.design) {
    if (live.design.sha256 && recorded.design?.sha256 && live.design.sha256 !== recorded.design.sha256) {
      reasons.push(`设计版本文件已变化（记录 ${recorded.design.sha256.slice(0, 8)} → 当前 ${live.design.sha256.slice(0, 8)}）`);
    }
    if (live.design.status && live.design.status !== 'draft' && recorded.design?.status && live.design.status !== recorded.design.status) {
      reasons.push(`设计版本状态 ${recorded.design.status} → ${live.design.status}`);
    }
    if (live.design.status === 'stale') reasons.push('设计版本已标待复核');
  }

  if (live.dataset?.sha256 && recorded.dataset?.sha256 && live.dataset.sha256 !== recorded.dataset.sha256) {
    reasons.push('数据集文件已变化');
  }
  if (live.model?.sha256 && recorded.model?.sha256 && live.model.sha256 !== recorded.model.sha256) {
    reasons.push('空间模型已变化');
  }

  const recordedConfirmations = recorded.confirmations || [];
  if (Array.isArray(live.confirmations)) {
    const key = (c) => `${c.object}::${c.field}`;
    const current = new Map(live.confirmations.map(c => [key(c), JSON.stringify(c.value ?? (c.invalid ? 'invalid' : null))]));
    for (const c of recordedConfirmations) {
      const now = current.get(key(c));
      const was = JSON.stringify(c.value ?? (c.invalid ? 'invalid' : null));
      if (now !== undefined && now !== was) reasons.push(`确认值已变：${key(c)}`);
      if (now === undefined) reasons.push(`确认记录已不存在：${key(c)}`);
    }
  }

  return reasons;
}

// 只改状态，不覆盖产物：施工图过期要标待复核，由人决定是否重出。
export function withStaleness(record, live = {}) {
  const reasons = staleReasonOf(record, live);
  if (!reasons.length) {
    return record.status === 'stale' ? {...record, status: 'generated', staleReason: null} : record;
  }
  return {...record, status: 'stale', staleReason: reasons.join('；')};
}

export function upsertDoc(currentManifest, record, {at} = {}) {
  const problems = validateDeliverable(record);
  if (problems.length) throw new Error(`交付物记录不合法：${problems.join('；')}`);
  const base = currentManifest?.schema ? currentManifest : manifest({});
  const key = docKey({kind: record.kind, scheme: record.inputs.design.scheme, seq: record.inputs.design.seq});
  return {
    ...base,
    updatedAt: at ?? base.updatedAt ?? null,
    docs: {...(base.docs || {}), [key]: record}
  };
}

// 清单摘要：工作台与 CLI 共用一句话结论。
export function summarizeManifest(value) {
  const docs = Object.values(value?.docs || {});
  const byKind = {};
  for (const doc of docs) {
    const bucket = byKind[doc.kind] || (byKind[doc.kind] = {total: 0, stale: 0});
    bucket.total += 1;
    if (doc.status === 'stale') bucket.stale += 1;
  }
  return {
    total: docs.length,
    stale: docs.filter(d => d.status === 'stale').length,
    byKind,
    kinds: DOC_KINDS.filter(k => byKind[k.id]).map(k => k.id)
  };
}

// 清单里某张图当前的记录（没有就返回 null），供生成前判断「是否重复生成」。
export function existingDoc(value, {kind, scheme, seq}) {
  return value?.docs?.[docKey({kind, scheme, seq})] ?? null;
}

// 同一份输入重复生成时，产物哈希应当一致：不一致说明渲染不确定，必须报错。
export function sameBytes(previous, nextSha256) {
  if (!previous?.sha256) return {comparable: false, stable: null};
  return {comparable: true, stable: previous.sha256 === nextSha256};
}
