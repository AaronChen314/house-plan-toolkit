// 宿主层：能力、三维转换与工作台命令。
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export const commands = [
  {
    name: 'capabilities',
    group: '其他',
    usage: 'space capabilities [--check]',
    summary: '输出能力注册表；--check 跑契约 lint',
    async run(args, {print, error}) {
      const {capabilityCatalog, checkCapabilities} = await import('../../capabilities/index.mjs');
      if (args.flag('--check')) {
        const problems = checkCapabilities();
        for (const p of problems) error('  ' + p);
        const catalog = capabilityCatalog();
        print(problems.length
          ? `能力契约有 ${problems.length} 处问题`
          : `能力契约一致：${catalog.implemented.length} 个已实现，${catalog.planned.length} 个计划中`);
        process.exitCode = problems.length ? 1 : 0;
        return;
      }
      print(JSON.stringify(capabilityCatalog(), null, 2));
    }
  },
  {
    name: 'model',
    group: '图纸与资产',
    usage: 'space model convert <file.blend> --project <project.json>',
    summary: 'Blender 转 GLB',
    async run(args, {print}) {
      const action = args.shift();
      if (action !== 'convert') throw new Error('用法：space model convert <file.blend> --project <project.json> [--out output/model/preview.glb]');
      const file = args.shift();
      if (!file) throw new Error('需要 .blend 文件');
      const project = args.take('--project');
      if (!project) throw new Error('需要 --project');
      const {runCapability} = await import('../../capabilities/index.mjs');
      const r = await runCapability({
        project,
        capability: 'model.convert',
        params: {file, out: args.take('--out') || 'output/model/preview.glb'},
        log: line => print(line)
      });
      print(r.summary);
      for (const o of r.outputs) print(o.path);
    }
  },
  {
    name: 'studio',
    group: '其他',
    usage: 'space studio --project <project.json> [--port N] [--open]',
    summary: '本地工作台',
    async run(args, {print}) {
      const project = args.take('--project');
      if (!project) throw new Error('需要 --project');
      const {startStudio} = await import('../../server/studio.mjs');
      const server = await startStudio({project, port: Number(args.take('--port') || 0)});
      print(`工作台：${server.url}`);
      if (args.flag('--open')) {
        const opener = process.platform === 'darwin'
          ? ['open', [server.url]]
          : process.platform === 'win32'
            ? ['cmd', ['/c', 'start', server.url]]
            : ['xdg-open', [server.url]];
        spawnSync(opener[0], opener[1], {stdio: 'ignore'});
      }
      print('Ctrl+C 结束。');
      await new Promise(() => {});
    }
  },
  {
    name: 'tools',
    group: '其他',
    usage: 'space tools',
    summary: '列出或运行早期脚本',
    forward: true,
    async run(args, {print, root}) {
      const fs = await import('node:fs');
      print(fs.readFileSync(path.join(root, 'src/tools.json'), 'utf8'));
    }
  },
  {
    name: 'run',
    group: '其他',
    hidden: true,
    usage: 'space run <tool-name> [args...]',
    summary: '运行早期脚本',
    forward: true,
    async run(args, {root}) {
      const fs = await import('node:fs');
      const {pythonFor, run: spawn} = await import('../exec.mjs');
      const name = args.shift();
      if (!name) throw new Error('需要工具名：space tools 查看清单');
      const registry = JSON.parse(fs.readFileSync(path.join(root, 'src/tools.json'), 'utf8'));
      const tool = registry[name];
      if (!tool) throw new Error('未知工具：' + name);
      const project = fs.existsSync('project.json') ? path.resolve('project.json') : undefined;
      const exe = tool.runtime === 'python' ? pythonFor(project) : process.execPath;
      if (tool.runtime === 'python') {
        // 归档脚本依赖 ezdxf 等：缺依赖时给一句人话，别甩 Python traceback。
        const {spawnSync} = await import('node:child_process');
        const probe = spawnSync(exe, ['-c', 'import ezdxf'], {encoding: 'utf8'});
        if (probe.status !== 0) {
          throw new Error(`这个脚本需要 Python 依赖（ezdxf 等），当前解释器 ${exe} 没装：先运行 space setup --project <项目目录>`);
        }
      }
      spawn(exe, [path.join(root, 'src', tool.entry), ...args.rest]);
    }
  }
];
