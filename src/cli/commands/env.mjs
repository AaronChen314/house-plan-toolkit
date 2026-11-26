// 宿主层：环境、技能与发布相关命令。
import path from 'node:path';
import {ROOT, VERSION} from '../../root.mjs';
import {runDoctor} from '../doctor.mjs';
import {runSetup} from '../setup.mjs';
import {buildSkills, syncSkills, listSkills} from '../skills.mjs';
import {run} from '../exec.mjs';

export const commands = [
  {
    name: 'doctor',
    group: '技能与环境',
    usage: 'space doctor [--project <project.json>]',
    summary: '环境自检',
    async run(args, {print}) {
      const r = await runDoctor({project: args.take('--project')});
      for (const c of r.checks) {
        const mark = c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗';
        print(`${mark} ${c.name}: ${c.detail}`);
        if (c.fix) print(`    ${c.fix}`);
      }
      print(`\n${r.ok ? '环境可用' : '存在阻塞项'}（house-plan-toolkit ${r.version}）`);
      process.exitCode = r.ok ? 0 : 1;
    }
  },
  {
    name: 'setup',
    group: '技能与环境',
    usage: 'space setup [--project 目录]',
    summary: '安装 Python 依赖',
    async run(args, {print}) {
      const r = runSetup({project: args.take('--project'), python: args.take('--python')});
      print(`Python 依赖已安装：${r.python}`);
    }
  },
  {
    name: 'skills',
    group: '技能与环境',
    usage: 'space skills build|check|list|sync [--project 目录]',
    summary: '构建、校验、安装技能包',
    async run(args, {print, error}) {
      const action = args.shift() || 'list';
      if (action === 'build') {
        const r = buildSkills();
        print(r.ok ? `已生成 ${r.skills} 个技能的 references（v${r.version}）` : '生成失败');
        r.errors.forEach(e => error('  ' + e));
        process.exitCode = r.ok ? 0 : 1;
        return;
      }
      if (action === 'check') {
        const r = buildSkills({checkOnly: true});
        print(r.ok ? `技能包一致：${r.skills} 个技能，链接全部可解析` : '技能包不一致');
        r.errors.forEach(e => error('  ' + e));
        process.exitCode = r.ok ? 0 : 1;
        return;
      }
      if (action === 'sync') {
        const r = syncSkills({project: args.take('--project') || '.', target: args.take('--target')});
        print(`已同步 ${r.skills.length} 个技能到 ${r.dest}（v${r.version}）`);
        return;
      }
      if (action === 'list') {
        for (const s of listSkills()) print(`${s.name}\n  ${s.description}\n  references: ${s.references}`);
        return;
      }
      throw new Error('用法：space skills build|check|sync|list');
    }
  },
  {
    name: 'verify-public',
    group: '技能与环境',
    aliases: ['verify:public'],
    usage: 'space verify-public [--layout target|current] [--denylist 文件]',
    summary: '发布边界审计',
    forward: true,
    async run(args) {
      run(process.execPath, [path.join(ROOT, 'src/checks/public-surface.mjs'), ...args.rest]);
    }
  },
  {
    name: 'version',
    group: '其他',
    aliases: ['--version', '-v'],
    usage: 'space version',
    summary: '输出版本矩阵',
    async run(args, {print}) {
      const fs = await import('node:fs');
      const {SCHEMAS} = await import('../../contracts/schemas.mjs');
      const bundleFile = path.join(ROOT, 'skills', '.bundle.json');
      const skills = fs.existsSync(bundleFile) ? JSON.parse(fs.readFileSync(bundleFile, 'utf8')) : null;
      // 打包时 scripts/pack.mjs 写进 src/build-info.json；dev 检出没有这个文件就跳过。
      const infoFile = path.join(ROOT, 'src', 'build-info.json');
      const build = fs.existsSync(infoFile) ? JSON.parse(fs.readFileSync(infoFile, 'utf8')) : null;
      const gitHead = build?.commit || null;
      print(JSON.stringify({
        toolkit: VERSION,
        ...(gitHead ? {commit: gitHead.slice(0, 7)} : {}),
        node: process.versions.node,
        platform: process.platform,
        schemas: SCHEMAS.map(s => s.id),
        requirements: {toolkit: '>=20', index: `>=${(await import('../../indexer/db.mjs')).INDEX_NODE_MIN}`},
        layoutVersion: 1,
        skills: skills ? {version: skills.version, count: Object.keys(skills.skills).length} : null
      }, null, 2));
    }
  }
];
