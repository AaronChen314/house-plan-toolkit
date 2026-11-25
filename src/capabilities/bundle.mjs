// L3 能力：交付包导出与单文件只读快照。
// 包的输入固定为「数据集 + 设计版本 + 空间模型 + 交付清单 + 渲染图」，产物只写 output/。
// 包里每个文件都有哈希；同名包内容不同时必须显式 force——不静默覆盖已经交出去的包。
import fs from 'node:fs';
import path from 'node:path';
import {fail} from '../contracts/errors.mjs';
import {datasetFile, designFile, designVersionFile} from '../contracts/graph.mjs';
import {validateDataset, validateDesignVersion} from '../contracts/datasets.mjs';
import {docManifestFile} from '../contracts/documents.mjs';
import {
  MAX_SNAPSHOT_BYTES, bundleDir, bundleManifest, bundleManifestFile,
  snapshotFile, snapshotRecord, validateBundle, validateSnapshot
} from '../contracts/rendering.mjs';
import {bundleIndexHtml, collectBundleSources, scopeDocManifest, snapshotHtml} from '../domain/bundle.mjs';
import {readManifest} from '../store/documents.mjs';
import {sha256 as digest} from '../store/atomic.mjs';

// 文本类渲染产物直接内嵌；二进制走 base64，快照始终是单个 HTML。
const TEXT_EXTS = new Set(['.svg', '.json', '.html', '.htm', '.txt', '.md', '.css']);
const PAD = (seq) => String(seq).padStart(3, '0');

function readValid(ctx, rel, validate, label) {
  if (!ctx.store.exists(rel)) throw fail('E_DATA_REFERENCE', `${label}不存在：${rel}`, {file: rel});
  const value = ctx.store.readJson(rel);
  if (typeof value?.schema !== 'string') throw fail('E_DATA_SCHEMA', `${label}缺少 schema：${rel}`, {file: rel});
  const problems = validate(value);
  if (problems.length) throw fail('E_DATA_INVALID', `${label}不符合契约：${problems.join('；')}`, {file: rel, problems});
  return value;
}

// 交付包与快照共用的输入链：设计版本 → 数据集 → 空间模型。模型缺失时只跳过三维那一段。
function resolveInputs(ctx, {scheme, seq}) {
  let versionRel;
  try { versionRel = designVersionFile(scheme, seq); } catch (e) { throw fail('E_EXEC_PARAM', e.message, {scheme, seq}); }
  const version = readValid(ctx, versionRel, validateDesignVersion, '设计版本');
  if (!version.dataset) throw fail('E_DATA_RULE', `${scheme}#${PAD(seq)} 没有引用数据集，无法打包`, {scheme, seq});

  let dsRel;
  try { dsRel = datasetFile(version.dataset); } catch (e) { throw fail('E_EXEC_PARAM', e.message, {dataset: version.dataset}); }
  const dataset = readValid(ctx, dsRel, validateDataset, '数据集');

  const modelRel = dataset.model || `data/datasets/${version.dataset}/model.json`;
  let model = null;
  if (ctx.store.exists(modelRel)) {
    model = ctx.store.readJson(modelRel);
    if (model?.schema !== 'space-model/v1') throw fail('E_DATA_SCHEMA', `${modelRel} 不是 space-model/v1`, {file: modelRel});
  }

  let designRel = null;
  try { designRel = designFile(scheme); } catch { designRel = null; }
  return {
    version,
    versionRel,
    dataset,
    dsRel,
    model,
    modelRel: model ? modelRel : null,
    designFileRel: designRel && ctx.store.exists(designRel) ? designRel : null
  };
}

// 只读目录：渲染图目录由生成侧写入，可能不存在——不存在就是没有渲染图。
function listFiles(dir, base = dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return out; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(abs, base, out);
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

function renderFilesOf(ctx) {
  return listFiles(path.join(ctx.dir, 'output/render')).map(rel => `output/render/${rel}`);
}

function readExisting(ctx, rel) {
  if (!ctx.store.exists(rel)) return null;
  try { return ctx.store.readJson(rel); } catch { return null; }
}

function entriesKey(entries = []) {
  return entries
    .map(e => `${e.path}|${e.role}|${e.sha256}|${e.bytes}`)
    .sort()
    .join('\n');
}

function jsonText(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

export const capabilities = [
  {
    id: 'bundle.export',
    version: '1.0.0',
    stage: 'delivery',
    title: '导出交付包',
    description: '把设计版本、数据集、空间模型、施工图与渲染图按角色拷进输出目录的交付包，并写逐文件哈希清单与离线 index.html。',
    params: [
      {key: 'scheme', label: '方案 id', type: 'text', required: true},
      {key: 'seq', label: '版本号', type: 'number', required: true},
      {key: 'name', label: '包名（默认 方案-版本）', type: 'text'},
      {key: 'force', label: '同名包内容不同时仍然覆盖', type: 'boolean', default: false}
    ],
    inputs: {
      design: 'space-design-version/v1',
      dataset: 'space-dataset/v1',
      model: 'space-model/v1',
      manifest: 'space-doc-manifest/v1',
      renders: 'artifact:svg'
    },
    outputs: {bundle: 'artifact:bundle', manifest: 'artifact:json', index: 'artifact:html'},
    sideEffects: ['write:artifact'],
    requires: [],
    idempotent: true,
    errors: [
      'E_EXEC_PARAM', 'E_DATA_SCHEMA', 'E_DATA_INVALID', 'E_DATA_REFERENCE', 'E_DATA_RULE',
      'E_STORE_PATH', 'E_STORE_IO', 'E_STORE_CONFLICT'
    ],
    async run(ctx, {scheme, seq, name, force = false} = {}) {
      if (!scheme) throw fail('E_EXEC_PARAM', '需要方案 id');
      if (!Number.isInteger(seq) || seq < 1) throw fail('E_EXEC_PARAM', '版本号需为正整数', {seq});

      const bundleName = name || `${scheme}-${PAD(seq)}`;
      let dir;
      try { dir = bundleDir(bundleName); } catch (e) { throw fail('E_EXEC_PARAM', e.message, {name: bundleName}); }

      const input = resolveInputs(ctx, {scheme, seq});
      const docManifest = readManifest(ctx.store);
      const sources = collectBundleSources({
        design: {scheme, seq, designFile: input.designFileRel, versionFile: input.versionRel},
        dataset: {id: input.version.dataset, file: input.dsRel},
        model: input.modelRel,
        docManifest,
        renderFiles: renderFilesOf(ctx)
      });

      // 清单里登记了但文件不在，说明交付物被删过：不导出半个包，先让人复核。
      const missing = sources.filter(s => !ctx.store.exists(s.path)).map(s => s.path);
      if (missing.length) {
        throw fail('E_DATA_REFERENCE', `交付包引用的文件缺失：${missing.join('、')}；先运行 space doc check 复核`, {missing});
      }
      if (!sources.length) throw fail('E_DATA_RULE', `${scheme}#${PAD(seq)} 没有可打包的文件`, {scheme, seq});

      const files = sources.map(source => {
        const buffer = ctx.store.readBuffer(source.path);
        return {...source, buffer, sha256: digest(buffer), bytes: buffer.length};
      });
      const entries = files.map(f => ({path: f.target, role: f.role, sha256: f.sha256, bytes: f.bytes}));
      const manifest = bundleManifest({name: bundleName, design: {scheme, seq}, entries});
      const problems = validateBundle(manifest);
      if (problems.length) throw fail('E_DATA_INVALID', `交付包清单不合法：${problems.join('；')}`, {problems});

      const manifestRel = bundleManifestFile(bundleName);
      const indexRel = `${dir}/index.html`;
      const indexHtml = bundleIndexHtml(manifest);
      const existing = readExisting(ctx, manifestRel);
      const unchanged = !!existing
        && entriesKey(existing.entries) === entriesKey(entries)
        && entries.every(e => ctx.store.hashOf(`${dir}/${e.path}`) === e.sha256)
        && ctx.store.hashOf(indexRel) === digest(indexHtml);

      // 同名包已有不同内容：拒绝静默覆盖，要么换名字，要么显式 force。
      if (existing && !unchanged && !force) {
        throw fail('E_DATA_RULE',
          `交付包 ${bundleName} 已存在且内容不同（${manifestRel}）；确认后加 force，或换一个包名`,
          {dir, manifest: manifestRel});
      }

      for (const file of files) {
        ctx.store.writeArtifact(`${dir}/${file.target}`, file.buffer, {kind: file.role});
      }
      ctx.store.writeArtifact(indexRel, indexHtml, {kind: 'html'});
      const writtenManifest = ctx.store.writeArtifact(manifestRel, jsonText(manifest), {kind: 'json'});

      const bytes = entries.reduce((n, e) => n + e.bytes, 0);
      return {
        summary: `交付包 ${bundleName}：${entries.length} 个文件 · ${formatBytes(bytes)}${unchanged ? '（内容未变化）' : ''}`,
        outputs: [{path: manifestRel, kind: 'json'}, {path: indexRel, kind: 'html'}],
        data: {
          name: bundleName,
          dir,
          manifest: manifestRel,
          manifestSha256: writtenManifest.sha256,
          index: indexRel,
          design: {scheme, seq},
          files: entries.length,
          bytes,
          entries,
          byRole: entries.reduce((acc, e) => ({...acc, [e.role]: (acc[e.role] || 0) + 1}), {}),
          readOnly: true,
          unchanged,
          forced: !!existing && !unchanged && !!force
        }
      };
    }
  },
  {
    id: 'deliver.snapshot',
    version: '1.0.0',
    stage: 'delivery',
    title: '生成只读快照',
    description: '把设计版本、数据集、空间模型、交付清单与渲染图内嵌成一个离线 HTML 快照，附文件哈希清单；单文件只读，不能回写。',
    params: [
      {key: 'scheme', label: '方案 id', type: 'text', required: true},
      {key: 'seq', label: '版本号', type: 'number', required: true},
      {key: 'name', label: '快照名（默认 方案-版本）', type: 'text'},
      {key: 'force', label: '同名快照内容不同时仍然覆盖', type: 'boolean', default: false}
    ],
    inputs: {
      design: 'space-design-version/v1',
      dataset: 'space-dataset/v1',
      model: 'space-model/v1',
      manifest: 'space-doc-manifest/v1',
      renders: 'artifact:svg'
    },
    outputs: {snapshot: 'artifact:html', record: 'artifact:json'},
    sideEffects: ['write:artifact'],
    requires: [],
    idempotent: true,
    errors: [
      'E_EXEC_PARAM', 'E_DATA_SCHEMA', 'E_DATA_INVALID', 'E_DATA_REFERENCE', 'E_DATA_RULE',
      'E_STORE_PATH', 'E_STORE_IO', 'E_STORE_CONFLICT'
    ],
    async run(ctx, {scheme, seq, name, force = false} = {}) {
      if (!scheme) throw fail('E_EXEC_PARAM', '需要方案 id');
      if (!Number.isInteger(seq) || seq < 1) throw fail('E_EXEC_PARAM', '版本号需为正整数', {seq});

      const snapshotName = name || `${scheme}-${PAD(seq)}`;
      let file;
      try { file = snapshotFile(snapshotName); } catch (e) { throw fail('E_EXEC_PARAM', e.message, {name: snapshotName}); }
      // 快照记录与快照并排同名：契约只给了 snapshotFile()，记录路径按同目录同名推导（.html → .json）。
      const recordRel = file.replace(/\.html$/, '.json');

      const input = resolveInputs(ctx, {scheme, seq});
      const scopedManifest = scopeDocManifest(readManifest(ctx.store), {scheme, seq});
      const sources = collectBundleSources({
        design: {scheme, seq, designFile: input.designFileRel, versionFile: input.versionRel},
        dataset: {id: input.version.dataset, file: input.dsRel},
        model: input.modelRel,
        docManifest: scopedManifest,
        renderFiles: renderFilesOf(ctx)
      });
      const missing = sources.filter(s => !ctx.store.exists(s.path)).map(s => s.path);
      if (missing.length) {
        throw fail('E_DATA_REFERENCE', `快照引用的文件缺失：${missing.join('、')}；先运行 space doc check 复核`, {missing});
      }

      // 每个源文件只读一次：字节数、哈希与内嵌内容都来自同一份 Buffer。
      const loaded = new Map();
      const load = (rel) => {
        if (!loaded.has(rel)) {
          const buffer = ctx.store.exists(rel) ? ctx.store.readBuffer(rel) : null;
          loaded.set(rel, buffer ? {buffer, sha256: digest(buffer), bytes: buffer.length} : null);
        }
        return loaded.get(rel);
      };

      const hashes = [];
      for (const source of sources) {
        const f = load(source.path);
        if (f) hashes.push({path: source.path, sha256: f.sha256, bytes: f.bytes});
      }

      const wrap = (rel, value) => {
        const f = rel ? load(rel) : null;
        return rel ? {file: rel, sha256: f ? f.sha256 : null, value} : null;
      };
      const renders = sources
        .filter(s => s.role === 'render')
        .map(source => {
          const f = load(source.path);
          const head = {path: source.path, target: source.target, sha256: f?.sha256 ?? null, bytes: f?.bytes ?? 0};
          const ext = path.extname(source.path).toLowerCase();
          if (TEXT_EXTS.has(ext)) return {...head, text: f.buffer.toString('utf8')};
          return {...head, base64: f.buffer.toString('base64')};
        });

      let html;
      try {
        html = snapshotHtml({
          name: snapshotName,
          design: wrap(input.versionRel, input.version),
          dataset: wrap(input.dsRel, input.dataset),
          model: input.modelRel ? wrap(input.modelRel, input.model) : null,
          docManifest: scopedManifest ? wrap(docManifestFile(), scopedManifest) : null,
          renders,
          hashes
        });
      } catch (e) {
        throw fail('E_DATA_RULE', e.message, {limit: MAX_SNAPSHOT_BYTES});
      }

      const existingSha = ctx.store.exists(file) ? ctx.store.hashOf(file) : null;
      const unchanged = existingSha !== null && existingSha === digest(html);
      if (existingSha !== null && !unchanged && !force) {
        throw fail('E_DATA_RULE',
          `快照 ${snapshotName} 已存在且内容不同（${file}）；确认后加 force，或换一个快照名`,
          {file, previousSha256: existingSha});
      }

      const written = ctx.store.writeArtifact(file, html, {kind: 'html'});
      const embedded = ['design', 'dataset', 'model', 'docManifest', 'renders', ...renders.map(r => r.path)];
      const record = snapshotRecord({
        name: snapshotName,
        file,
        bytes: written.size,
        hashes,
        embedded,
        design: {scheme, seq}
      });
      const problems = validateSnapshot(record);
      if (problems.length) throw fail('E_DATA_INVALID', `快照记录不合法：${problems.join('；')}`, {problems});
      ctx.store.writeArtifact(recordRel, jsonText(record), {kind: 'json'});

      return {
        summary: `只读快照 ${snapshotName}：${formatBytes(written.size)} · 内嵌 ${hashes.length} 个文件哈希${unchanged ? '（内容未变化）' : ''}`,
        outputs: [{path: file, kind: 'html'}, {path: recordRel, kind: 'json'}],
        data: {
          name: snapshotName,
          file,
          record: recordRel,
          bytes: written.size,
          embedded: hashes.length,
          hashes,
          renders: renders.length,
          design: {scheme, seq},
          writable: false,
          offline: true,
          unchanged
        }
      };
    }
  }
];
