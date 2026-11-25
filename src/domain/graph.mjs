// L1 领域：影响面与失效传播。纯函数，输入节点与边，输出「哪些下游该标待复核」。
// 规则：只沿派边走（复制不传播）；不删除、不自动重算；草稿与已作废不标记。
import {canTransition, propagates} from '../contracts/graph.mjs';

// 从 changed 出发沿派生边做分层 BFS。结果排序稳定：先浅后深，同层按 id。
export function impactOf({changed = [], edges = [], maxDepth = Infinity} = {}) {
  const seeds = [...new Set(changed)].filter(Boolean).sort();
  const seedSet = new Set(seeds);
  const outgoing = new Map();
  for (const edge of edges) {
    if (!propagates(edge.role)) continue;
    if (!outgoing.has(edge.src)) outgoing.set(edge.src, []);
    outgoing.get(edge.src).push(edge.dst);
  }
  for (const [id, list] of outgoing) outgoing.set(id, [...new Set(list)].sort());

  const depth = new Map(seeds.map(id => [id, 0]));
  const queue = [...seeds];
  let truncated = false;

  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    const next = outgoing.get(id);
    if (!next?.length) continue;
    if (depth.get(id) >= maxDepth) { truncated = true; continue; }
    for (const target of next) {
      if (depth.has(target)) continue;
      depth.set(target, depth.get(id) + 1);
      queue.push(target);
    }
  }

  const affected = [...depth.entries()]
    .filter(([id]) => !seedSet.has(id))
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([id, d]) => ({id, depth: d}));

  return {impacted: seeds.length > 0, affected, truncated, visited: depth.size};
}

// 只把「已确认、尚未待复核」的节点标为待复核；草稿无需标记，已作废保持原状。
export function planStale({affected = [], nodes = []} = {}) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const stale = [], skipped = [];
  for (const item of affected) {
    const id = typeof item === 'string' ? item : item.id;
    const depth = typeof item === 'string' ? null : item.depth;
    const node = byId.get(id);
    if (!node) { skipped.push({id, reason: '未登记'}); continue; }
    const status = node.status || 'draft';
    if (status === 'draft') { skipped.push({id, reason: '草稿无需标记'}); continue; }
    if (status === 'stale') { skipped.push({id, reason: '已是待复核'}); continue; }
    if (status === 'superseded') { skipped.push({id, reason: '已作废'}); continue; }
    if (!canTransition(status, 'stale')) { skipped.push({id, reason: `${status} 不能标记为待复核`}); continue; }
    stale.push({id, from: status, to: 'stale', ...(depth == null ? {} : {depth})});
  }
  return {stale, skipped};
}

// 上游变化 → 该标谁：能力层只需要这两个函数，不用自己走图。
export function staleAfterChange({changed = [], nodes = [], edges = [], maxDepth = Infinity} = {}) {
  const impact = impactOf({changed, edges, maxDepth});
  const plan = planStale({affected: impact.affected, nodes});
  return {...impact, ...plan};
}

// 祖先/来源追溯：某个节点直接或间接依赖了谁（反向边，用于「基于哪版数据」）。
export function upstreamOf({node, edges = []} = {}) {
  const incoming = new Map();
  for (const edge of edges) {
    if (!propagates(edge.role)) continue;
    if (!incoming.has(edge.dst)) incoming.set(edge.dst, []);
    incoming.get(edge.dst).push(edge.src);
  }
  const seen = new Set();
  const queue = [node];
  while (queue.length) {
    const id = queue.shift();
    for (const src of incoming.get(id) || []) {
      if (seen.has(src)) continue;
      seen.add(src);
      queue.push(src);
    }
  }
  return [...seen].sort();
}
