#!/usr/bin/env node
// 从模板生成符合目录规范的项目骨架。space init 的实现，先独立入口。
// 用法：node toolkit/cli/init.mjs --id <project-id> [--name 名称] [--dir 目标目录] [--force]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLKIT_ROOT = path.resolve(HERE, '..');
const TEMPLATE = path.join(TOOLKIT_ROOT, 'templates/project');

const args = process.argv.slice(2);
const option = (k) => { const i = args.indexOf(k); if (i < 0) return undefined; const v = args[i + 1]; if (!v || v.startsWith('--')) { console.error(`缺少 ${k} 的值`); process.exit(2); } args.splice(i, 2); return v; };
const id = option('--id');
const name = option('--name') || id;
const force = args.includes('--force');
if (!id) { console.error('用法：node toolkit/cli/init.mjs --id <project-id> [--name 名称] [--dir 目标目录] [--force]'); process.exit(2); }
if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { console.error('id 只允许小写字母、数字和连字符，且以字母或数字开头'); process.exit(2); }

const dir = path.resolve(option('--dir') || path.join(process.cwd(), id));
if (fs.existsSync(dir) && fs.readdirSync(dir).length && !force) {
  console.error(`目录已存在且非空：${dir}\n加 --force 覆盖模板文件，或换一个 --dir`);
  process.exit(1);
}

const toolkitVersion = JSON.parse(fs.readFileSync(path.join(TOOLKIT_ROOT, 'package.json'), 'utf8')).version;
const today = new Date().toISOString().slice(0, 10);

function copyDir(src, dst) {
  fs.mkdirSync(dst, {recursive: true});
  for (const e of fs.readdirSync(src, {withFileTypes: true})) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.name === 'README.md') continue; // 模板说明页不进入项目
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

copyDir(TEMPLATE, dir);

const projectFile = path.join(dir, 'project.json');
const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
Object.assign(project, {schema: 'space-project/v1', id, name, status: 'awaiting-source', model: null, output: 'output'});
fs.writeFileSync(projectFile, JSON.stringify(project, null, 2) + '\n');

fs.writeFileSync(path.join(dir, 'space.lock.json'), JSON.stringify({
  schema: 'space-lock/v1',
  toolkit: toolkitVersion,
  schemas: {'space-project': 'v1', 'space-model': 'v1', 'design-sync': 'v1'},
  layoutVersion: 1,
  lockedAt: today
}, null, 2) + '\n');

const readme = path.join(dir, 'README.project.md');
if (fs.existsSync(readme)) {
  const text = fs.readFileSync(readme, 'utf8').replaceAll('{{ID}}', id).replaceAll('{{NAME}}', name);
  fs.writeFileSync(path.join(dir, 'README.md'), text);
  fs.rmSync(readme);
}

console.log(`已生成项目骨架：${dir}`);
console.log(`  id=${id}  toolkit=${toolkitVersion}  layoutVersion=1`);
console.log('\n下一步：');
console.log('  1. 把图纸放进 source/drawings/，在 source/manifest.json 登记来源、版本与指纹');
console.log('  2. 建立 data/model.json，把 project.json 的 model 从 null 改为该路径');
console.log('  3. 目录规范自检：node toolkit/checks/layout.mjs --project project.json');
