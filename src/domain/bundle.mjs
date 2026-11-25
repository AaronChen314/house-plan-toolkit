// L1 领域：交付包条目、包内 index.html 与单文件只读快照的纯逻辑。
// 这里只决定「哪些文件进包、包里叫什么、清单长什么样」；读写与哈希都在 L2/L3。
// 三个输出都是确定性的：同输入字节相同，不写入任何生成时间。
import {BUNDLE_ROLES, MAX_SNAPSHOT_BYTES} from '../contracts/rendering.mjs';
import {entryRoleOf} from './rendering.mjs';

const DOC_ROOT = 'output/doc/';
const RENDER_ROOT = 'output/render/';

// 快照里内嵌的数据段：键名固定，方便离线打开时按名称定位。
export const SNAPSHOT_SECTIONS = ['design', 'dataset', 'model', 'docManifest', 'renders'];

// 角色在页面上的中文说明；键取自契约的 BUNDLE_ROLES。
const ROLE_LABELS = {
  manifest: '包清单',
  design: '设计版本',
  dataset: '数据集',
  model: '三维模型',
  document: '施工图',
  render: '渲染图',
  data: '数据'
};

const posix = (value) => String(value ?? '').replace(/\\/g, '/');

function padSeq(seq) {
  return String(Number.isInteger(seq) && seq > 0 ? seq : 1).padStart(3, '0');
}

// 角色沿用 entryRoleOf 的判定，保证包的清单与存储登记用的是同一套分类。
function roleOf(source, fallback = 'data') {
  const role = entryRoleOf(source);
  return BUNDLE_ROLES.includes(role) ? role : fallback;
}

function designSources(design) {
  if (!design) return [];
  const versionFile = posix(design.versionFile ?? design.file ?? '');
  const designFileRel = posix(design.designFile ?? '');
  const out = [];
  if (designFileRel) out.push({path: designFileRel, role: roleOf(designFileRel, 'design'), target: 'design/design.json'});
  if (versionFile) out.push({path: versionFile, role: roleOf(versionFile, 'design'), target: `design/versions/${padSeq(design.seq)}.json`});
  return out;
}

function datasetSources(dataset) {
  const file = posix(typeof dataset === 'string' ? dataset : dataset?.file ?? '');
  return file ? [{path: file, role: roleOf(file, 'dataset'), target: 'dataset/dataset.json'}] : [];
}

function modelSources(model) {
  const file = posix(typeof model === 'string' ? model : model?.file ?? model?.path ?? '');
  if (!file) return [];
  // 数据集里的 model.json 是三维输入。entryRoleOf 只把 output/model/* 判为 model，
  // 这里按同一组角色里的 model 记，包里路径也归到 dataset/ 下——包的读者先看角色再看路径。
  return [{path: file, role: 'model', target: 'dataset/model.json'}];
}

// 交付物只在清单里认方案版本：清单记录带 inputs.design，按它过滤，避免把别的方案塞进包。
function docBelongs(record, design) {
  const d = record?.inputs?.design;
  return !!d && d.scheme === design.scheme && Number(d.seq) === Number(design.seq);
}

function docSources(docManifest, design) {
  const out = [];
  for (const record of Object.values(docManifest?.docs || {})) {
    const file = posix(record?.file ?? '');
    if (!file.startsWith(DOC_ROOT)) continue;
    if (design?.scheme && !docBelongs(record, design)) continue;
    out.push({path: file, role: 'document', target: `doc/${file.slice(DOC_ROOT.length)}`});
  }
  return out;
}

// 渲染产物文件名带方案与版本（a-001.svg），这是 renderFile() 的约定，按它过滤。
function matchesDesignVersion(file, design) {
  const base = file.split('/').pop() || '';
  const prefix = `${design.scheme}-${padSeq(design.seq)}`;
  return base === prefix || base.startsWith(`${prefix}.`);
}

function renderSources(renderFiles, design) {
  const out = [];
  for (const item of Array.isArray(renderFiles) ? renderFiles : []) {
    const file = posix(typeof item === 'string' ? item : item?.path ?? '');
    if (!file.startsWith(RENDER_ROOT)) continue;
    if (design?.scheme && !matchesDesignVersion(file, design)) continue;
    out.push({path: file, role: 'render', target: `render/${file.slice(RENDER_ROOT.length)}`});
  }
  return out;
}

// 交付包条目：path 是项目内源路径，target 是包内路径，role 用于清单分类。
export function collectBundleSources({design = null, dataset = null, model = null, docManifest = null, renderFiles = []} = {}) {
  const rows = [
    ...designSources(design),
    ...datasetSources(dataset),
    ...modelSources(model),
    ...docSources(docManifest, design),
    ...renderSources(renderFiles, design)
  ];
  const byPath = new Map();
  for (const row of rows) {
    if (!row.path || byPath.has(row.path)) continue;
    byPath.set(row.path, row);
  }
  // 包里路径唯一，按包里路径排序：清单与 index.html 的字节因此稳定。
  return [...byPath.values()].sort((a, b) => a.target.localeCompare(b.target) || a.path.localeCompare(b.path));
}

// 快照只带当前方案版本的交付物条目：清单里别的方案的东西不进客户的单文件。
export function scopeDocManifest(docManifest, design) {
  if (!docManifest || typeof docManifest !== 'object') return null;
  const picked = Object.entries(docManifest.docs || {})
    .filter(([, record]) => !design?.scheme || docBelongs(record, design))
    .sort(([a], [b]) => a.localeCompare(b));
  return {...docManifest, docs: Object.fromEntries(picked)};
}

// 包内 index.html 是给人看的离线清单：条目、角色、哈希。没有脚本，没有时间戳。
export function bundleIndexHtml(manifest = {}) {
  const entries = [...(manifest.entries || [])]
    .map(e => ({path: String(e.path ?? ''), role: String(e.role ?? ''), sha256: String(e.sha256 ?? ''), bytes: Number(e.bytes) || 0}))
    .sort((a, b) => a.path.localeCompare(b.path));
  const total = entries.reduce((n, e) => n + e.bytes, 0);
  const byRole = {};
  for (const entry of entries) byRole[entry.role] = (byRole[entry.role] || 0) + 1;
  const roleText = Object.keys(byRole).sort().map(role => `${roleLabel(role)} ${byRole[role]}`).join('、') || '无';
  const designText = manifest.design?.scheme ? `${manifest.design.scheme}#${padSeq(manifest.design.seq)}` : '—';
  const rows = entries.map(e =>
    `        <tr><td>${escapeHtml(e.path)}</td><td>${escapeHtml(roleLabel(e.role))}</td>` +
    `<td class="sha">${escapeHtml(e.sha256)}</td><td class="num">${e.bytes}</td></tr>`
  ).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>交付包 ${escapeHtml(manifest.name || '（未命名）')}</title>
<style>
:root {color-scheme: light dark}
body {font: 14px/1.6 -apple-system, "Segoe UI", "Noto Sans SC", sans-serif; margin: 0; padding: 32px; background: #f6f5f2; color: #1f2d26}
main {max-width: 960px; margin: 0 auto}
h1 {font-size: 20px; margin: 0 0 4px}
p.meta {margin: 0 0 24px; color: #5f6f66}
table {width: 100%; border-collapse: collapse; background: #fff}
th, td {text-align: left; padding: 6px 10px; border-bottom: 1px solid #e3e0d8; vertical-align: top}
th {font-weight: 600; background: #efede7}
td.sha {font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all}
td.num {text-align: right; font-variant-numeric: tabular-nums}
footer {margin-top: 16px; color: #5f6f66}
</style>
</head>
<body>
<main>
<h1>交付包 ${escapeHtml(manifest.name || '（未命名）')}</h1>
<p class="meta">设计版本 ${escapeHtml(designText)} · ${entries.length} 个文件 · ${formatBytes(total)}</p>
<p class="meta">只读交付：包内文件只用于查看与校验，不能作为任何能力的输入，也不能回写项目数据。</p>
<table>
<thead><tr><th>包内路径</th><th>角色</th><th>SHA-256</th><th>字节</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<footer>按角色统计：${escapeHtml(roleText)}。逐文件哈希与 manifest.json 一致即可确认包未被改动。</footer>
</main>
</body>
</html>
`;
}

// 内嵌 JSON 的安全转义：< 与 & 一律转成 \u 转义，避免数据里的 </script> 提前闭合标签。
// 转义后仍是合法 JSON（JSON.parse 能还原原始字符串）。
export function embedJson(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// 单文件只读快照：内嵌数据 + 哈希清单 + 一段「只读、离线、不能回写」的说明。
// 不带时间戳；体积超过 MAX_SNAPSHOT_BYTES 直接拒绝，不交一个打不开的文件。
export function snapshotHtml({design = null, dataset = null, model = null, docManifest = null, renders = [], hashes = [], name = ''} = {}) {
  const list = [...(Array.isArray(hashes) ? hashes : [])]
    .map(h => ({path: String(h?.path ?? ''), sha256: String(h?.sha256 ?? ''), ...(Number.isFinite(h?.bytes) ? {bytes: Number(h.bytes)} : {})}))
    .sort((a, b) => a.path.localeCompare(b.path));
  const sections = {
    design,
    dataset,
    model,
    docManifest,
    renders: Array.isArray(renders) ? renders : []
  };
  // 快照里的 design 通常是「版本对象 + 文件与哈希」的包装，方案号可能在包装外也可能在 value 里。
  const designHead = design?.scheme ? design : design?.value ?? null;
  const designText = designHead?.scheme ? `${designHead.scheme}#${padSeq(designHead.seq)}` : '—';
  const title = name || designText;
  const payload = {writable: false, offline: true, name: name || null, ...sections};
  const rows = list.map(h =>
    `        <tr><td>${escapeHtml(h.path)}</td><td class="sha">${escapeHtml(h.sha256)}</td>` +
    `<td class="num">${Number.isFinite(h.bytes) ? h.bytes : ''}</td></tr>`
  ).join('\n');
  const sectionItems = SNAPSHOT_SECTIONS
    .map(key => `        <li><code>${key}</code> · ${escapeHtml(sectionSummary(key, sections[key]))}</li>`)
    .join('\n');

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>只读快照 · ${escapeHtml(title)}</title>
<style>
:root {color-scheme: light dark}
body {font: 14px/1.6 -apple-system, "Segoe UI", "Noto Sans SC", sans-serif; margin: 0; padding: 32px; background: #f6f5f2; color: #1f2d26}
main {max-width: 960px; margin: 0 auto}
h1 {font-size: 20px; margin: 0 0 4px}
h2 {font-size: 15px; margin: 24px 0 8px}
p.meta {margin: 0 0 8px; color: #5f6f66}
p.notice {margin: 16px 0 24px; padding: 12px 14px; border-left: 3px solid #b3261e; background: #fff}
table {width: 100%; border-collapse: collapse; background: #fff}
th, td {text-align: left; padding: 6px 10px; border-bottom: 1px solid #e3e0d8; vertical-align: top}
th {font-weight: 600; background: #efede7}
td.sha {font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all}
td.num {text-align: right; font-variant-numeric: tabular-nums}
ul {margin: 0; padding-left: 20px}
code {font-family: ui-monospace, SFMono-Regular, Menlo, monospace}
</style>
</head>
<body>
<main>
<h1>只读快照 · ${escapeHtml(title)}</h1>
<p class="meta">设计版本 ${escapeHtml(designText)} · 内嵌 ${SNAPSHOT_SECTIONS.length} 段数据 · ${list.length} 个文件哈希</p>
<p class="notice"><strong>只读、离线、不能回写。</strong>本文件是一份自包含的交付快照：数据取自生成时的设计版本，页面不联网、不加载外部资源，也没有任何写回项目的接口。要改结论请回到项目里出新的设计版本，再重新生成快照。</p>
<h2>哈希清单</h2>
<table>
<thead><tr><th>文件</th><th>SHA-256</th><th>字节</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<h2>内嵌数据</h2>
<ul>
${sectionItems}
</ul>
</main>
<script type="application/json" id="space-snapshot">${embedJson(payload)}</script>
<script type="application/json" id="space-hashes">${embedJson(list)}</script>
</body>
</html>
`;

  const bytes = utf8Bytes(html);
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new Error(`只读快照 ${bytes} 字节，超过体积上限 ${MAX_SNAPSHOT_BYTES} 字节；请缩小范围或分方案导出`);
  }
  return html;
}

// UTF-8 字节数：快照体积上限按写盘后的字节算，中文字符不能按字符数计。
export function utf8Bytes(text) {
  return new TextEncoder().encode(String(text ?? '')).length;
}

function sectionSummary(key, value) {
  if (value === null || value === undefined) return '未内嵌';
  if (key === 'renders') return `${(Array.isArray(value) ? value : []).length} 张渲染图`;
  if (key === 'docManifest') return `${Object.keys(value?.docs || {}).length} 条交付物`;
  if (Array.isArray(value)) return `${value.length} 项`;
  return '已内嵌';
}

function roleLabel(role) {
  return ROLE_LABELS[role] ? `${ROLE_LABELS[role]}（${role}）` : role;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
