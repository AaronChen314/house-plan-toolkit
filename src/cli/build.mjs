// L3→L2：把空间数据生成为离线页面。所有写入经存储层，派生物只落 output/。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {loadProject} from './project.mjs';
import {packAssets} from '../furniture/pack.mjs';
import {VERSION} from '../root.mjs';
import {fail} from '../contracts/errors.mjs';
import {openStore} from '../store/index.mjs';
import {writeFileAtomic} from '../store/atomic.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const safeJSON = x => JSON.stringify(x).replace(/</g, '\\u003c');

export async function buildProject(projectFile, options = {}) {
  const ctx = loadProject(projectFile, options), {data, report} = ctx;
  const out = path.resolve(options.out || ctx.output);
  if (!report.passed) throw fail('E_DATA_INVALID', 'Model validation failed: ' + JSON.stringify(report.issues), {issues: report.issues});
  fs.mkdirSync(out, {recursive: true});
  const store = options.store || openStore(path.resolve(projectFile));
  const rel = (abs) => path.relative(store.dir, abs).split(path.sep).join('/');

  const viewer = options.viewer || 'white-model';
  const furn = viewer === 'white-model' ? packAssets(data, ctx.catalog) : {models: {}};
  const js = await build({entryPoints: [path.join(root, 'viewers', viewer, 'viewer.js')], bundle: true, minify: true, format: 'iife', write: false});
  const template = fs.readFileSync(path.join(root, 'viewers', viewer, 'template.html'), 'utf8');
  const replacements = {__FURN__: safeJSON(furn), __DATA__: safeJSON(data), __JS__: js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')};
  const html = template.replace(/__FURN__|__DATA__|__JS__/g, token => replacements[token]);
  const file = path.join(out, viewer === 'white-model' ? '白模.html' : '平面核对.html');

  // 重建前保留上一版生成物，便于对照；副本同样经存储登记。
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== html) {
    const bucket = path.join(out, 'history', new Date().toISOString().replace(/[:.]/g, '-'));
    for (const n of [path.basename(file), 'model.json', viewer + '-build-report.json', 'validation.json', 'furniture-credits.json']) {
      const prev = path.join(out, n);
      if (fs.existsSync(prev)) store.writeArtifact(rel(path.join(bucket, n)), fs.readFileSync(prev), {kind: 'history'});
    }
  }

  store.writeArtifact(rel(file), html, {kind: 'html'});
  store.writeArtifact(rel(path.join(out, 'model.json')), JSON.stringify(data), {kind: 'json'});
  store.writeArtifact(rel(path.join(out, 'validation.json')), JSON.stringify(report, null, 2), {kind: 'json'});

  const assets = Object.fromEntries(Object.entries(furn.models).map(([id, {b64, ...metadata}]) => [id, metadata]));
  if (viewer === 'white-model') {
    store.writeArtifact(rel(path.join(out, 'furniture-credits.json')), JSON.stringify(assets, null, 2), {kind: 'json'});
  }
  store.writeArtifact(rel(path.join(out, viewer + '-build-report.json')), JSON.stringify({
    toolkitVersion: VERSION,
    projectId: data.projectId,
    viewer,
    html: path.basename(file),
    sourceModel: ctx.project.model,
    sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(ctx.modelPath)).digest('hex'),
    floors: data.floors.length,
    furniture: data.floors.reduce((n, f) => n + f.furniture.length, 0),
    assets: Object.keys(assets),
    validation: report
  }, null, 2), {kind: 'json'});

  return {file, out, data};
}

// 源图核对页：输入是 cad-source/v1 索引，产物是单文件页面。
// 目标目录可能不属于任何项目，这里只用存储层的原子写入原语。
export async function buildSourceDrawing(sourceFile, outDir) {
  const input = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  if (input.schema !== 'cad-source/v1') throw fail('E_DATA_SCHEMA', 'Expected cad-source/v1');
  const data = {
    projectId: 'source-review',
    name: input.source.file + ' · 原图核对',
    floors: [{
      id: 'source',
      name: '原图',
      trace: input.entities.filter(e => e.points?.length > 1).map(e => ({points: e.points, handle: e.id, source: e})),
      texts: input.entities.filter(e => e.text && e.at)
    }]
  };
  const js = await build({entryPoints: [path.join(root, 'viewers/drawing/viewer.js')], bundle: true, minify: true, format: 'iife', write: false});
  const template = fs.readFileSync(path.join(root, 'viewers/drawing/template.html'), 'utf8');
  const values = {__DATA__: safeJSON(data), __JS__: js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')};
  fs.mkdirSync(outDir, {recursive: true});
  const file = path.join(outDir, '原图核对.html');
  writeFileAtomic(file, template.replace(/__DATA__|__JS__/g, t => values[t]));
  return file;
}
