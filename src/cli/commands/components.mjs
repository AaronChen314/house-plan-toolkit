// 宿主层：构件标注命令。图元索引只说形状，这里写「它是什么构件、凭什么」。
import fs from 'node:fs';
import crypto from 'node:crypto';
import {openStore} from '../../store/index.mjs';
import {
  SCHEMA, componentsDoc, validateComponents, summarize, fromLegacy, kindOrder, kindLabel
} from '../../contracts/components.mjs';

const DEFAULT_SOURCE = 'output/cad/source/source.json';
const TARGET = 'data/cad/components.json';

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 权威数据写入必须带回读取时的哈希：存在就必须带，否则存储层会拒绝。
function writeComponents(store, doc, note) {
  const baseHash = store.exists(TARGET) ? store.hashOf(TARGET) : null;
  return store.writeData(TARGET, JSON.stringify(doc, null, 2), {kind: 'cad-components', note, baseHash, confirm: true});
}

function load(store, sourceRel) {
  const exists = store.exists(sourceRel);
  if (!exists) throw new Error(`图元索引不存在：${sourceRel}（先跑 space cap run cad.inspect）`);
  const src = store.readJson(sourceRel);
  const sha = crypto.createHash('sha256').update(store.readBuffer(sourceRel)).digest('hex');
  return {src, sha, ids: src.entities.map(e => e.id)};
}

export const commands = [
  {
    name: 'components',
    group: '图纸与资产',
    usage: 'space components import|list|kinds|set|clear --project <project.json> ...',
    summary: '构件标注层：把图元标成墙/柱/门窗/梁等（import 旧标注、set 改一条、list 看统计）',
    async run(args, {print}) {
      const action = args.shift() || 'list';
      const project = args.take('--project');
      if (!project) throw new Error('需要 --project');
      const store = openStore(project);
      const sourceRel = args.take('--source') || DEFAULT_SOURCE;
      const json = args.flag('--json');
      const has = store.exists(TARGET);

      if (action === 'import') {
        const file = args.take('--file');
        if (!file) throw new Error('需要 --file <components.json>');
        const {src, sha, ids} = load(store, sourceRel);
        const raw = readJson(file);
        // 两种输入都收：本契约（assignments）与旧项目（{kind:{sourceIds[]}}）。
        let assignments;
        let kinds;
        let skipped = [];
        if (raw.schema === SCHEMA) {
          assignments = raw.assignments || {};
          kinds = raw.kinds || {};
        } else {
          const converted = fromLegacy(raw, {entityIds: ids});
          assignments = converted.assignments;
          kinds = converted.kinds;
          skipped = converted.skipped;
        }
        // 实例层可选：本契约文件里有就带过去，别在导入时静默丢掉。
        const instances = raw.schema === SCHEMA ? raw.instances || {} : {};
        const doc = componentsDoc({sourceSha256: sha, kinds, assignments, instances});
        const problems = validateComponents(doc, {entityIds: ids});
        if (problems.length) {
          print(`不合契约：${problems.length} 条`);
          for (const p of problems.slice(0, 10)) print(`  ${p}`);
          process.exitCode = 1;
          return;
        }
        writeComponents(store, doc, '构件标注导入');
        const counts = summarize(doc);
        if (json) { print(JSON.stringify({written: TARGET, counts, skipped: skipped.slice(0, 20), entities: ids.length}, null, 2)); return; }
        print(`构件标注已写入 ${TARGET}（${src.entities.length} 个图元）`);
        for (const k of kindOrder(doc)) if (counts[k]) print(`  ${kindLabel(doc, k)}：${counts[k]}`);
        const unassigned = ids.length - Object.keys(assignments).length;
        if (unassigned > 0) print(`  未标注：${unassigned}（构件核对里显示为「其他」）`);
        if (skipped.length) {
          print(`  跳过 ${skipped.length} 条（图元索引里没有这些 id，通常是块内图元或旧索引版本）`);
          for (const s of skipped.slice(0, 5)) print(`    ${s.id || s.kind}：${s.reason}`);
        }
        return;
      }

      if (action === 'set') {
        const id = args.take('--id');
        const kind = args.take('--kind');
        if (!id || !kind) throw new Error('需要 --id 与 --kind');
        const {src, sha, ids} = load(store, sourceRel);
        if (!ids.includes(id)) throw new Error(`图元索引里没有这个 id：${id}`);
        if (!has) throw new Error(`还没有构件标注：先 space components import --file <components.json>（kinds 必须由数据定义）`);
        const doc = store.readJson(TARGET);
        if (!doc.kinds?.[kind]) {
          throw new Error(`构件类别 ${kind} 不在本项目的 kinds 里（现有：${Object.keys(doc.kinds || {}).join('、') || '无'}）`);
        }
        if (doc.source?.sha256 && doc.source.sha256 !== sha) {
          throw new Error('构件标注对应的图元索引已变（源文件或解析版本变了）：先重新 import，避免张冠李戴');
        }
        doc.assignments = doc.assignments || {};
        doc.assignments[id] = {
          kind,
          provenance: args.take('--provenance') || 'manual',
          basis: args.take('--basis') || doc.kinds[kind].basis || '人工改判',
          ...(args.take('--confidence') ? {confidence: Number(args.take('--confidence'))} : {})
        };
        const problems = validateComponents(doc, {entityIds: ids});
        if (problems.length) throw new Error(problems[0]);
        writeComponents(store, doc, `构件改判 ${id} → ${kind}`);
        print(`${id} → ${kindLabel(doc, kind)}（${src.entities.length} 个图元，已标注 ${Object.keys(doc.assignments).length}）`);
        return;
      }

      if (action === 'kinds') {
        if (!has) { print(`还没有构件标注：先 import 一份（kinds 随文件进来）`); return; }
        const doc = store.readJson(TARGET);
        const add = args.take('--add');
        if (add) {
          // args.take 只能取一次：先取值再组装，别在断言里重复消费。
          const label = args.take('--label');
          const color = args.take('--color');
          const basis = args.take('--basis');
          const group = args.take('--group');
          const geometry = args.take('--geometry');
          doc.kinds = doc.kinds || {};
          doc.kinds[add] = {
            label: label || add,
            ...(color ? {color} : {}),
            ...(basis ? {basis} : {}),
            ...(group ? {group} : {}),
            ...(geometry ? {geometry} : {})
          };
          const problems = validateComponents(doc);
          if (problems.length) throw new Error(problems[0]);
          writeComponents(store, doc, `新增构件类别 ${add}`);
        }
        for (const [k, v] of Object.entries(doc.kinds || {})) {
          print(`  ${k.padEnd(12)} ${v.label}${v.color ? ` ${v.color}` : ''}${v.geometry ? ` [${v.geometry}]` : ''}${v.basis ? ` · ${v.basis}` : ''}`);
        }
        return;
      }

      if (action === 'clear') {
        const id = args.take('--id');
        if (!has) { print('还没有构件标注'); return; }
        const doc = store.readJson(TARGET);
        if (id) { delete doc.assignments?.[id]; }
        else doc.assignments = {};
        writeComponents(store, doc, id ? `撤销标注 ${id}` : '清空构件标注');
        print(id ? `已撤销 ${id}` : '已清空构件标注');
        return;
      }

      // list：按构件分组，给人工核对与统计用。
      if (!has) { print(`还没有构件标注（${TARGET}）：先 space components import --file <components.json>`); return; }
      const doc = store.readJson(TARGET);
      const counts = summarize(doc);
      const total = Object.keys(doc.assignments || {}).length;
      // 标注是「针对某一份图元索引」的：哈希变了就要重导，否则 id 可能对到别的线上。
      if (store.exists(sourceRel)) {
        const now = crypto.createHash('sha256').update(store.readBuffer(sourceRel)).digest('hex');
        if (doc.source?.sha256 && doc.source.sha256 !== now) {
          print('  ⚠ 这份标注不是针对当前图元索引（索引已重新生成）：请重新 import，或先核对 id 是否还对应同一条线');
        }
      }
      if (json) { print(JSON.stringify({counts, total, source: doc.source}, null, 2)); return; }
      print(`构件标注 ${total} 条（${TARGET}）`);
      for (const k of kindOrder(doc)) if (counts[k]) print(`  ${doc.kinds?.[k]?.group === 'auxiliary' ? '辅助' : '构件'} · ${kindLabel(doc, k)}：${counts[k]}`);
      const byKind = args.take('--kind');
      if (byKind) {
        const ids = Object.entries(doc.assignments || {}).filter(([, a]) => a.kind === byKind).map(([id]) => id);
        print(`  ${byKind} 的图元：${ids.slice(0, 20).join(' ')}${ids.length > 20 ? ` …（共 ${ids.length}）` : ''}`);
      }
    }
  }
];
