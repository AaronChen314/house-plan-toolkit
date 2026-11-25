// 宿主层：能力插件门面。默认关闭，SPACE_PLUGINS=1 才加载。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pluginsEnabled} from '../../contracts/plugins.mjs';

export const commands = [
  {
    name: 'plugin',
    group: '技能与环境',
    usage: 'space plugin list|dirs [--project <project.json>] [--json]',
    summary: '能力插件：加载目录、已加载插件与问题（默认关闭，SPACE_PLUGINS=1 开启）',
    async run(args, {print}) {
      const action = args.shift() || 'list';
      const json = args.flag('--json');
      const project = args.take('--project');
      const projectDir = project ? path.dirname(path.resolve(project)) : undefined;
      const {pluginDirs} = await import('../../capabilities/plugins.mjs');
      const {initPlugins, pluginSummary} = await import('../../capabilities/index.mjs');
      const enabled = pluginsEnabled(process.env.SPACE_PLUGINS);
      const dirs = pluginDirs({projectDir, home: os.homedir()});

      if (action === 'dirs') {
        if (json) { print(JSON.stringify({enabled, dirs}, null, 2)); return; }
        print(`插件加载：${enabled ? '已开启' : '已关闭（SPACE_PLUGINS=1 开启）'}`);
        for (const dir of dirs) print(`  ${dir}${fs.existsSync(dir) ? '' : '（不存在）'}`);
        return;
      }

      if (action === 'list') {
        const state = await initPlugins({projectDir, enabled});
        const summary = pluginSummary();
        if (json) { print(JSON.stringify({...summary, dirs}, null, 2)); return; }
        print(`插件加载：${summary.enabled ? '已开启' : '已关闭（SPACE_PLUGINS=1 开启）'}`);
        for (const dir of dirs) print(`  目录 ${dir}${fs.existsSync(dir) ? '' : '（不存在）'}`);
        if (!summary.plugins.length) print('  没有加载任何插件');
        for (const p of summary.plugins) {
          print(`  ✓ ${p.id}@${p.version} ${p.name} · 能力 ${p.capabilities.join(', ') || '无'}`);
        }
        for (const problem of state.problems) print(`  ✗ ${problem}`);
        return;
      }

      throw new Error('用法：space plugin list|dirs [--project <project.json>]');
    }
  }
];
