// 宿主层：逐项确认。写操作走 annotation.confirm 能力；list 只读。
import {runCapability} from '../../capabilities/index.mjs';
import {openStore} from '../../store/index.mjs';

export const commands = [
  {
    name: 'annotation',
    group: '数据',
    usage: 'space annotation confirm|list --project <project.json> --dataset <id> ...',
    summary: '逐项确认（--object / --field / --value / --invalid / --basis）与确认清单',
    async run(args, {print}) {
      const action = args.shift();
      const project = args.take('--project');
      if (!project) throw new Error('需要 --project');
      const dataset = args.take('--dataset');
      if (!dataset) throw new Error('需要 --dataset');
      const json = args.flag('--json');

      if (action === 'confirm') {
        const r = await runCapability({
          project,
          capability: 'annotation.confirm',
          params: {
            dataset,
            object: args.take('--object'),
            field: args.take('--field'),
            value: args.take('--value'),
            invalid: args.flag('--invalid'),
            basis: args.take('--basis'),
            actor: args.take('--actor')
          }
        });
        if (json) { print(JSON.stringify(r, null, 2)); return; }
        print(r.summary);
        if (r.data?.unchanged) print('  （内容未变，未写入）');
        return;
      }

      if (action === 'list') {
        const store = openStore(project);
        const rel = `data/datasets/${dataset}/dataset.json`;
        if (!store.exists(rel)) throw new Error(`数据集不存在：${dataset}（${rel}）`);
        const record = store.readJson(rel);
        if (json) { print(JSON.stringify(record, null, 2)); return; }
        const confirmed = new Map((record.confirmations || []).map(c => [`${c.object}::${c.field}`, c]));
        print(`${dataset} · 状态 ${record.status} · 确认 ${confirmed.size} 条 · 假设 ${(record.assumptions || []).length} 条`);
        if (record.assumptions?.length) {
          print('\n待确认（预览依据）');
          for (const a of record.assumptions) {
            const key = `${a.object}::${a.field}`;
            const done = confirmed.get(key);
            print(`  ${a.object}.${a.field} = ${a.value}${done ? `（已确认 ${done.value ?? '无效'}）` : ''}`);
          }
        }
        if (confirmed.size) {
          print('\n已确认');
          for (const c of confirmed.values()) {
            print(`  ${c.object}.${c.field} = ${c.invalid ? '（判为无效）' : c.value} · ${c.basis} · ${c.at} · ${c.actor || ''}`);
          }
        }
        return;
      }

      throw new Error('用法：space annotation confirm|list --project <project.json> --dataset <id>');
    }
  }
];
