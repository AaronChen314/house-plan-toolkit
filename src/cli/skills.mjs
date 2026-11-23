#!/usr/bin/env node
// 技能包：references 由 docs/ 单一源生成。构建、校验与安装。
// 用法：space skills build | check | sync --project <dir> [--target .agents/skills] | list
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ROOT, VERSION} from '../root.mjs';

const SKILLS_DIR = path.join(ROOT, 'skills');
const DOCS_DIR = path.join(ROOT, 'docs');
const BUNDLE = path.join(SKILLS_DIR, 'skills.json');
const STATE = path.join(SKILLS_DIR, '.bundle.json');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function readBundle() {
  return JSON.parse(fs.readFileSync(BUNDLE, 'utf8'));
}

function frontmatter(skillFile) {
  const text = fs.readFileSync(skillFile, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return meta;
}

// 复制进技能后，指向技能目录之外的链接改成同目录文件名；不存在则降级为纯文本。
function sanitizeLinks(text, copied) {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, label, target) => {
    if (/^(https?:|#|mailto:)/.test(target)) return whole;
    const base = path.basename(target.split('#')[0]);
    if (copied.has(base)) return `[${label}](${base}${target.includes('#') ? '#' + target.split('#')[1] : ''})`;
    return `${label}（${target}）`;
  });
}

function links(text) {
  const out = [];
  const re = /\[[^\]]+\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

function relativeLinksOk(skillDir, file) {
  const problems = [];
  for (const target of links(fs.readFileSync(file, 'utf8'))) {
    if (/^(https?:|#|mailto:)/.test(target)) continue;
    const clean = target.split('#')[0];
    if (!clean) continue;
    const abs = path.resolve(path.dirname(file), clean);
    if (!fs.existsSync(abs)) problems.push(`${path.relative(skillDir, file)} → ${target}`);
  }
  return problems;
}

function listFiles(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(abs, base, out);
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

export function buildSkills({checkOnly = false} = {}) {
  const bundle = readBundle();
  const errors = [], warnings = [], state = {schema: 'skills-state/v1', version: VERSION, skills: {}};
  const names = Object.keys(bundle.references);
  const stateFile = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null;

  for (const name of names) {
    const dir = path.join(SKILLS_DIR, name);
    const skillFile = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) { errors.push(`缺少 ${name}/SKILL.md`); continue; }
    const meta = frontmatter(skillFile);
    if (!meta.name || meta.name !== name) errors.push(`${name}/SKILL.md frontmatter name 缺失或与目录不一致`);
    if (!meta.description) errors.push(`${name}/SKILL.md 缺少 description`);

    const refs = bundle.references[name] || [];
    const refDir = path.join(dir, 'references');
    const copied = new Set(refs.map(r => path.basename(r)));
    const hashes = {};

    for (const doc of refs) {
      const src = path.join(ROOT, doc);
      if (!fs.existsSync(src)) { errors.push(`${name}: ${doc} 不存在`); continue; }
      const raw = fs.readFileSync(src, 'utf8');
      const content = sanitizeLinks(raw, copied);
      const hash = sha(raw);
      hashes[path.basename(doc)] = hash;
      if (checkOnly) {
        const dst = path.join(refDir, path.basename(doc));
        if (!fs.existsSync(dst)) errors.push(`${name}: references/${path.basename(doc)} 未生成，运行 space skills build`);
        else if (fs.readFileSync(dst, 'utf8') !== content) errors.push(`${name}: references/${path.basename(doc)} 与 ${doc} 不一致，运行 space skills build`);
      } else {
        fs.mkdirSync(refDir, {recursive: true});
        fs.writeFileSync(path.join(refDir, path.basename(doc)), content);
      }
    }

    if (checkOnly) {
      for (const rel of listFiles(refDir)) {
        if (!copied.has(path.basename(rel))) errors.push(`${name}: references/${rel} 未在 skills.json 声明，运行 space skills build`);
      }
      for (const problem of relativeLinksOk(dir, skillFile)) errors.push(`${name}/SKILL.md 链接失效：${problem}`);
      for (const rel of listFiles(refDir)) {
        for (const problem of relativeLinksOk(dir, path.join(refDir, rel))) errors.push(`${name}/references/${rel} 链接失效：${problem}`);
      }
    } else {
      for (const rel of listFiles(refDir)) {
        if (!copied.has(path.basename(rel))) fs.rmSync(path.join(refDir, rel));
      }
      for (const orphan of fs.readdirSync(SKILLS_DIR, {withFileTypes: true})) {
        if (orphan.isDirectory() && !names.includes(orphan.name)) warnings.push(`skills/${orphan.name} 未在 skills.json 声明`);
      }
    }

    state.skills[name] = {skillSha256: sha(fs.readFileSync(skillFile)), references: hashes};
  }

  if (checkOnly && stateFile) {
    if (stateFile.version !== VERSION) errors.push(`.bundle.json 版本 ${stateFile.version} 与 package ${VERSION} 不一致，运行 space skills build`);
    for (const [name, info] of Object.entries(state.skills)) {
      const prev = stateFile.skills?.[name];
      if (!prev) continue;
      if (prev.skillSha256 !== info.skillSha256) errors.push(`${name}: SKILL.md 改了但未重新 build（只影响哈希记录）`);
    }
  }
  if (!checkOnly) {
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
  } else if (!stateFile) {
    errors.push('skills/.bundle.json 缺失，运行 space skills build');
  }

  return {ok: errors.length === 0, version: VERSION, skills: names.length, errors, warnings};
}

export function syncSkills({target, project}) {
  const bundle = readBundle();
  const dest = path.resolve(project || '.', target || '.agents/skills');
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : buildState();
  fs.mkdirSync(dest, {recursive: true});
  for (const name of Object.keys(bundle.references)) {
    const src = path.join(SKILLS_DIR, name);
    const out = path.join(dest, name);
    fs.rmSync(out, {recursive: true, force: true});
    copyDir(src, out);
  }
  fs.writeFileSync(path.join(dest, '.skills-version'), JSON.stringify({version: VERSION, skills: Object.keys(bundle.references), installedAt: new Date().toISOString()}, null, 2) + '\n');
  return {dest, skills: Object.keys(bundle.references), version: VERSION, state};
}

function buildState() {
  const bundle = readBundle();
  const skills = {};
  for (const name of Object.keys(bundle.references)) {
    const dir = path.join(SKILLS_DIR, name);
    skills[name] = {skillSha256: sha(fs.readFileSync(path.join(dir, 'SKILL.md'))), references: {}};
  }
  return {schema: 'skills-state/v1', version: VERSION, skills};
}

function copyDir(src, dst, filter = () => true) {
  fs.mkdirSync(dst, {recursive: true});
  for (const e of fs.readdirSync(src, {withFileTypes: true})) {
    const rel = e.name;
    if (!filter(rel)) continue;
    const s = path.join(src, rel), d = path.join(dst, rel);
    if (e.isDirectory()) copyDir(s, d, filter);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

export function listSkills() {
  const bundle = readBundle();
  return Object.keys(bundle.references).map(name => {
    const meta = frontmatter(path.join(SKILLS_DIR, name, 'SKILL.md'));
    return {name, description: meta.description || '', references: bundle.references[name].length};
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const action = args.shift() || 'list';
  const opt = (k) => { const i = args.indexOf(k); if (i < 0) return undefined; return args[i + 1]; };
  if (action === 'list') {
    for (const s of listSkills()) console.log(`${s.name}\n  ${s.description}\n  references: ${s.references}`);
  } else if (action === 'build') {
    const r = buildSkills();
    console.log(r.ok ? `已生成 ${r.skills} 个技能的 references（v${r.version}）` : '生成失败');
    r.errors.forEach(e => console.error('  ' + e));
    r.warnings.forEach(w => console.warn('  警告：' + w));
    process.exitCode = r.ok ? 0 : 1;
  } else if (action === 'check') {
    const r = buildSkills({checkOnly: true});
    console.log(r.ok ? `技能包一致：${r.skills} 个技能，链接全部可解析` : '技能包不一致');
    r.errors.forEach(e => console.error('  ' + e));
    r.warnings.forEach(w => console.warn('  警告：' + w));
    process.exitCode = r.ok ? 0 : 1;
  } else if (action === 'sync') {
    const r = syncSkills({project: opt('--project') || '.', target: opt('--target')});
    console.log(`已同步 ${r.skills.length} 个技能到 ${r.dest}（v${r.version}）`);
  } else {
    console.error('用法：space skills build|check|sync --project <dir> [--target .agents/skills]|list');
    process.exit(2);
  }
}
