// 宿主层：项目类命令。参数解析在这里，业务在能力与校验里。
import path from 'node:path';
import {ROOT} from '../../root.mjs';
import {readProject, loadProject} from '../project.mjs';
import {initProject} from '../init.mjs';
import {writeLock} from '../lock.mjs';
import {lintProject} from '../../checks/layout.mjs';
import {buildProject} from '../build.mjs';
import {pythonFor, run} from '../exec.mjs';

function printLint(r, print) {
  print(`${r.passed ? 'PASS' : 'FAIL'} ${r.id ?? '?'} — ${r.project}`);
  for (const x of [...r.errors, ...r.warnings]) {
    print(`  ${x.code} ${x.path}: ${x.message}`);
    if (x.fix) print(`       修复：${x.fix}`);
  }
  print(`  ${r.summary.errors} error / ${r.summary.warnings} warning（CLI ${r.summary.toolkitVersion}）`);
}

const projectOption = (args) => {
  const project = args.take('--project');
  if (!project) throw new Error('需要 --project');
  return project;
};

export const commands = [
  {
    name: 'init',
    group: '项目',
    usage: 'space init --id <id> [--name 名称] [--dir 目录] [--force]',
    summary: '生成合规项目骨架',
    async run(args, {print}) {
      const r = initProject({id: args.take('--id'), name: args.take('--name'), dir: args.take('--dir'), force: args.flag('--force')});
      print(`已生成项目骨架：${r.dir}\n  id=${r.id}  toolkit=${r.version}  layoutVersion=1`);
      print('\n下一步：');
      print('  1. 图纸放进 source/drawings/，在 source/manifest.json 登记来源、版本与指纹');
      print('  2. 建立 data/model.json，把 project.json 的 model 从 null 改为该路径');
      print('  3. 自检：space lint --project project.json');
    }
  },
  {
    name: 'lock',
    group: '项目',
    usage: 'space lock --project <project.json>',
    summary: '写入版本锁与数据指纹',
    async run(args, {print}) {
      const r = writeLock(projectOption(args));
      print(`已写入 ${r.file}（toolkit ${r.lock.toolkit}）`);
    }
  },
  {
    name: 'lint',
    group: '项目',
    usage: 'space lint --project <project.json> [--strict] [--json]',
    summary: '目录与格式校验',
    async run(args, {print}) {
      const project = projectOption(args);
      const strict = args.flag('--strict'), json = args.flag('--json');
      const r = lintProject(project);
      if (json) print(JSON.stringify(r, null, 2)); else printLint(r, print);
      process.exitCode = r.errors.length || (strict && r.warnings.length) ? 1 : 0;
    }
  },
  {
    name: 'check',
    group: '项目',
    usage: 'space check --project <project.json>',
    summary: '空间关系与数据校验',
    async run(args, {print}) {
      const c = loadProject(projectOption(args));
      print(JSON.stringify(c.report, null, 2));
      process.exitCode = c.report.passed ? 0 : 1;
    }
  },
  {
    name: 'build',
    group: '项目',
    usage: 'space build --project <project.json> [--viewer white-model|drawing|designer] [--out 项目内目录]',
    summary: '生成平面核对或白模页面',
    forward: true, // designer 分支把剩余参数透传给旧脚本
    async run(args, {print}) {
      const project = projectOption(args);
      const viewer = args.take('--viewer') || 'white-model';
      const out = args.take('--out');
      const model = args.take('--model');
      if (viewer === 'designer') {
        const c = readProject(project);
        if (!c.project.spec) throw new Error('designer 需要 project.spec（HouseSpec）');
        const target = path.resolve(out || path.resolve(c.dir, c.project.output || 'output'), '设计器.html');
        run(pythonFor(project), [path.join(ROOT, 'src/legacy/scripts/build.py'), path.resolve(c.dir, c.project.spec), '-o', target, ...args.rest]);
        return;
      }
      if (!['drawing', 'white-model'].includes(viewer)) throw new Error('未知 viewer：' + viewer);
      const r = await buildProject(project, {viewer, out, model});
      print(r.file);
    }
  },
  {
    name: 'pack',
    group: '项目',
    usage: 'space pack --project <project.json>',
    summary: '打包交付',
    forward: true,
    async run(args) {
      const project = projectOption(args);
      const c = readProject(project);
      const output = path.resolve(c.dir, c.project.output || 'output');
      run(pythonFor(project), [path.join(ROOT, 'src/cli/pack.py'), output, '--name', c.project.id, ...args.rest]);
    }
  }
];
