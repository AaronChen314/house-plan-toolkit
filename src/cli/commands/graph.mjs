// 宿主层：推导图投影。权威在 data/ 下的文件，这里只同步/查看/预演。
import {openStore} from '../../store/index.mjs';
import {projectFromFiles, readGraph} from '../../store/graph.mjs';
import {impactOf, planStale} from '../../domain/graph.mjs';

export const commands = [
  {
    name: 'graph',
    group: '项目',
    usage: 'space graph sync|show|stale --project <project.json> [--node <id>...]',
    summary: '推导图投影：从文件同步、查看、失效预演（不写数据）',
    async run(args, {print}) {
      const action = args.shift() || 'show';
      const project = args.take('--project');
      if (!project) throw new Error('需要 --project');
      const json = args.flag('--json');
      const store = openStore(project);

      if (action === 'sync') {
        const r = await projectFromFiles(store);
        if (json) { print(JSON.stringify(r, null, 2)); return; }
        print(`推导图已同步：${r.nodes} 个节点 · ${r.edges} 条边 · ${r.forks} 条复制记录`);
        print('  数据文件是权威，索引只是投影；space index rebuild 可随时重建');
        return;
      }

      // 读投影前先从 data/ 刷新：避免用上一次同步的旧状态下结论。
      await projectFromFiles(store);
      const graph = await readGraph(store);
      if (action === 'show') {
        if (json) { print(JSON.stringify(graph, null, 2)); return; }
        if (!graph.nodes.length) {
          print('投影为空：先运行 space graph sync --project <project.json>');
          return;
        }
        const byKind = {};
        for (const n of graph.nodes) byKind[n.kind] = (byKind[n.kind] || 0) + 1;
        print(`节点 ${graph.nodes.length}（${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(' · ')}）· 边 ${graph.edges.length} · 复制 ${graph.forks.length} · 版本 ${graph.versions.length}`);
        print('  已从 data/ 刷新投影；权威是文件，索引只是投影');
        for (const n of graph.nodes) print(`  ${n.id}\t${n.kind}\t${n.status}`);
        return;
      }

      if (action === 'stale') {
        // 预演：只算该标谁，不改任何东西。真正的状态改写发生在版本文件上。
        const raw = args.take('--node');
        const requested = [...new Set([
          ...(raw ? raw.split(',').map(s => s.trim()) : []),
          ...args.rest.filter(a => !a.startsWith('--'))
        ].filter(Boolean))];
        if (!requested.length) throw new Error('用法：space graph stale --project <project.json> --node <id>[,<id>]');
        const impact = impactOf({changed: requested, edges: graph.edges});
        const plan = planStale({affected: impact.affected, nodes: graph.nodes});
        if (json) { print(JSON.stringify({requested, ...plan, truncated: impact.truncated}, null, 2)); return; }
        if (!plan.stale.length) print('没有需要标待复核的设计版本');
        for (const item of plan.stale) print(`  待复核：${item.id}（${item.from} → stale，深度 ${item.depth}）`);
        for (const item of plan.skipped) print(`  跳过：${item.id}（${item.reason}）`);
        print('  预演结束：只刷新了索引投影，没有改任何数据文件。确认后由 space design version 产生新版本，再改状态');
        return;
      }

      throw new Error('用法：space graph sync|show|stale --project <project.json>');
    }
  }
];
