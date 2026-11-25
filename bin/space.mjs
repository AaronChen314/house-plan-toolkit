#!/usr/bin/env node
// 宿主层：只做分发。命令实现在 src/cli/commands/，参数读取在 args.mjs。
import path from 'node:path';
import {createArgs} from '../src/cli/args.mjs';
import {pluginsEnabled} from '../src/contracts/plugins.mjs';
import {findCommand, helpText, validateCommands} from '../src/cli/registry.mjs';
import {ROOT} from '../src/root.mjs';

const argv = process.argv.slice(2);
const name = argv.shift();

async function main() {
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    console.log(helpText());
    return;
  }

  const problems = validateCommands();
  if (problems.length) {
    console.error('命令注册表不一致：');
    for (const p of problems) console.error('  ' + p);
    process.exitCode = 1;
    return;
  }

  const command = findCommand(name);
  if (!command) {
    console.log(helpText());
    process.exitCode = 1;
    return;
  }

  // 插件默认关闭：只在显式开启时加载，加载失败只提示、不影响内置能力。
  if (pluginsEnabled(process.env.SPACE_PLUGINS)) {
    const {initPlugins} = await import('../src/capabilities/index.mjs');
    const at = argv.indexOf('--project');
    const projectFile = at >= 0 ? argv[at + 1] : undefined;
    const state = await initPlugins({projectDir: projectFile ? path.dirname(path.resolve(projectFile)) : undefined});
    for (const problem of state.problems) console.error(`插件：${problem}`);
  }

  const args = createArgs(argv);
  await command.run(args, {
    print: line => console.log(line),
    error: line => console.error(line),
    root: ROOT
  });

  // 剩余参数说明有未识别的输入；透传命令自己消费，其余命令不静默忽略。
  if (!command.forward && args.rest.length) {
    console.error(`未识别的参数：${args.rest.join(' ')}`);
    process.exitCode = 1;
  }
}

main().catch(e => {
  console.error('Error: ' + e.message);
  process.exitCode = 1;
});
