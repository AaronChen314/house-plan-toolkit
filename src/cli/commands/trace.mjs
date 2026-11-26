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
    usage: 'space trace brief|save|list|review --project <project.json> --dataset <id> ...',
    summary: 'AI 识别任务单与提议合并：brief 出任务、save 校验并写盘（--dry-run 只验不写）、review 复核来源与置信度',
    async run(args, {print}) {
      const action = args.shift() || 'list';
      const project = args.take('--project');
      if (!project) throw new Error('需要 --project');
      const dataset = args.take('--dataset');
      if (!dataset) throw new Error('需要 --dataset');
      const json = args.flag('--json');

      if (action === 'save') {
        const actor = args.take('--actor') || process.env.SPACE_ACTOR;
        const dryRun = args.flag('--dry-run');
        // 批量来源：AI 提议用 --provenance ai；单项里写了 provenance 时以单项为准。
        const provenance = args.take('--provenance');
        const items = readItems(args).map(item => (provenance && !item.provenance ? {...item, provenance} : item));
        if (dryRun) {
          // 只校验不写盘：AI 提议先过来验一遍，别写坏数据。
          const {validateTraceSpec, traceSpec, traceItem} = await import('../../contracts/tracing.mjs');
          const problems = validateTraceSpec(traceSpec({dataset, items: items.map(traceItem), actor, note: ''}));
          if (problems.length) { for (const p of problems) print(`  ${p}`); process.exitCode = 1; return; }
          print(`校验通过：${items.length} 项（未写盘）`);
          return;
        }
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

      if (action === 'brief') {
        // 给 AI/视觉模型的识别任务单：底图在哪、比例多少、原点在哪、要输出什么。
        // CLI 不做感知，只把「看清这张图所需的一切」准备好并校验回来的结果。
        const store = openStore(project);
        const underlayRel = 'output/cad/underlay.json';
        const meta = store.exists(underlayRel) ? store.readJson(underlayRel) : null;
        const modelRel = `data/datasets/${dataset}/model.json`;
        const model = store.exists(modelRel) ? store.readJson(modelRel) : null;
        const floors = (model?.floors || []).map(f => ({
          id: f.id,
          walls: (f.walls || []).length,
          doors: (f.doors || []).length,
          windows: (f.windowOpenings || []).length
        }));
        const brief = {
          schema: 'space-trace/v1',
          dataset,
          floor: floors[0]?.id ?? 'ground',
          image: meta ? {file: meta.file, path: store.resolve(meta.file), mmPerPx: meta.mmPerPx, origin: meta.origin, rotationDeg: meta.rotationDeg ?? 0} : null,
          existing: floors,
          output: {
            shape: 'items[]',
            wall: {kind: 'wall', from: '[x,y] 毫米', to: '[x,y] 毫米', thicknessMm: 200, provenance: 'ai', confidence: '0-1'},
            invalid: {kind: 'invalid', handle: '要否定的实体 handle', reason: '为什么'},
            note: '坐标用毫米；按底图比例换算：model = origin + pixel × mmPerPx'
          },
          submit: `space trace save --project <project.json> --dataset ${dataset} --file <items.json> --actor <你的名字> --provenance ai`,
          rules: [
            '一个房间沿墙中线画一段墙，不要画轮廓的四个角',
            '门/窗先不填，用 invalid 标出「这里应否掉」的已有实体',
            '看不清的墙不要猜：宁可不提交，留给人工描图',
            'confidence 写真实把握：低于 0.8 的会在 studio 里被红点标出'
          ]
        };
        if (json) { print(JSON.stringify(brief, null, 2)); return; }
        print(`识别任务单 · ${dataset}（给 AI/视觉模型）`);
        if (brief.image) print(`  底图 ${brief.image.path}\n  比例 ${brief.image.mmPerPx} mm/像素 · 原点 ${brief.image.origin.join(',')}`);
        else print('  还没有底图：先 space cap run cad.raster（PDF/图片）或 cad.vector');
        print(`  已有实体：${floors.map(f => `${f.id} 墙${f.walls}/门${f.doors}/窗${f.windows}`).join(' · ') || '无'}`);
        print('  输出 items[]（kind=wall/invalid，坐标毫米），提交：');
        print(`    ${brief.submit}`);
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
