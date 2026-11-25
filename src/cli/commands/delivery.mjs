// 宿主层：表现层与交付。渲染、交付包、只读快照都只写 output/。
import {runCapability} from '../../capabilities/index.mjs';

function common(args) {
  const seq = args.take('--seq');
  return {
    scheme: args.take('--scheme'),
    seq: seq === undefined ? undefined : Number(seq),
    force: args.flag('--force')
  };
}

export const commands = [
  {
    name: 'render',
    group: '交付',
    usage: 'space render colorplan --project <project.json> --scheme a --seq 1 [--floor 楼层] [--scale 100] [--theme plan] [--force]',
    summary: '确定性彩平图（文字与面积由数据生成）',
    async run(args, {print}) {
      const action = args.shift();
      const project = args.take('--project');
      if (!project) throw new Error('需要 --project');
      if (action !== 'colorplan') throw new Error('目前只实现 render colorplan；render interior 只有契约');
      const json = args.flag('--json');
      const scale = args.take('--scale');
      const r = await runCapability({
        project,
        capability: 'render.colorplan',
        params: {
          ...common(args),
          floor: args.take('--floor'),
          scale: scale === undefined ? undefined : Number(scale),
          theme: args.take('--theme'),
          title: args.take('--title'),
          camera: args.take('--camera')
        }
      });
      if (json) { print(JSON.stringify(r, null, 2)); return; }
      print(r.summary);
      for (const o of r.outputs) print(`  ${o.path}`);
      return;
    }
  },
  {
    name: 'bundle',
    group: '交付',
    usage: 'space bundle export --project <project.json> --scheme a --seq 1 [--name 包名] [--force]',
    summary: '导出只读交付包与哈希清单',
    async run(args, {print}) {
      const action = args.shift();
      const project = args.take('--project');
      if (!project) throw new Error('需要 --project');
      if (action !== 'export') throw new Error('用法：space bundle export --project <project.json> --scheme a --seq 1');
      const json = args.flag('--json');
      const r = await runCapability({
        project,
        capability: 'bundle.export',
        params: {...common(args), name: args.take('--name')}
      });
      if (json) { print(JSON.stringify(r, null, 2)); return; }
      print(r.summary);
      for (const o of r.outputs) print(`  ${o.path}`);
      return;
    }
  },
  {
    name: 'deliver',
    group: '交付',
    usage: 'space deliver snapshot --project <project.json> --scheme a --seq 1 [--name 快照名] [--force]',
    summary: '生成单文件只读快照（离线打开，不能回写）',
    async run(args, {print}) {
      const action = args.shift();
      const project = args.take('--project');
      if (!project) throw new Error('需要 --project');
      if (action !== 'snapshot') throw new Error('用法：space deliver snapshot --project <project.json> --scheme a --seq 1');
      const json = args.flag('--json');
      const r = await runCapability({
        project,
        capability: 'deliver.snapshot',
        params: {...common(args), name: args.take('--name')}
      });
      if (json) { print(JSON.stringify(r, null, 2)); return; }
      print(r.summary);
      for (const o of r.outputs) print(`  ${o.path}`);
      return;
    }
  }
];
