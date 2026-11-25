// 宿主层：索引命令。重建、摘要、包围盒查询、图层清单。
import fs from 'node:fs';
import path from 'node:path';
import {openStore} from '../../store/index.mjs';
import {buildIndex, layersIndex, queryIndex, statIndexFor} from '../../indexer/index.mjs';
import {listGlobal, statGlobal, syncGlobal} from '../../indexer/global.mjs';
import {pythonParser} from '../../indexer/python.mjs';

function parseBox(value) {
  if (!value) return undefined;
  const parts = value.split(',').map(v => Number(v.trim()));
  if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) throw new Error('--box 需要 x1,y1,x2,y2');
  return parts;
}

// 默认来源：优先用项目内已解析的 cad-source 产物（不重新解析），否则取第一份 DXF。
function defaultSource(store) {
  if (store.exists('output/cad/source.json')) return 'output/cad/source.json';
  const drawings = path.join(store.dir, 'source', 'drawings');
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (/\.dxf$/i.test(e.name)) found.push(store.rel(abs));
    }
  };
  walk(drawings);
  found.sort();
  if (!found.length) throw new Error('找不到图纸：把 DXF 放进 source/drawings/，或用 --source 指定');
  return found[0];
}

export const commands = [
  {
    name: 'index',
    group: '项目',
    usage: 'space index rebuild|stat|query|layers|global --project <project.json>',
    summary: '几何索引：重建、摘要、包围盒查询；global sync|list|stat 管理跨项目只读摘要',
    async run(args, {print}) {
      const action = args.shift() || 'stat';
      const json = args.flag('--json');

      // 全局索引是跨项目摘要：list / stat 不需要 --project。
      if (action === 'global') {
        const sub = args.shift() || 'stat';
        if (sub === 'sync') {
          const project = args.take('--project');
          if (!project) throw new Error('需要 --project');
          const r = await syncGlobal(openStore(project));
          print(`已同步到全局索引：${r.record.projectId}（${r.record.entities} 图元 · ${r.record.datasets} 数据集 · ${r.record.designs} 设计 · ${r.record.documents} 施工图）`);
          print(`  ${r.file}（只存摘要，不含几何）`);
          return;
        }
        if (sub === 'list') {
          const limit = Number(args.take('--limit') || 50);
          const r = await listGlobal({q: args.take('--q') || '', limit});
          if (!r.available) { print(`全局索引不可用：${r.reason}`); return; }
          if (json) { print(JSON.stringify(r, null, 2)); return; }
          if (!r.rows.length) { print('全局索引里还没有项目：space index global sync --project <project.json>'); return; }
          for (const row of r.rows) {
            print(`${row.projectId}\t${row.name ?? '-'}\t${row.entities} 图元\t${row.datasets} 数据集\t${row.designs} 设计\t${row.documents} 图\t${row.path}`);
          }
          return;
        }
        if (sub === 'stat') {
          const r = await statGlobal();
          if (json) { print(JSON.stringify(r, null, 2)); return; }
          if (!r.available) { print(`全局索引不可用：${r.reason}`); return; }
          print(`全局索引：${r.projects} 个项目 · ${r.entities} 个图元 · ${r.file}`);
          return;
        }
        throw new Error('用法：space index global sync|list|stat --project <project.json>');
      }

      const project = args.take('--project');
      if (!project) throw new Error('需要 --project');
      const store = openStore(project);

      if (action === 'rebuild') {
        const source = args.take('--source') || defaultSource(store);
        const force = args.flag('--force');
        const parse = pythonParser({cwd: store.dir, log: line => print(line)});
        const r = await buildIndex(store, {source, parse, force, op: 'space.index.rebuild'});
        if (json) { print(JSON.stringify(r, null, 2)); return; }
        print(`已建立索引：${r.entities} 个图元${r.skipped ? `，跳过 ${r.skipped} 个无坐标图元` : ''}`);
        print(`  数据集 ${r.dataset} · 来源 ${r.source}${r.cacheHit ? '（命中解析缓存）' : ''} · 解析 ${r.parseMs}ms · 索引 ${r.indexMs}ms`);
        return;
      }

      if (action === 'stat') {
        const r = await statIndexFor(store);
        if (json) { print(JSON.stringify(r, null, 2)); return; }
        if (!r.available) { print(`索引不可用：${r.reason}`); return; }
        if (!r.present) { print('索引尚未建立：space index rebuild --project <project.json>'); return; }
        print(`索引：${r.entities} 个图元 · ${r.layers} 个图层 · ${r.types} 种类型 · ${(r.bytes / 1048576).toFixed(1)} MB`);
        if (r.bounds) print(`  范围 ${r.bounds.map(v => Math.round(v)).join(', ')}`);
        print(`  构建于 ${r.builtAt || '未知'}`);
        return;
      }

      if (action === 'layers') {
        const r = await layersIndex(store, {dataset: args.take('--dataset')});
        if (json) { print(JSON.stringify(r, null, 2)); return; }
        if (!r.available) { print('索引不可用或尚未建立'); return; }
        for (const l of r.layers) print(`${String(l.entities).padStart(7, ' ')}  ${l.layer ?? '(无图层)'}`);
        return;
      }

      if (action === 'query') {
        const query = {
          dataset: args.take('--dataset'),
          box: parseBox(args.take('--box')),
          layers: args.take('--layer'),
          types: args.take('--type'),
          limit: args.take('--limit'),
          offset: args.take('--offset'),
          count: args.flag('--count')
        };
        const r = await queryIndex(store, query);
        if (json) { print(JSON.stringify(r, null, 2)); return; }
        if (!r.available) { print(`索引不可用：${r.reason}`); process.exitCode = 1; return; }
        for (const row of r.rows) {
          print(`${row.handle ?? '-'}\t${row.layer ?? '-'}\t${row.type ?? '-'}\t${Math.round(row.minx)},${Math.round(row.miny)} → ${Math.round(row.maxx)},${Math.round(row.maxy)}`);
        }
        const more = r.nextOffset != null ? `，下一页 --offset ${r.nextOffset}` : '';
        print(`${r.rows.length} 条${r.total != null ? ` / 共 ${r.total} 条` : ''}${more}`);
        return;
      }

      throw new Error('用法：space index rebuild|stat|query|layers --project <project.json>');
    }
  }
];
