#!/usr/bin/env node
// 从模板生成符合目录规范的项目骨架。space init 的实现。
// 新项目的每一个文件同样经存储层写入，登记进 .space/files.json。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ROOT} from '../root.mjs';
import {fail} from '../contracts/errors.mjs';
import {lockFor} from './lock.mjs';
import {openStore} from '../store/index.mjs';

const TEMPLATE = path.join(ROOT, 'templates', 'project');

// 模板文件名到项目内文件名的映射：模板说明页不进入项目。
function templatePlan() {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(TEMPLATE, rel), {withFileTypes: true})) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(next); continue; }
      if (!rel && e.name === 'README.md') continue; // 只跳过模板自身的说明页
      out.push({src: next, dst: e.name === 'gitignore' ? next.replace(/gitignore$/, '.gitignore') : next});
    }
  };
  walk('');
  return out;
}

export function initProject({id, name, dir, force = false} = {}) {
  if (!id) throw fail('E_EXEC_PARAM', '缺少 --id');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw fail('E_EXEC_PARAM', 'id 只允许小写字母、数字和连字符，且以字母或数字开头');
  const target = path.resolve(dir || path.join(process.cwd(), id));
  if (fs.existsSync(target) && fs.readdirSync(target).length && !force) {
    throw fail('E_EXEC_PARAM', `目录已存在且非空：${target}\n加 --force 覆盖模板文件，或换一个 --dir`);
  }

  const projectFile = path.join(target, 'project.json');
  const templateProject = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'project.json'), 'utf8'));
  const project = {...templateProject, schema: 'space-project/v1', id, name: name || id, status: 'awaiting-source', model: null, output: 'output'};
  const store = openStore(projectFile, {create: true, project, actor: 'space.init'});
  const baseHashFor = (rel) => store.hashOf(rel);
  // output/ 是派生物目录，脚手架里的占位文件按派生物登记。
  const writeInit = (rel, content, kind) => (rel.startsWith('output/')
    ? store.writeArtifact(rel, content, {op: 'space.init', ...(kind ? {kind} : {})})
    : store.writeData(rel, content, {baseHash: baseHashFor(rel), confirm: true, force, op: 'space.init', ...(kind ? {kind} : {})}));

  store.writeData('project.json', JSON.stringify(project, null, 2) + '\n', {baseHash: null, confirm: true, force, kind: 'json', op: 'space.init'});

  const plan = templatePlan();
  for (const item of plan) {
    if (item.dst === 'project.json') continue;
    const content = fs.readFileSync(path.join(TEMPLATE, item.src));
    const text = item.dst === 'README.project.md'
      ? content.toString('utf8').replaceAll('{{ID}}', id).replaceAll('{{NAME}}', name || id)
      : content;
    writeInit(item.dst, text, item.dst.endsWith('.json') ? 'json' : undefined);
  }

  const lock = lockFor(project, target);
  store.writeData('space.lock.json', JSON.stringify(lock, null, 2) + '\n', {baseHash: baseHashFor('space.lock.json'), confirm: true, force, kind: 'json', op: 'space.init'});

  if (store.exists('README.project.md')) {
    store.writeData('README.md', store.readText('README.project.md'), {baseHash: baseHashFor('README.md'), confirm: true, force, kind: 'text', op: 'space.init'});
    fs.rmSync(path.join(target, 'README.project.md'), {force: true});
    store.rebuild({op: 'space.init', reason: '模板说明页转成 README.md'});
  }

  return {dir: target, id, version: lock.toolkit, lock};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i < 0 ? undefined : args[i + 1]; };
  try {
    const r = initProject({id: opt('--id'), name: opt('--name'), dir: opt('--dir'), force: args.includes('--force')});
    console.log(`已生成项目骨架：${r.dir}\n  id=${r.id}  toolkit=${r.version}  layoutVersion=1`);
    console.log('\n下一步：');
    console.log('  1. 图纸放进 source/drawings/，在 source/manifest.json 登记来源、版本与指纹');
    console.log('  2. 建立 data/model.json，把 project.json 的 model 从 null 改为该路径');
    console.log('  3. 自检：space lint --project project.json');
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
