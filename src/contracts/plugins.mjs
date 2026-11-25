// L0 契约：能力插件。插件只是「按契约注册一批能力」的另一种来源，
// 不引入新的运行方式：加载后与内置能力走同一个注册表与门面。
//
// 安全边界（本地单人工具，默认关闭）：
// - 插件是本地代码，加载即执行；因此必须显式开启（SPACE_PLUGINS=1）。
// - 插件目录固定，入口只允许插件目录内的相对 .mjs 路径，不许越界。
// - 插件能力不能覆盖内置能力 id，也不能与计划项重名。

export const PLUGIN_SCHEMA = 'space-plugin/v1';

export const PLUGIN_MANIFEST_FIELDS = ['schema', 'id', 'name', 'version', 'entry'];

const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

export function validatePluginManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['插件清单必须是对象'];
  for (const field of PLUGIN_MANIFEST_FIELDS) if (!(field in manifest)) problems.push(`插件清单缺少 ${field}`);
  if (manifest.schema !== PLUGIN_SCHEMA) problems.push(`插件 schema 应为 ${PLUGIN_SCHEMA}`);
  if (!ID_RE.test(String(manifest.id || ''))) problems.push(`插件 id 只允许小写字母、数字与连字符：${manifest.id}`);
  if (!manifest.name || typeof manifest.name !== 'string') problems.push('插件缺少名称');
  if (!SEMVER.test(String(manifest.version || ''))) problems.push(`插件版本需为 x.y.z：${manifest.version}`);

  const entry = String(manifest.entry || '');
  if (!entry) problems.push('插件缺少入口文件');
  else if (!entry.endsWith('.mjs')) problems.push(`插件入口必须是 .mjs：${entry}`);
  else if (entry.includes('..') || entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) problems.push(`插件入口不能越界：${entry}`);

  if (manifest.requires !== undefined && (!Array.isArray(manifest.requires) || manifest.requires.some(r => typeof r !== 'string'))) {
    problems.push('插件 requires 必须是字符串数组');
  }
  return problems;
}

// 开启方式只认显式值：默认关闭，避免 clone 下来就执行别人的代码。
export function pluginsEnabled(value) {
  return value === '1' || String(value || '').toLowerCase() === 'true';
}

// 插件来源：项目内 plugins/ 与用户目录下的 plugins/。顺序固定，便于复现。
export function pluginDirNames() {
  return ['project', 'user'];
}

export const PLUGIN_DIR_SUFFIX = 'plugins';

export function validatePluginIdFree(id, {builtin = [], planned = [], plugins = []} = {}) {
  if (builtin.includes(id)) return [`插件能力不能覆盖内置能力：${id}`];
  if (planned.includes(id)) return [`插件能力不能占用计划中的能力 id：${id}`];
  if (plugins.includes(id)) return [`插件能力 id 重复：${id}`];
  return [];
}
