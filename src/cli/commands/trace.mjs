// 宿主层：底图描图。写操作走 annotation.trace 能力，list 只读。
import fs from 'node:fs';
import {runCapability} from '../../capabilities/index.mjs';
import {openStore} from '../../store/index.mjs';

function readItems(args) {
  const file = args.take('--file');
  const inline = args.take('--items');
  if (file) {
    if (!fs.existsSync(file)) throw new Error(`描图项文件不存在：${file}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  if (inline) return JSON.parse(inline);
  throw new Error('需要 --file <items.json> 或 --items <JSON 数组>');
}

export const commands = [
  {
    name: 'trace',
    group: '数据',
    usage: 'space trace save|list --project <project.json> --dataset <id> ...',
    summary: '底图描图：把人工画的墙合并进数据集（--file / --items / --underlay / --actor）',
    async run(args, {print}) {
      const action = args.shift() || 'list';
      const project = args.take('--project');
      if (!project) throw new Error('需要 --project');
      const dataset = args.take('--dataset');
      if (!dataset) throw new Error('需要 --dataset');
      const json = args.flag('--json');

      if (action === 'save') {
        const actor = args.take('--actor') || process.env.SPACE_ACTOR;
        const r = await runCapability({
          project,
          capability: 'annotation.trace',
          params: {
            dataset,
            floor: args.take('--floor'),
            items: readItems(args),
            underlay: args.take('--underlay'),
            actor,
            note: args.take('--note') || ''
          }
        });
        if (json) { print(JSON.stringify(r, null, 2)); return; }
        print(r.summary);
        for (const o of r.outputs || []) print(`  ${o.path}`);
        return;
      }

      if (action === 'list') {
        const store = openStore(project);
        const rel = `data/datasets/${dataset}/dataset.json`;
        if (!store.exists(rel)) throw new Error(`数据集不存在：${dataset}（${rel}）`);
        const record = store.readJson(rel);
        const traces = record.traces || [];
        if (json) { print(JSON.stringify(traces, null, 2)); return; }
        print(`${dataset} · 描图记录 ${traces.length} 条`);
        for (const t of traces) {
          print(`  ${t.at}  ${t.actor}  楼层 ${t.floor || '-'}  墙 ${t.walls}  判无效 ${t.invalid}${t.note ? ` · ${t.note}` : ''}`);
        }
        return;
      }

      throw new Error('用法：space trace save|list --project <project.json> --dataset <id>');
    }
  }
];
