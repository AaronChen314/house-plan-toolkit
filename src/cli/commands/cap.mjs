// 宿主层：能力的通用门面。参数由能力契约生成，CLI 不再为每个能力写一套解析。
import path from 'node:path';
import {capabilityCatalog, getCapability, listCapabilities, listPlanned, runCapability} from '../../capabilities/index.mjs';

// 按契约的 type 取值：number 转数字、boolean 走开关，其余原样。
function paramsFor(cap, args) {
  const params = {};
  const known = new Set();
  for (const p of cap.params || []) {
    known.add(`--${p.key}`);
    if (p.type === 'boolean') {
      params[p.key] = args.flag(`--${p.key}`);
      continue;
    }
    const raw = args.take(`--${p.key}`);
    if (raw === undefined) continue;
    if (p.type === 'number') {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`--${p.key} 需要数字，收到 ${raw}`);
      params[p.key] = value;
    } else {
      params[p.key] = raw;
    }
  }
  const unknown = args.rest.filter(a => a.startsWith('--') && !known.has(a));
  if (unknown.length) throw new Error(`这个能力没有这些参数：${unknown.join(' ')}（可用：${[...known].join(' ') || '无'}）`);
  return params;
}

const describe = (p) => {
  const param = (p.params || []).map(x => `--${x.key}${x.required ? '（必填）' : ''}`).join(' ') || '无参数';
  return `${p.id}\t${p.title}\t${p.stage}\t${param}`;
};

export const commands = [
  {
    name: 'cap',
    group: '其他',
    usage: 'space cap list|show|run <能力 id> --project <project.json> [--参数 值]',
    summary: '能力门面：列出、查看契约、按契约参数执行（含计划中的能力）',
    async run(args, {print}) {
      const action = args.shift();
      const json = args.flag('--json');
      // --project 在 list/show 里只用于定位项目级插件目录，在 run 里是执行目标。
      const project = args.take('--project');
      if (project) {
        const {initPlugins} = await import('../../capabilities/index.mjs');
        const {pluginsEnabled} = await import('../../contracts/plugins.mjs');
        await initPlugins({projectDir: path.dirname(path.resolve(project)), enabled: pluginsEnabled(process.env.SPACE_PLUGINS)});
      }

      if (action === 'list' || !action) {
        const stage = args.take('--stage');
        const catalog = capabilityCatalog();
        const implemented = stage ? catalog.implemented.filter(c => c.stage === stage) : catalog.implemented;
        const planned = stage ? catalog.planned.filter(c => c.stage === stage) : catalog.planned;
        if (json) { print(JSON.stringify({implemented, planned}, null, 2)); return; }
        print(`已实现 ${implemented.length} 个`);
        for (const cap of implemented) print(`  ${describe(cap)}`);
        print(`\n计划中 ${planned.length} 个（只有契约，不能执行）`);
        for (const p of planned) print(`  ${p.id}\t${p.title}\t${p.stage}\t阻塞：${p.blockedBy}`);
        return;
      }

      if (action === 'show') {
        const id = args.shift();
        if (!id) throw new Error('需要能力 id：space cap list 查看清单');
        const implemented = listCapabilities().find(c => c.id === id);
        const planned = listPlanned().find(p => p.id === id);
        if (!implemented && !planned) throw new Error(`未知能力：${id}`);
        if (json) { print(JSON.stringify(implemented || planned, null, 2)); return; }
        const cap = implemented || planned;
        print(`${cap.id} · ${cap.title}（${cap.stage}）`);
        print(`  ${cap.description}`);
        if (planned) { print(`  未实现：${planned.blockedBy}`); return; }
        print(`  副作用：${cap.sideEffects.join(', ')} · 幂等：${cap.idempotent ? '是' : '否'} · 依赖：${cap.requires.join(', ') || '无'}`);
        print(`  参数：${(cap.params || []).map(p => `--${p.key}${p.required ? '（必填）' : ''} ${p.type}`).join(' | ') || '无'}`);
        return;
      }

      if (action === 'run') {
        const id = args.shift();
        if (!id) throw new Error('需要能力 id：space cap list 查看清单');
        const planned = listPlanned().find(p => p.id === id);
        if (planned) {
          const err = new Error(`${id} 还没有实现——${planned.blockedBy}`);
          err.code = 'E_EXEC_NOT_IMPLEMENTED';
          throw err;
        }
        const cap = getCapability(id);
        if (!project) throw new Error('需要 --project');
        const params = paramsFor(cap, args);
        const r = await runCapability({project, capability: id, params, log: line => print(line)});
        if (json) { print(JSON.stringify(r, null, 2)); return; }
        print(r.summary);
        for (const o of r.outputs || []) print(`  ${o.path}`);
        return;
      }

      throw new Error('用法：space cap list|show|run <能力 id> --project <project.json>');
    }
  }
];
