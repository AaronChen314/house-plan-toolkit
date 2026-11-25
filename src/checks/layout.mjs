#!/usr/bin/env node
// 项目目录与文件格式校验（layout）。规则见 reference/project-layout.md。
// 用法：space lint --project <id>/project.json [--strict] [--json]
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ROOT, VERSION} from '../root.mjs';

export const LAYOUT_VERSION = 1;
const ARTIFACT_EXT = new Set(['.html', '.htm', '.glb', '.gltf', '.zip', '.stl', '.obj', '.exe', '.dmg']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.svg']);
const IMAGE_OK = ['source', 'docs', 'output', 'data/assets', 'data/designs'];
const ARTIFACT_OK = ['output', 'data/assets'];
const TOOL_ENTRIES = ['src', 'bin', 'schemas', 'viewers', 'package.json', 'package-lock.json'];
const VENV_DIRS = ['.venv', 'venv', 'env'];
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.space']);

function walk(dir, rel = '', out = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(dir, rel), {withFileTypes: true}); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(dir, r, out); }
    else if (e.isFile()) out.push(r);
  }
  return out;
}

function readJson(file) {
  try { return {value: JSON.parse(fs.readFileSync(file, 'utf8'))}; }
  catch (e) { return {error: e.message}; }
}

export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? {major: +m[1], minor: +m[2], patch: +m[3]} : null;
}

export function inCompatibilityWindow(locked, current) {
  const a = parseVersion(locked), b = parseVersion(current);
  if (!a || !b) return false;
  if (a.major !== b.major) return false;
  return b.minor - a.minor >= 0 && b.minor - a.minor <= 1;
}

function isIgnored(dir, name) {
  const r = spawnSync('git', ['check-ignore', '-q', name], {cwd: dir});
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  try {
    const t = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    return new RegExp(`(^|\\n)\\s*/?${name}/?\\s*(\\n|$)`).test(t);
  } catch { return false; }
}

export function lintProject(projectPath) {
  const errors = [], warnings = [];
  const add = (list, code, rel, message, fix) => list.push({code, path: rel, message, ...(fix ? {fix} : {})});
  const dir = path.dirname(path.resolve(projectPath));
  const result = {schema: 'layout-report/v1', layoutVersion: LAYOUT_VERSION, project: dir, id: null, errors, warnings};

  const pj = readJson(path.resolve(projectPath));
  if (pj.error) { add(errors, 'E001', 'project.json', `无法解析：${pj.error}`); return finish(result); }
  const p = pj.value || {};
  if (p.schema !== 'space-project/v1') add(errors, 'E001', 'project.json', `schema 必须是 space-project/v1，当前 ${p.schema ?? '缺失'}`);

  result.id = typeof p.id === 'string' ? p.id : null;
  if (!result.id) add(errors, 'E001', 'project.json', '缺少 id');
  else if (result.id !== path.basename(dir)) add(errors, 'E002', 'project.json', `id "${result.id}" 与目录名 "${path.basename(dir)}" 不一致`, '重命名目录或改 id，两者必须一致');

  if (p.model === undefined) add(errors, 'E003', 'project.json', '缺少 model（尚无资料时写 null）');
  else if (p.model !== null) {
    if (typeof p.model !== 'string' || !p.model) add(errors, 'E003', 'project.json', 'model 必须是相对路径或 null');
    else {
      const abs = path.resolve(dir, p.model);
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      if (!fs.existsSync(abs)) add(errors, 'E003', rel, `model 指向的文件不存在：${p.model}`);
      else if (!(rel === 'data' || rel.startsWith('data/'))) add(errors, 'E003', rel, 'model 必须放在 data/ 下', '移动到 data/ 并更新 project.json');
    }
  }

  if (typeof p.output !== 'string' || !p.output) add(errors, 'E004', 'project.json', '缺少 output');
  else if (path.isAbsolute(p.output)) add(errors, 'E004', p.output, 'output 必须是项目内相对路径');
  else {
    const rel = path.relative(dir, path.resolve(dir, p.output)).split(path.sep).join('/');
    if (!(rel === 'output' || rel.startsWith('output/'))) add(errors, 'E004', p.output, 'output 必须位于项目内 output/ 下', '改为 "output" 或 "output/<子目录>"，生成物不出项目');
  }

  for (const entry of TOOL_ENTRIES) if (fs.existsSync(path.join(dir, entry))) {
    add(errors, 'E005', entry, '项目目录内不应包含工具实现', '工具代码属于 CLI 仓库，项目只保留数据与项目脚本');
  }

  const files = walk(dir);
  const hasSource = fs.existsSync(path.join(dir, 'source'));
  if (!hasSource) add(warnings, 'W007', 'source', '缺少 source/（原始资料目录）');
  else {
    const listed = new Set();
    const mf = path.join(dir, 'source/manifest.json');
    if (!fs.existsSync(mf)) add(errors, 'E006', 'source/manifest.json', 'source/ 存在但缺少 manifest.json', '逐项登记文件来源、版本、指纹与用途');
    else {
      const m = readJson(mf);
      if (m.error) add(errors, 'E006', 'source/manifest.json', `无法解析：${m.error}`);
      else {
        const arr = Array.isArray(m.value?.files) ? m.value.files : [];
        for (const it of arr) {
          const s = typeof it === 'string' ? it : (it?.path || it?.file);
          if (s) listed.add(String(s).replace(/^\.\//, ''));
        }
      }
    }
    for (const f of files) {
      if (!f.startsWith('source/')) continue;
      if (f === 'source/manifest.json' || f.endsWith('/README.md') || f.endsWith('.gitkeep')) continue;
      if (!listed.has(f)) add(errors, 'E006', f, '未登记在 source/manifest.json', '登记来源、版本、指纹与用途；无来源的文件不应进入 source/');
      if (f.startsWith('source/drawings/') && !/^\d{8}[-_]/.test(path.basename(f))) add(warnings, 'W001', f, '文件名建议以 YYYYMMDD- 开头，便于追溯收到日期');
    }
  }

  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (ARTIFACT_EXT.has(ext) && !ARTIFACT_OK.some(p => f === p || f.startsWith(p + '/'))) {
      add(errors, 'E007', f, '生成物必须放在 output/ 下', `space move --to output/${path.basename(f)}`);
    }
    if (ext === '.json' && (f === 'project.json' ? false : f.endsWith('/project.json'))) {
      add(errors, 'E008', f, '项目内出现第二个 project.json', '一个目录只能有一个项目配置');
    }
    if (IMAGE_EXT.has(ext) && !IMAGE_OK.some(p => f === p || f.startsWith(p + '/'))) {
      add(warnings, 'W008', f, '图片建议放在 source/、docs/ 或 output/');
    }
  }

  if (fs.existsSync(path.join(dir, 'design'))) add(warnings, 'W002', 'design', '方案目录应位于 data/designs/', '迁移后更新 project.json 和引用');
  if (!fs.existsSync(path.join(dir, 'README.md'))) add(warnings, 'W003', 'README.md', '缺少项目 README（需求、有效资料、当前版本、废弃方案）');
  if (!isIgnored(dir, 'output')) add(warnings, 'W004', 'output', 'output/ 未被 .gitignore 忽略', '在项目 .gitignore 添加 output/ 与 .space/');

  const lockFile = path.join(dir, 'space.lock.json');
  const current = VERSION;
  if (!fs.existsSync(lockFile)) add(warnings, 'W005', 'space.lock.json', '未锁定工具版本', '运行 space lock 写入当前版本');
  else {
    const l = readJson(lockFile);
    if (l.error) add(warnings, 'W005', 'space.lock.json', `无法解析：${l.error}`);
    else {
      const locked = String(l.value?.toolkit || '');
      if (!locked) add(warnings, 'W005', 'space.lock.json', '缺少 toolkit 版本');
      else if (!inCompatibilityWindow(locked, current)) add(warnings, 'W005', 'space.lock.json', `锁定 ${locked}，当前 CLI ${current}，超出兼容窗口（同 major 且 minor 差 ≤1）`, '重新运行 space lock --project project.json 刷新版本锁');
    }
  }

  for (const v of VENV_DIRS) if (fs.existsSync(path.join(dir, v))) {
    add(warnings, 'W006', v, '项目内虚拟环境应放在 .space/venv', 'space setup 会管理该目录');
  }

  return finish(result);
}

function finish(r) {
  for (const e of r.errors) e.severity = 'error';
  for (const w of r.warnings) w.severity = 'warning';
  r.errors.sort((a, b) => a.code.localeCompare(b.code) || a.path.localeCompare(b.path));
  r.warnings.sort((a, b) => a.code.localeCompare(b.code) || a.path.localeCompare(b.path));
  r.passed = r.errors.length === 0;
  r.summary = {errors: r.errors.length, warnings: r.warnings.length, toolkitVersion: VERSION};
  return r;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (k) => { const i = args.indexOf(k); if (i < 0) return undefined; const v = args[i + 1]; if (!v || v.startsWith('--')) { console.error(`缺少 ${k} 的值`); process.exit(2); } args.splice(i, 2); return v; };
  const project = option('--project');
  const strict = args.includes('--strict');
  const json = args.includes('--json');
  if (!project) { console.error('用法：space lint --project <project.json> [--strict] [--json]'); process.exit(2); }
  const r = lintProject(project);
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`${r.passed ? 'PASS' : 'FAIL'} ${r.id ?? '?'} — ${r.project}`);
    for (const x of [...r.errors, ...r.warnings]) {
      console.log(`  ${x.code} ${x.path}: ${x.message}`);
      if (x.fix) console.log(`       修复：${x.fix}`);
    }
    console.log(`  ${r.summary.errors} error / ${r.summary.warnings} warning（CLI ${r.summary.toolkitVersion}）`);
  }
  process.exitCode = r.errors.length || (strict && r.warnings.length) ? 1 : 0;
}
