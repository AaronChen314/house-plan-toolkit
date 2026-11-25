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
    summary: '底图描图：人工或 AI 提议的墙合并进数据集（--file / --items / --provenance / --underlay / --actor）',
    async run(args, {print}) {
      const action = args.shift() || 'list';
      const project = args.take('--project');
      if (!project) throw new Error('需要 --project');
      const dataset = args.take('--dataset');
      if (!dataset) throw new Error('需要 --dataset');
      const json = args.flag('--json');

      if (action === 'save') {
        const actor = args.take('--actor') || process.env.SPACE_ACTOR;
        // 批量来源：AI 提议用 --provenance ai；单项里写了 provenance 时以单项为准。
        const provenance = args.take('--provenance');
        const items = readItems(args).map(item => (provenance && !item.provenance ? {...item, provenance} : item));
        const r = await runCapability({
          project,
          capability: 'annotation.trace',
          params: {dataset, floor: args.take('--floor'), items, underlay: args.take('--underlay'), actor, note: args.take('--note') || ''}
        });
        if (json) { print(JSON.stringify(r, null, 2)); return; }
        print(r.summary);
        for (const o of r.outputs || []) print(`  ${o.path}`);
        return;
      }

      if (action === 'review') {
        // 审查：哪些墙是 AI/识别来的、哪些置信度低需要人看一眼。
        const store = openStore(project);
        const modelRel = `data/datasets/${dataset}/model.json`;
        if (!store.exists(modelRel)) throw new Error(`模型不存在：${modelRel}`);
        const model = store.readJson(modelRel);
        const walls = (model.floors || []).flatMap(f => (f.walls || []).map(w => ({...w, floor: f.id})));
        const {reviewWalls} = await import('../../domain/tracing.mjs');
        const r = reviewWalls(walls);
        if (json) { print(JSON.stringify({...r, walls}, null, 2)); return; }
        print(`${dataset} · 墙 ${r.total} 面（${Object.entries(r.byProvenance).map(([k, v]) => `${k} ${v}`).join(' · ')}）`);
        if (r.untyped) print(`  ${r.untyped} 面没有来源标记（历史数据）`);
        if (!r.lowConfidence.length) print('  没有低置信度墙需要核对');
        else for (const handle of r.lowConfidence) print(`  待核对：${handle}（置信度低于阈值）`);
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
