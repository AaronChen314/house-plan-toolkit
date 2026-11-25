// L3 能力：插件加载。插件只是另一批能力声明，加载后与内置能力走同一注册表。
// 默认关闭；开启后仍是显式目录 + 显式清单，加载失败不影响内置能力。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {PLUGIN_DIR_SUFFIX, PLUGIN_SCHEMA, pluginsEnabled, validatePluginIdFree, validatePluginManifest} from '../contracts/plugins.mjs';
import {validateRegistry} from '../contracts/capability.mjs';

// 插件来源：项目内 plugins/ 与用户目录下 plugins/，顺序固定。
export function pluginDirs({projectDir, home = os.homedir()} = {}) {
  const dirs = [];
  if (projectDir) dirs.push(path.join(projectDir, PLUGIN_DIR_SUFFIX));
  dirs.push(path.join(home, '.config', 'house-plan', PLUGIN_DIR_SUFFIX));
  return dirs;
}

function readManifest(dir) {
  const file = path.join(dir, 'plugin.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return {__error: `plugin.json 无法解析：${e.message}`};
  }
}

function entryPath(dir, entry) {
  const resolved = path.resolve(dir, entry);
  if (!resolved.startsWith(dir + path.sep)) return null;
  return resolved;
}

// 加载一个插件目录：校验清单 → 导入入口 → 读 capabilities → 契约校验。
async function loadPluginDir(dir, {builtinIds, plannedIds, taken}) {
  const manifest = readManifest(dir);
  if (!manifest) return null;
  if (manifest.__error) return {problems: [`${dir}: ${manifest.__error}`]};
  const problems = validatePluginManifest(manifest).map(p => `${dir}: ${p}`);
  if (problems.length) return {problems};

  const entry = entryPath(dir, manifest.entry);
  if (!entry || !fs.existsSync(entry)) return {problems: [`${dir}: 入口文件不存在 ${manifest.entry}`]};

  let mod;
  try {
    mod = await import(pathToFileURL(entry).href);
  } catch (e) {
    return {problems: [`${dir}: 加载失败 ${e.message}`]};
  }
  const caps = Array.isArray(mod.capabilities) ? mod.capabilities : [];
  if (!caps.length) return {problems: [`${dir}: 没有导出 capabilities 数组`]};

  const capProblems = validateRegistry(caps).map(p => `${manifest.id}: ${p}`);
  const ids = caps.map(c => c.id);
  const all = [];
  for (const [i, cap] of caps.entries()) {
    all.push(...validatePluginIdFree(cap.id, {builtin: builtinIds, planned: plannedIds, plugins: [...taken, ...ids.slice(0, i)]}));
  }
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) all.push(`${manifest.id}: 插件内部能力 id 重复`);
  if (capProblems.length || all.length) return {problems: [...capProblems, ...all]};

  return {
    plugin: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      dir,
      description: manifest.description ?? ''
    },
    capabilities: caps.map(cap => ({...cap, plugin: {id: manifest.id, name: manifest.name, version: manifest.version}})),
    problems: []
  };
}

export async function loadPlugins({projectDir, home, builtinIds = [], plannedIds = [], enabled = pluginsEnabled(process.env.SPACE_PLUGINS)} = {}) {
  if (!enabled) return {enabled: false, loaded: [], capabilities: [], problems: []};

  const loaded = [];
  const capabilities = [];
  const problems = [];
  const taken = [];

  for (const dir of pluginDirs({projectDir, home})) {
    let entries;
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true});
    } catch {
      continue; // 目录不存在：正常情况
    }
    const isDir = (e) => {
      if (e.isDirectory()) return true;
      if (!e.isSymbolicLink()) return false;
      try { return fs.statSync(path.join(dir, e.name)).isDirectory(); } catch { return false; }
    };
    for (const entry of entries.filter(isDir).sort((a, b) => a.name.localeCompare(b.name))) {
      const result = await loadPluginDir(path.join(dir, entry.name), {builtinIds, plannedIds, taken});
      if (!result) continue;
      if (result.problems?.length) { problems.push(...result.problems); continue; }
      loaded.push(result.plugin);
      capabilities.push(...result.capabilities);
      taken.push(...result.capabilities.map(c => c.id));
    }
  }

  return {enabled: true, loaded, capabilities, problems};
}
