// L2 索引：构建与重建。
// 输入可以是 cad-source/v1 索引文件（output/cad/source.json，不解析）或原始 DXF（解析后走缓存）。
// 索引写在 .space/project.sqlite，是派生存储：一次提交一条汇总事件。
import fs from 'node:fs';
import path from 'node:path';
import {fail} from '../contracts/errors.mjs';
import {INDEX_SCHEMA_ID, indexSummaryOf} from '../contracts/index-query.mjs';
import {applySchema, datasetNames, INDEX_VERSION, recreateEntityTables} from './schema.mjs';
import {closeIndex, fileBytes, INDEX_NODE_MIN, openIndex, openIndexRead, sqliteAvailable} from './db.mjs';
import {clearDataset, insertEntities, layerNames, queryEntities, registerNode, statIndex} from './entities.mjs';
import {cacheKey, PARSER, readParseCache, writeParseCache} from './parse-cache.mjs';

export function datasetIdFor(sourceSha256) {
  return `cad:${String(sourceSha256).slice(0, 12)}`;
}

function readCadSource(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.schema !== 'cad-source/v1') throw fail('E_DATA_SCHEMA', `需要 cad-source/v1 索引文件，读到 ${data.schema}`);
  return data;
}

// 取源数据：JSON 直接用；DXF 走解析缓存。能力层也用它，保证只有一条缓存路径。
export async function loadSource(store, sourceRel, {parse, force = false, params = {}}) {
  const abs = store.resolve(sourceRel);
  if (!fs.existsSync(abs)) throw fail('E_EXEC_PARAM', `文件不存在：${sourceRel}`);
  const sourceSha256 = store.hashOf(sourceRel);
  const ext = path.extname(abs).toLowerCase();

  if (ext === '.json') {
    return {data: readCadSource(abs), sourceSha256, parseKey: null, cacheHit: false};
  }
  if (!parse) throw fail('E_EXEC_DEPENDENCY', '解析 DXF 需要注入解析器（见 src/indexer/python.mjs）', {source: sourceRel});

  const cache = store.derived('cache');
  const parseKey = cacheKey({sourceSha256, parser: PARSER, params});
  if (!force) {
    const cached = readParseCache(cache, parseKey);
    if (cached?.data) return {data: cached.data, sourceSha256, parseKey, cacheHit: true};
  }
  const data = await parse(abs, params);
  if (data?.schema !== 'cad-source/v1') throw fail('E_DATA_SCHEMA', `解析结果不是 cad-source/v1：${data?.schema}`);
  writeParseCache(cache, parseKey, {data, parser: PARSER, params, sourceSha256});
  return {data, sourceSha256, parseKey, cacheHit: false};
}

export async function buildIndex(store, {source, dataset, parse, force = false, op = 'index.rebuild', params = {}} = {}) {
  if (!source) throw fail('E_EXEC_PARAM', '需要 source（cad-source JSON 或 DXF 路径）');
  if (!(await sqliteAvailable())) {
    throw fail('E_EXEC_DEPENDENCY', `几何索引需要 Node ${INDEX_NODE_MIN} 以上（node:sqlite）`, {node: process.versions.node, indexNodeMin: INDEX_NODE_MIN});
  }

  const started = Date.now();
  const loaded = await loadSource(store, source, {parse, force, params});
  const parseMs = Date.now() - started;
  const resolvedDataset = dataset || datasetIdFor(loaded.sourceSha256);
  const index = store.derived('index');
  const db = await openIndex(index);
  let written = 0, skipped = 0;
  try {
    applySchema(db);
    // M1 一个项目只有一份几何来源：整表重建。索引里已有别的数据集时才按数据集清。
    const others = datasetNames(db).filter(name => name !== resolvedDataset);
    if (others.length) clearDataset(db, resolvedDataset);
    else recreateEntityTables(db);
    ({written, skipped} = insertEntities(db, {dataset: resolvedDataset, entities: loaded.data.entities || []}));
    registerNode(db, {id: resolvedDataset, kind: 'dataset', label: source, projectId: store.projectId, status: 'draft'});
  } finally {
    closeIndex(db);
  }

  const stat = await statIndexFor(store);
  const ms = Date.now() - started;
  index.commit({
    op,
    summary: {
      dataset: resolvedDataset,
      source,
      sourceSha256: loaded.sourceSha256,
      parseKey: loaded.parseKey,
      cacheHit: loaded.cacheHit,
      entities: written,
      skipped,
      parseMs,
      ms
    }
  });

  return {
    ok: true,
    schema: INDEX_SCHEMA_ID,
    version: INDEX_VERSION,
    dataset: resolvedDataset,
    source,
    sourceSha256: loaded.sourceSha256,
    parseKey: loaded.parseKey,
    cacheHit: loaded.cacheHit,
    entities: written,
    skipped,
    parseMs,
    indexMs: ms - parseMs,
    ms,
    stat
  };
}

export async function statIndexFor(store) {
  if (!(await sqliteAvailable())) return {available: false, reason: 'node:sqlite 不可用', node: process.versions.node};
  const index = store.derived('index');
  if (!index.exists()) return {available: true, present: false};
  const handle = await openIndexRead(index);
  if (!handle) return {available: true, present: false};
  const stat = statIndex(handle.db);
  return {
    available: true,
    present: true,
    ...indexSummaryOf({
      entities: stat.entities,
      layers: layerNames(handle.db).length,
      types: stat.types,
      nodes: stat.nodes,
      bounds: stat.bounds,
      bytes: fileBytes(index.path),
      builtAt: index.stat()?.modifiedAt || null
    }),
    schema: INDEX_SCHEMA_ID
  };
}

// 只读查询：索引不存在时返回 available:false，调用方降级为每次解析。
export async function queryIndex(store, query = {}) {
  if (!(await sqliteAvailable())) return {available: false, reason: 'node:sqlite 不可用', rows: [], total: 0};
  const index = store.derived('index');
  if (!index.exists()) return {available: false, reason: '索引尚未建立', rows: [], total: 0};
  const handle = await openIndexRead(index);
  if (!handle) return {available: false, reason: '索引尚未建立', rows: [], total: 0};
  return {available: true, ...queryEntities(handle.db, query)};
}

export async function layersIndex(store, {dataset} = {}) {
  if (!(await sqliteAvailable())) return {available: false, layers: []};
  const index = store.derived('index');
  if (!index.exists()) return {available: false, layers: []};
  const handle = await openIndexRead(index);
  if (!handle) return {available: false, layers: []};
  return {available: true, layers: layerNames(handle.db, {dataset})};
}
