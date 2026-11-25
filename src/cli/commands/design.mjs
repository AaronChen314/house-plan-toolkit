// 宿主层：设计版本命令。设计只引用数据集；复制只记录来源。
import {runCapability} from '../../capabilities/index.mjs';

async function call(project, capability, params) {
  return runCapability({project, capability, params});
}

export const commands = [
  {
    name: 'design',
    group: '设计',
    usage: 'space design create|version|fork|confirm|stale --project <project.json> ...',
    summary: '设计版本：新建、加版本、复制、确认、标待复核（--scheme / --dataset / --uses / --from / --seq）',
    async run(args, {print}) {
      const action = args.shift();
      const project = args.take('--project');
      if (!project) throw new Error('需要 --project');
      const json = args.flag('--json');
      const scheme = args.take('--scheme');

      let r;
      const uses = args.take('--uses');
      if (action === 'create') {
        r = await call(project, 'design.create', {scheme, dataset: args.take('--dataset'), uses});
      } else if (action === 'version') {
        r = await call(project, 'design.version', {scheme, note: args.take('--note') || '', uses});
      } else if (action === 'fork') {
        r = await call(project, 'design.fork', {from: args.take('--from'), scheme});
      } else if (action === 'confirm') {
        r = await call(project, 'design.confirm', {scheme, seq: Number(args.take('--seq'))});
      } else if (action === 'stale') {
        r = await call(project, 'design.stale', {scheme, seq: Number(args.take('--seq'))});
      } else {
        throw new Error('用法：space design create|version|fork|confirm|stale --project <project.json>');
      }

      if (json) { print(JSON.stringify(r, null, 2)); return; }
      print(r.summary);
      const d = r.data || {};
      for (const key of ['designFile', 'versionFile']) if (d[key]) print(`  ${d[key]}`);
      if (d.forkedFrom) print(`  复制自 ${d.forkedFrom.scheme}#${d.forkedFrom.seq}（只记录来源，不建立依赖）`);
      return;
    }
  }
];
