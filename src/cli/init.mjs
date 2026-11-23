#!/usr/bin/env node
// 从模板生成符合目录规范的项目骨架。space init 的实现。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ROOT, VERSION} from '../root.mjs';

const TEMPLATE = path.join(ROOT, 'templates', 'project');

export function initProject({id, name, dir, force = false} = {}) {
  if (!id) throw new Error('缺少 --id');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('id 只允许小写字母、数字和连字符，且以字母或数字开头');
  const target = path.resolve(dir || path.join(process.cwd(), id));
  if (fs.existsSync(target) && fs.readdirSync(target).length && !force) {
    throw new Error(`目录已存在且非空：${target}\n加 --force 覆盖模板文件，或换一个 --dir`);
  }

  copyDir(TEMPLATE, target);

  const projectFile = path.join(target, 'project.json');
  const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  Object.assign(project, {schema: 'space-project/v1', id, name: name || id, status: 'awaiting-source', model: null, output: 'output'});
  fs.writeFileSync(projectFile, JSON.stringify(project, null, 2) + '\n');

  fs.writeFileSync(path.join(target, 'space.lock.json'), JSON.stringify({
    schema: 'space-lock/v1',
    toolkit: VERSION,
    schemas: {'space-project': 'v1', 'space-model': 'v1', 'design-sync': 'v1'},
    layoutVersion: 1,
    lockedAt: new Date().toISOString().slice(0, 10)
  }, null, 2) + '\n');

  const readme = path.join(target, 'README.project.md');
  if (fs.existsSync(readme)) {
    const text = fs.readFileSync(readme, 'utf8').replaceAll('{{ID}}', id).replaceAll('{{NAME}}', name || id);
    fs.writeFileSync(path.join(target, 'README.md'), text);
    fs.rmSync(readme);
  }
  return {dir: target, id, version: VERSION};
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, {recursive: true});
  for (const e of fs.readdirSync(src, {withFileTypes: true})) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.name === 'README.md') continue; // 模板说明页不进入项目
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, e.name === 'gitignore' ? path.join(dst, '.gitignore') : d);
  }
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
