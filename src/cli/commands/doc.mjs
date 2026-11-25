// 宿主层：施工图与交付清单。出图走 doc.wall-demolition，复核走 doc.check。
import {runCapability} from '../../capabilities/index.mjs';

export const commands = [
  {
    name: 'doc',
    group: '交付',
    usage: 'space doc render|check|list --project <project.json> [--scheme a --seq 1]',
    summary: '施工图（拆改图）与交付清单：出图、复核过期、列出清单（--floor / --scale / --force）',
    async run(args, {print}) {
      const action = args.shift();
      const project = args.take('--project');
      if (!project) throw new Error('需要 --project');
      const json = args.flag('--json');

      if (action === 'render') {
        const seq = args.take('--seq');
        const scale = args.take('--scale');
        const r = await runCapability({
          project,
          capability: 'doc.wall-demolition',
          params: {
            scheme: args.take('--scheme'),
            seq: seq === undefined ? undefined : Number(seq),
            floor: args.take('--floor'),
            scale: scale === undefined ? undefined : Number(scale),
            title: args.take('--title'),
            force: args.flag('--force')
          }
        });
        if (json) { print(JSON.stringify(r, null, 2)); return; }
        print(r.summary);
        for (const o of r.outputs) print(`  ${o.path}`);
        if (r.data?.layers) print(`  比例 1:${r.data.scale} · 图层 ${r.data.layers.join(', ')}`);
        return;
      }

      if (action === 'check') {
        const r = await runCapability({project, capability: 'doc.check'});
        if (json) { print(JSON.stringify(r, null, 2)); return; }
        print(r.summary);
        for (const d of r.data?.docs || []) {
          print(`  ${d.status === 'stale' ? '待复核' : '一致'}  ${d.file}${d.reasons.length ? `：${d.reasons.join('；')}` : ''}`);
        }
        return;
      }

      if (action === 'list' || !action) {
        const r = await runCapability({project, capability: 'doc.list'});
        if (json) { print(JSON.stringify(r, null, 2)); return; }
        print(r.summary);
        for (const k of r.data?.kinds || []) print(`  ${k.implemented ? '✓' : '·'} ${k.id}  ${k.title}${k.implemented ? '' : '（只有契约与图层规范，未出图）'}`);
        for (const d of r.data?.docs || []) {
          print(`  ${d.status === 'stale' ? '待复核' : '已生成'}  ${d.file} · 设计 ${d.design} · 数据集 ${d.dataset} · 确认 ${d.confirmations} 条`);
        }
        return;
      }

      throw new Error('用法：space doc render|check|list --project <project.json>');
    }
  }
];
