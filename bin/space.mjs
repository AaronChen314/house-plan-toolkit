#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT, VERSION} from '../src/root.mjs';
import {readProject, loadProject} from '../src/cli/project.mjs';
import {findPython} from '../src/cli/python.mjs';
import {initProject} from '../src/cli/init.mjs';
import {writeLock} from '../src/cli/lock.mjs';
import {runDoctor} from '../src/cli/doctor.mjs';
import {runSetup} from '../src/cli/setup.mjs';
import {buildSkills, syncSkills, listSkills} from '../src/cli/skills.mjs';
import {lintProject} from '../src/checks/layout.mjs';

const argv = process.argv.slice(2);
const command = argv.shift();

function take(name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`缺少 ${name} 的值`);
  argv.splice(i, 2);
  return v;
}
const flag = (name) => { const i = argv.indexOf(name); if (i >= 0) argv.splice(i, 1); return i >= 0; };
const projectOption = () => take('--project');

function run(exec, args, opts = {}) {
  const r = spawnSync(exec, args, {stdio: 'inherit', ...opts});
  if (r.error) throw r.error;
  process.exitCode = r.status ?? 1;
}

function pythonFor(projectFile) {
  const dir = projectFile ? path.dirname(path.resolve(projectFile)) : undefined;
  return findPython(dir);
}

function printLint(r) {
  console.log(`${r.passed ? 'PASS' : 'FAIL'} ${r.id ?? '?'} — ${r.project}`);
  for (const x of [...r.errors, ...r.warnings]) {
    console.log(`  ${x.code} ${x.path}: ${x.message}`);
    if (x.fix) console.log(`       修复：${x.fix}`);
  }
  console.log(`  ${r.summary.errors} error / ${r.summary.warnings} warning（CLI ${r.summary.toolkitVersion}）`);
}

function help() {
  console.log(`house-plan-toolkit ${VERSION}

项目
  space init --id <id> [--name 名称] [--dir 目录] [--force]   生成合规项目骨架
  space lock --project <project.json>                        写入版本锁与数据指纹
  space lint --project <project.json> [--strict] [--json]     目录与格式校验
  space check --project <project.json>                       空间关系与数据校验
  space build --project <project.json> [--viewer white-model|drawing|designer] [--out 目录]
  space sync check --manifest <design-manifest.json>         设计到三维的同步门禁
  space pack --project <project.json>                        打包交付

图纸与资产
  space cad inspect <input.dxf> --out 目录                    DXF 图元索引
  space cad view <source.json> --out 目录                     源图核对页
  space assets list|search|add|inspect ...                    家具资产
  space serve <file.html> [--port 8765]                       本地预览

技能与环境
  space skills build|check|list                              构建、校验技能包
  space skills sync [--project 目录] [--target .agents/skills] 安装技能到项目
  space doctor [--project <project.json>]                    环境自检
  space setup [--project 目录]                               安装 Python 依赖
  space verify-public [--layout target|current] [--denylist 文件]  发布边界审计

其他
  space version | tools | run <tool-name> ... | help`);
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') { help(); return; }

  if (command === 'version' || command === '--version' || command === '-v') {
    const bundleFile = path.join(ROOT, 'skills', '.bundle.json');
    const skills = fs.existsSync(bundleFile) ? JSON.parse(fs.readFileSync(bundleFile, 'utf8')) : null;
    console.log(JSON.stringify({toolkit: VERSION, node: process.versions.node, platform: process.platform, schemas: ['space-project/v1', 'space-model/v1', 'design-sync/v1'], layoutVersion: 1, skills: skills ? {version: skills.version, count: Object.keys(skills.skills).length} : null}, null, 2));
    return;
  }

  if (command === 'init') {
    const r = initProject({id: take('--id'), name: take('--name'), dir: take('--dir'), force: flag('--force')});
    console.log(`已生成项目骨架：${r.dir}\n  id=${r.id}  toolkit=${r.version}  layoutVersion=1`);
    console.log('\n下一步：');
    console.log('  1. 图纸放进 source/drawings/，在 source/manifest.json 登记来源、版本与指纹');
    console.log('  2. 建立 data/model.json，把 project.json 的 model 从 null 改为该路径');
    console.log('  3. 自检：space lint --project project.json');
    return;
  }

  if (command === 'lock') {
    const project = projectOption();
    if (!project) throw new Error('需要 --project');
    const r = writeLock(project);
    console.log(`已写入 ${r.file}（toolkit ${r.lock.toolkit}）`);
    return;
  }

  if (command === 'doctor') {
    const r = await runDoctor({project: projectOption()});
    for (const c of r.checks) {
      const mark = c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗';
      console.log(`${mark} ${c.name}: ${c.detail}`);
      if (c.fix) console.log(`    ${c.fix}`);
    }
    console.log(`\n${r.ok ? '环境可用' : '存在阻塞项'}（house-plan-toolkit ${r.version}）`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  if (command === 'setup') {
    const project = take('--project');
    const r = runSetup({project, python: take('--python')});
    console.log(`Python 依赖已安装：${r.python}`);
    return;
  }

  if (command === 'lint') {
    const project = projectOption();
    if (!project) throw new Error('需要 --project');
    const strict = flag('--strict'), json = flag('--json');
    const r = lintProject(project);
    if (json) console.log(JSON.stringify(r, null, 2)); else printLint(r);
    process.exitCode = r.errors.length || (strict && r.warnings.length) ? 1 : 0;
    return;
  }

  if (command === 'check') {
    const project = projectOption();
    if (!project) throw new Error('需要 --project');
    const c = loadProject(project);
    console.log(JSON.stringify(c.report, null, 2));
    process.exitCode = c.report.passed ? 0 : 1;
    return;
  }

  if (command === 'build') {
    const project = projectOption();
    if (!project) throw new Error('需要 --project');
    const viewer = take('--viewer') || 'white-model';
    const out = take('--out');
    const model = take('--model');
    if (viewer === 'designer') {
      const c = readProject(project);
      if (!c.project.spec) throw new Error('designer 需要 project.spec（HouseSpec）');
      const target = path.resolve(out || path.resolve(c.dir, c.project.output || 'output'), '设计器.html');
      run(pythonFor(project), [path.join(ROOT, 'src/legacy/scripts/build.py'), path.resolve(c.dir, c.project.spec), '-o', target, ...argv]);
      return;
    }
    if (!['drawing', 'white-model'].includes(viewer)) throw new Error('未知 viewer：' + viewer);
    const {buildProject} = await import('../src/cli/build.mjs');
    const r = await buildProject(project, {viewer, out, model});
    console.log(r.file);
    return;
  }

  if (command === 'sync') {
    const action = argv.shift();
    if (action !== 'check') throw new Error('用法：space sync check --manifest design-manifest.json');
    const manifest = take('--manifest');
    if (!manifest) throw new Error('需要 --manifest');
    run(pythonFor(), [path.join(ROOT, 'src/checks/design_sync.py'), manifest, ...argv]);
    return;
  }

  if (command === 'cad') {
    const action = argv.shift();
    if (action === 'inspect') run(pythonFor(), [path.join(ROOT, 'src/cad/read.py'), ...argv]);
    else if (action === 'view') {
      const out = take('--out');
      if (!out) throw new Error('需要 --out');
      const {buildSourceDrawing} = await import('../src/cli/build.mjs');
      console.log(await buildSourceDrawing(argv[0], out));
    } else throw new Error('用法：space cad inspect <input.dxf> --out 目录 | space cad view <source.json> --out 目录');
    return;
  }

  if (command === 'assets') {
    run(process.execPath, [path.join(ROOT, 'src/furniture/catalog-cli.mjs'), ...argv]);
    return;
  }

  if (command === 'serve') {
    run(process.execPath, [path.join(ROOT, 'src/cli/preview.mjs'), ...argv]);
    return;
  }

  if (command === 'pack') {
    const project = projectOption();
    if (!project) throw new Error('需要 --project');
    const c = readProject(project);
    const output = path.resolve(c.dir, c.project.output || 'output');
    run(pythonFor(project), [path.join(ROOT, 'src/cli/pack.py'), output, '--name', c.project.id, ...argv]);
    return;
  }

  if (command === 'tools') {
    console.log(fs.readFileSync(path.join(ROOT, 'src/tools.json'), 'utf8'));
    return;
  }

  if (command === 'run') {
    const name = argv.shift();
    if (!name) throw new Error('需要工具名：space tools 查看清单');
    const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/tools.json'), 'utf8'));
    const tool = registry[name];
    if (!tool) throw new Error('未知工具：' + name);
    run(tool.runtime === 'python' ? pythonFor() : process.execPath, [path.join(ROOT, 'src', tool.entry), ...argv]);
    return;
  }

  if (command === 'skills') {
    const action = argv.shift() || 'list';
    if (action === 'build') {
      const r = buildSkills();
      console.log(r.ok ? `已生成 ${r.skills} 个技能的 references（v${r.version}）` : '生成失败');
      r.errors.forEach(e => console.error('  ' + e));
      process.exitCode = r.ok ? 0 : 1;
    } else if (action === 'check') {
      const r = buildSkills({checkOnly: true});
      console.log(r.ok ? `技能包一致：${r.skills} 个技能，链接全部可解析` : '技能包不一致');
      r.errors.forEach(e => console.error('  ' + e));
      process.exitCode = r.ok ? 0 : 1;
    } else if (action === 'sync') {
      const project = take('--project') || '.';
      const r = syncSkills({project, target: take('--target')});
      console.log(`已同步 ${r.skills.length} 个技能到 ${r.dest}（v${r.version}）`);
    } else if (action === 'list') {
      for (const s of listSkills()) console.log(`${s.name}\n  ${s.description}\n  references: ${s.references}`);
    } else throw new Error('用法：space skills build|check|sync|list');
    return;
  }

  if (command === 'capabilities') {
    const {listCapabilities} = await import('../src/capabilities/index.mjs');
    console.log(JSON.stringify(listCapabilities(), null, 2));
    return;
  }

  if (command === 'studio') {
    const project = projectOption();
    if (!project) throw new Error('需要 --project');
    const {startStudio} = await import('../src/server/studio.mjs');
    const server = await startStudio({project, port: Number(take('--port') || 0)});
    console.log(`工作台：${server.url}`);
    if (flag('--open')) {
      const opener = process.platform === 'darwin' ? ['open', [server.url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', server.url]] : ['xdg-open', [server.url]];
      spawnSync(opener[0], opener[1], {stdio: 'ignore'});
    }
    console.log('Ctrl+C 结束。');
    await new Promise(() => {});
    return;
  }

  if (command === 'model') {
    const action = argv.shift();
    if (action !== 'convert') throw new Error('用法：space model convert <file.blend> --project <project.json> [--out output/model/preview.glb]');
    const file = argv.shift();
    if (!file) throw new Error('需要 .blend 文件');
    const project = projectOption();
    if (!project) throw new Error('需要 --project');
    const {runCapability} = await import('../src/capabilities/index.mjs');
    const r = await runCapability({project, capability: 'model.convert', params: {file, out: take('--out') || 'output/model/preview.glb'}, log: line => console.log(line)});
    console.log(r.summary);
    for (const o of r.outputs) console.log(o.path);
    return;
  }

  if (command === 'verify-public' || command === 'verify:public') {
    run(process.execPath, [path.join(ROOT, 'src/checks/public-surface.mjs'), ...argv]);
    return;
  }

  help();
  process.exitCode = 1;
}

main().catch(e => { console.error('Error: ' + e.message); process.exitCode = 1; });
