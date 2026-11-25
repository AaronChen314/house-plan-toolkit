// 环境自检：Node、Python 与依赖、Chrome、可选 npm 依赖、技能包、项目目录规范。
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT, VERSION} from '../root.mjs';
import {findPython} from './python.mjs';
import {buildSkills} from './skills.mjs';

const PY_IMPORTS = ['ezdxf', 'shapely', 'jsonschema', 'numpy', 'PIL', 'cv2', 'scipy', 'fitz', 'pypdf'];

function run(cmd, args) {
  const r = spawnSync(cmd, args, {encoding: 'utf8'});
  return {ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim()};
}

function moduleAvailable(name) {
  try { return Boolean(import.meta.resolve(name)); } catch { return false; }
}

async function findChrome() {
  try {
    const {chromeCandidates} = await import('../checks/browser.mjs');
    const hit = chromeCandidates().find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
    if (hit) return hit;
  } catch { /* puppeteer-core 未安装时退回基础列表 */ }
  const known = [
    process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome', '/snap/bin/chromium'
  ].filter(Boolean);
  const hit = known.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (hit) return hit;
  for (const bin of ['google-chrome', 'chromium', 'chromium-browser', 'msedge']) {
    const r = run('which', [bin]);
    if (r.ok && r.out) return r.out;
  }
  return null;
}

export async function runDoctor({project, python} = {}) {
  const checks = [];
  const add = (name, status, detail, fix) => checks.push({name, status, detail, ...(fix ? {fix} : {})});

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('Node', nodeMajor >= 20 ? 'ok' : 'fail', `v${process.versions.node}`, nodeMajor >= 20 ? undefined : '升级到 Node.js 20 或更高');

  const py = python || findPython(project);
  const pyv = run(py, ['-V']);
  if (!pyv.ok) add('Python', 'fail', `找不到可用的 Python（${py}）`, '安装 Python 3.10+，或运行 space setup');
  else {
    const ver = pyv.out.replace(/^Python\s+/, '');
    const major = Number(ver.split('.')[0]), minor = Number(ver.split('.')[1]);
    add('Python', major === 3 && minor >= 10 ? 'ok' : 'fail', `${ver}（${py}）`, major === 3 && minor >= 10 ? undefined : '需要 Python 3.10 或更高');
    const missing = PY_IMPORTS.filter(m => !run(py, ['-c', `import ${m}`]).ok);
    add('Python 依赖', missing.length ? 'fail' : 'ok', missing.length ? `缺少 ${missing.join(', ')}` : `${PY_IMPORTS.length} 个模块可用`, missing.length ? '运行 space setup' : undefined);
  }

  // 索引依赖 node:sqlite；不可用时不影响使用，只是退回「每次解析」。
  const {INDEX_NODE_MIN, sqliteAvailable} = await import('../indexer/db.mjs');
  const sqlite = await sqliteAvailable();
  add('几何索引', sqlite ? 'ok' : 'warn', sqlite ? `node:sqlite 可用（v${process.versions.node}）` : `node:sqlite 不可用（v${process.versions.node}）`,
    sqlite ? undefined : `升级到 Node ${INDEX_NODE_MIN}+ 才能建立索引；当前退化为每次解析源图`);

  // 插件默认关闭；开启后报告加载结果与问题。
  const {pluginsEnabled} = await import('../contracts/plugins.mjs');
  const pluginOn = pluginsEnabled(process.env.SPACE_PLUGINS);
  const {initPlugins, pluginSummary} = await import('../capabilities/index.mjs');
  const pluginState = await initPlugins({projectDir: project ? path.dirname(path.resolve(project)) : undefined, enabled: pluginOn});
  const plugins = pluginSummary();
  add('能力插件', plugins.problems.length ? 'warn' : 'ok',
    pluginOn ? `${plugins.plugins.length} 个插件 · ${pluginState.capabilities.length} 个能力${plugins.problems.length ? ` · ${plugins.problems.length} 个问题` : ''}` : '已关闭（SPACE_PLUGINS=1 开启）',
    plugins.problems.length ? plugins.problems[0] : undefined);

  // 全局索引在项目之外，只存摘要。
  const {globalIndexFile, statGlobal} = await import('../indexer/global.mjs');
  const global = await statGlobal();
  add('全局索引', global.available ? 'ok' : 'warn',
    global.available ? `${global.projects} 个项目 · ${globalIndexFile()}` : `${global.reason}（只影响跨项目检索）`,
    global.available ? undefined : '需要 Node 22.5+；运行 space index global sync 建立');

  const chrome = await findChrome();
  add('Chrome', chrome ? 'ok' : 'warn', chrome || '未找到浏览器', chrome ? undefined : '设置 CHROME_PATH，或安装 Chrome/Chromium（只影响浏览器检查）');

  const blender = process.env.BLENDER_PATH || run('which', ['blender']).out || (fs.existsSync('/Applications/Blender.app/Contents/MacOS/Blender') ? '/Applications/Blender.app/Contents/MacOS/Blender' : null);
  add('Blender', blender ? 'ok' : 'warn', blender || '未找到（只影响 .blend 转 GLB）', blender ? undefined : '安装 Blender 或设置 BLENDER_PATH；仍可预览 GLB/FBX/OBJ');

  const optional = {'puppeteer-core': '浏览器检查', '@gltf-transform/core': 'GLB 资产处理', 'sharp': '图像处理'};
  const missingNpm = Object.entries(optional).filter(([name]) => !moduleAvailable(name));
  add('可选 npm 依赖', missingNpm.length ? 'warn' : 'ok', missingNpm.length ? `缺少 ${missingNpm.map(([n]) => n).join(', ')}` : '已安装', missingNpm.length ? `npm install ${missingNpm.map(([n]) => n).join(' ')}` : undefined);

  const skills = buildSkills({checkOnly: true});
  add('技能包', skills.ok ? 'ok' : 'fail', skills.ok ? `${skills.skills} 个技能，references 一致` : skills.errors[0] || '不一致', skills.ok ? undefined : 'space skills build');

  if (project) {
    const {lintProject} = await import('../checks/layout.mjs');
    const r = lintProject(path.resolve(project));
    add('项目目录', r.passed ? 'ok' : 'fail', `${r.errors.length} error / ${r.warnings.length} warning`, r.passed ? undefined : 'space lint --project ' + project);
  }

  return {version: VERSION, root: ROOT, checks, ok: checks.every(c => c.status !== 'fail')};
}
