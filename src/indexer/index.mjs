// L2 索引层出口。上层只从这里取索引能力，不直接碰 SQLite。
export {buildIndex, queryIndex, statIndexFor, layersIndex, datasetIdFor, loadSource} from './build.mjs';
export {sqliteAvailable, loadSqlite, openIndex, closeIndex, closeReadHandles, fileBytes} from './db.mjs';
export {applySchema, schemaVersion, INDEX_VERSION} from './schema.mjs';
export {entityBox, layerNames, statIndex, queryEntities, insertEntities, clearDataset, registerNode, listNodes, nodeCounts} from './entities.mjs';
export {cacheKey, readParseCache, writeParseCache, pruneCache, PARSER} from './parse-cache.mjs';
export {pythonParser} from './python.mjs';
export {INDEX_SCHEMA_ID, INDEX_FORMAT, QUERY_LIMITS, normalizeQuery, pageOf, indexSummaryOf} from '../contracts/index-query.mjs';
