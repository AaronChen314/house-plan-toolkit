#!/usr/bin/env node
// 公开面审计：确保发布到 GitHub / npm 的内容只有工具与技能，不含任何项目内容。
// 用法：node toolkit/checks/public-surface.mjs [--root .] [--manifest publish-manifest.json]
//         [--layout target] [--denylist <私有词表>] [--history-ref <ref>] [--no-history] [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const BINARY_EXT = new Set(['.glb', '.gltf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.pdf', '.zip', '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.mov', '.gltf']);
const ABSOLUTE_PATH = [/\/(?:Users)\/[A-Za-z0-9._-]+/, /\/(?:home)\/[A-Za-z0-9._-]+/, /[A-Za-z]:\\(?:Users|Documents|Desktop)[\\/]/];
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function readJson(file) {
  try { return {value: JSON.parse(fs.readFileSync(file, 'utf8'))}; }
  catch (e) { return {error: e.message}; }
}

function walk(dir, rel = '', out = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(dir, rel), {withFileTypes: true}); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.name === '.git' || e.name === 'node_modules') continue;
    if (e.isDirectory()) walk(dir, r, out);
    else if (e.isFile()) out.push(r);
  }
  return out;
}

export function trackedFiles(root) {
  const r = spawnSync('git', ['ls-files', '-z'], {cwd: root, maxBuffer: 64 * 1024 * 1024});
  if (r.status !== 0) return walk(root);
  return r.stdout.toString('utf8').split('\0').filter(Boolean);
}

export function parseDenylist(file) {
  if (!file) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const terms = [];
  for (const raw of lines) {
    const s = raw.trim();
    if (!s || s.startsWith('#')) continue;
    if (s.startsWith('re:')) { try { terms.push({re: new RegExp(s.slice(3), 'i')}); } catch {} }
    else terms.push({text: s});
  }
  return terms;
}

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function allowedPath(p, layout) {
  if ((layout.allowFiles || []).includes(p)) return true;
  return (layout.allowDirectories || []).some(d => p === d || p.startsWith(d + '/'));
}

function historyForbidden(p, denyExtensions) {
  const ext = path.extname(p).toLowerCase();
  if (denyExtensions.includes(ext)) return true;
  const first = p.split('/')[0];
  return ['projects', 'output', 'source'].includes(first);
}

export function verifyPublic(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const manifestFile = path.resolve(root, opts.manifest || 'publish-manifest.json');
  const errors = [];
  const add = (code, p, message, extra = {}) => errors.push({code, path: p, message, ...extra});

  const mf = readJson(manifestFile);
  if (mf.error) return fail([{code: 'P000', path: path.basename(manifestFile), message: `无法读取发布白名单：${mf.error}`}], opts, root);
  const manifest = mf.value || {};
  const layoutName = opts.layout || 'target';
  const layout = manifest.layouts?.[layoutName];
  if (!layout) return fail([{code: 'P000', path: path.basename(manifestFile), message: `白名单缺少 layouts.${layoutName}`}], opts, root);

  const denyExtensions = (layout.denyExtensions || []).map(e => e.toLowerCase());
  const files = trackedFiles(root);
  const registered = manifest.binaries?.registered || {};
  const terms = opts.terms || [];
  const assets = new Map();

  for (const rel of (layout.assetManifests || manifest.assetManifests || [])) {
    const f = path.resolve(root, rel);
    const a = readJson(f);
    if (a.error) { add('P007', rel, `资产清单无法解析：${a.error}`); continue; }
    const dir = path.dirname(rel);
    const models = a.value?.models && typeof a.value.models === 'object' ? a.value.models : a.value;
    for (const [id, v] of Object.entries(models || {})) {
      if (!v || typeof v !== 'object' || !('file' in v)) continue;
      const missing = ['license', 'source'].filter(k => !v[k]);
      if (missing.length) add('P007', `${rel}#${id}`, `资产缺少 ${missing.join('/')} 字段`);
      const assetPath = path.posix.normalize(`${dir}/${v.file}`.replace(/^\.\//, ''));
      assets.set(assetPath, {id, ...v});
      if (!fs.existsSync(path.resolve(root, assetPath))) add('P007', assetPath, `资产清单引用的文件不存在（${id}）`);
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) add('P007', `${rel}#${id}`, '资产 id 必须是 ASCII kebab-case，不含项目痕迹');
    }
  }

  for (const p of files) {
    if (!allowedPath(p, layout)) add('P001', p, `不在 ${layoutName} 白名单内`, {fix: '登记到 publish-manifest.json 或移出仓库'});
    const ext = path.extname(p).toLowerCase();
    if (denyExtensions.includes(ext)) add('P002', p, `禁止发布的文件类型：${ext}`);

    const abs = path.resolve(root, p);
    const binary = BINARY_EXT.has(ext);
    if (binary && !assets.has(p)) {
      const reg = registered[p];
      if (!reg) add('P006', p, '二进制未登记（需 source/license 与哈希）', {fix: '写入 publish-manifest.json 的 binaries.registered'});
      else {
        if (!reg.license || !reg.source) add('P006', p, '登记项缺少 license/source');
        if (reg.sha256 && fs.existsSync(abs) && sha256(abs) !== reg.sha256) add('P006', p, `哈希不符：期望 ${reg.sha256.slice(0, 12)}…`);
      }
    }

    if (binary || !fs.existsSync(abs)) continue;
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.size > MAX_TEXT_BYTES) continue;
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const re of ABSOLUTE_PATH) if (re.test(lines[i])) add('P003', p, `第 ${i + 1} 行含本机绝对路径`, {line: i + 1});
    }
  }

  // 词表扫描与结构检查共用一次文件遍历
  if (terms.length) {
    for (const p of files) {
      const ext = path.extname(p).toLowerCase();
      if (BINARY_EXT.has(ext)) {
        for (const t of terms) if (!t.re && p.toLowerCase().includes(t.text.toLowerCase())) add('P004', p, `文件名命中敏感词「${t.text}」`);
        continue;
      }
      const abs = path.resolve(root, p);
      let text;
      try { if (fs.statSync(abs).size > MAX_TEXT_BYTES) continue; text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      if (text.includes('\0')) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        for (const t of terms) {
          const hit = t.re ? t.re.test(lines[i]) : lines[i].toLowerCase().includes(t.text.toLowerCase());
          if (hit) add('P004', p, `第 ${i + 1} 行命中敏感词${t.text ? `「${t.text}」` : ''}`, {line: i + 1});
        }
      }
    }
  }

  if (opts.history !== false) {
    const ref = opts.historyRef || 'HEAD';
    const h = spawnSync('git', ['log', ref, '--diff-filter=A', '--name-only', '--pretty=format:'], {cwd: root, maxBuffer: 64 * 1024 * 1024});
    if (h.status === 0) {
      const seen = new Set();
      for (const line of h.stdout.toString('utf8').split(/\r?\n/)) {
        const p = line.trim();
        if (!p || seen.has(p)) continue;
        seen.add(p);
        if (historyForbidden(p, denyExtensions)) add('P005', p, '历史提交中出现过项目/生成物路径', {fix: '公开仓库必须从全新历史开始'});
      }
    }
  }

  return finish(errors, {layout: layoutName, files: files.length, assets: assets.size}, root);
}

function fail(errors, opts, root) {
  return finish(errors, {layout: opts.layout || 'target', files: 0, assets: 0}, root);
}

function finish(errors, counts, root) {
  const byCode = {};
  for (const e of errors) byCode[e.code] = (byCode[e.code] || 0) + 1;
  return {schema: 'publish-surface-report/v1', root, passed: errors.length === 0, counts: {...counts, violations: errors.length, byCode}, errors};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (k) => { const i = args.indexOf(k); if (i < 0) return undefined; const v = args[i + 1]; if (!v || v.startsWith('--')) { console.error(`缺少 ${k} 的值`); process.exit(2); } args.splice(i, 2); return v; };
  const root = option('--root') || '.';
  const manifest = option('--manifest') || 'publish-manifest.json';
  const layout = option('--layout') || 'target';
  // 词表默认位置：显式参数 → 环境变量 → ~/.config/house-plan/denylist.txt
  const defaultDenylist = path.join(os.homedir(), '.config', 'house-plan', 'denylist.txt');
  const denylist = option('--denylist') || process.env.SPACE_DENYLIST || (fs.existsSync(defaultDenylist) ? defaultDenylist : null);
  const json = args.includes('--json');
  const limit = Number(option('--limit') || 15);

  let terms = [];
  if (denylist) {
    try { terms = parseDenylist(denylist); }
    catch (e) { console.error(`无法读取敏感词表 ${denylist}：${e.message}`); process.exit(2); }
  }
  const report = verifyPublic({root, manifest, layout, terms, historyRef: option('--history-ref') || 'HEAD', history: !args.includes('--no-history')});
  report.counts.denylist = terms.length;

  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.passed ? 'PASS' : 'FAIL'} public-surface · layout=${report.counts.layout} · files=${report.counts.files} · denylist=${terms.length ? terms.length + ' 条' : '未提供（仅做结构性检查）'}`);
    const groups = new Map();
    for (const e of report.errors) {
      if (!groups.has(e.code)) groups.set(e.code, []);
      groups.get(e.code).push(e);
    }
    for (const [code, list] of [...groups].sort()) {
      console.log(`  ${code} ×${list.length}`);
      for (const e of list.slice(0, limit)) console.log(`    ${e.path}${e.line ? `:${e.line}` : ''} — ${e.message}`);
      if (list.length > limit) console.log(`    …另有 ${list.length - limit} 条（--limit 调整，--json 查看全部）`);
    }
  }
  process.exitCode = report.passed ? 0 : 1;
}
