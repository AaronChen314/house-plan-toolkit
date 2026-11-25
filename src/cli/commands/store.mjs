// 宿主层：存储命令。核对登记、重建登记、导出事件、查看摘要。
import {openStore} from '../../store/index.mjs';

export const commands = [
  {
    name: 'store',
    group: '项目',
    usage: 'space store verify|rebuild|events|stat --project <project.json>',
    summary: '存储登记与事件日志（--strict / --json / --limit）',
    summary: '存储登记与事件日志',
    async run(args, {print}) {
      const action = args.shift() || 'stat';
      const project = args.take('--project');
      if (!project) throw new Error('需要 --project');
      const json = args.flag('--json'), strict = args.flag('--strict');
      const store = openStore(project);

      if (action === 'verify') {
        const r = store.verify();
        if (json) print(JSON.stringify(r, null, 2));
        else {
          print(`${r.ok ? 'PASS' : 'FAIL'} 存储登记：${r.checked} 个文件，${r.events} 条事件，${r.objects.count} 个对象`);
          for (const m of r.missing) print(`  E_STORE_VERIFY 缺失：${m}`);
          for (const m of r.modified) print(`  E_STORE_VERIFY 变更：${m.path}（登记 ${m.expected.slice(0, 12)}，实际 ${m.actual.slice(0, 12)}）`);
          for (const u of r.untracked) print(`  ${strict ? 'E_STORE_VERIFY' : '提示'} 未登记：${u}`);
          for (const t of r.leftovers) print(`  E_STORE_VERIFY 残留临时文件：${t}`);
          if (!r.ok) print('  修复：space store rebuild --project <project.json>');
        }
        process.exitCode = r.ok && (!strict || r.untracked.length === 0) ? 0 : 1;
        return;
      }

      if (action === 'rebuild') {
        const r = store.rebuild({op: 'space.store.rebuild'});
        print(`已重建文件登记：${r.files} 个文件，保留 ${r.events} 条事件`);
        return;
      }

      if (action === 'events') {
        const limit = Number(args.take('--limit') || 0);
        const events = store.events(limit ? {limit} : {});
        if (json) print(JSON.stringify(events, null, 2));
        else for (const e of events) {
          const target = e.path || e.op;
          print(`${String(e.seq).padStart(4, ' ')} ${e.at} ${e.type.padEnd(7)} ${target}${e.status ? ' ' + e.status : ''}${e.mode ? ' (' + e.mode + ')' : ''}`);
        }
        return;
      }

      if (action === 'stat') {
        const r = store.verify();
        print(JSON.stringify({project: r.project, files: r.checked, onDisk: r.onDisk, events: r.events, objects: r.objects, ok: r.ok}, null, 2));
        return;
      }

      throw new Error('用法：space store verify|rebuild|events|stat --project <project.json>');
    }
  }
];
