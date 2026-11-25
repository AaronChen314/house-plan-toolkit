// 宿主层：拆改可行性、净空与动线检查。
import {runCapability} from '../../capabilities/index.mjs';

export const commands = [
  {
    name: 'program',
    group: '数据',
    usage: 'space program check --project <project.json>',
    summary: '拆改可行性、净空与动线检查（只读）',
    async run(args, {print}) {
      const action = args.shift();
      const project = args.take('--project');
      if (!project) throw new Error('需要 --project');
      if (action !== 'check') throw new Error('用法：space program check --project <project.json>');
      const json = args.flag('--json');
      const r = await runCapability({project, capability: 'program.check'});
      if (json) { print(JSON.stringify(r, null, 2)); return; }
      print(r.summary);
      for (const issue of r.data?.issues || []) {
        print(`  ${issue.severity === 'error' ? '✗' : '!'} ${issue.code} ${issue.object || ''}: ${issue.message}`);
      }
      if (!r.data?.issues?.length) print('  没有发现问题');
      process.exitCode = r.data?.passed ? 0 : 1;
    }
  }
];
