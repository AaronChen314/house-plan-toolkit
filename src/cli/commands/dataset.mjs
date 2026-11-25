// 宿主层：数据集命令。参数解析在这里，行为在 dataset.* 能力里。
import {runCapability} from '../../capabilities/index.mjs';

export const commands = [
  {
    name: 'dataset',
    group: '数据',
    usage: 'space dataset build|diff|correct --project <project.json> ...',
    summary: '建立数据集、比对两个版本、校正预演（--source / --id / --a / --b / --confirm）',
    async run(args, {print}) {
      const action = args.shift();
      const project = args.take('--project');
      if (!project) throw new Error('需要 --project');
      const json = args.flag('--json');

      if (action === 'build') {
        const r = await runCapability({
          project,
          capability: 'dataset.build',
          params: {source: args.take('--source'), id: args.take('--id'), confirm: args.flag('--confirm')},
          log: line => print(line)
        });
        if (json) { print(JSON.stringify(r, null, 2)); return; }
        print(r.summary);
        for (const f of Object.values(r.data?.files || {})) print(`  ${f}`);
        if (r.data?.assumptions) print(`  预览依据 ${r.data.assumptions} 条（basis=preview，需人工确认）`);
        // project.model 不改：数据集是权威，项目指针由人决定。但要让调用方看见下一步。
        if (r.data?.model) {
          print(`  下一步：把 project.json 的 model 改为 ${r.data.model}，space check / program check / build 才会用这份模型`);
        }
        return;
      }

      if (action === 'diff') {
        const r = await runCapability({project, capability: 'dataset.diff', params: {a: args.take('--a'), b: args.take('--b')}});
        if (json) { print(JSON.stringify(r, null, 2)); return; }
        print(r.summary);
        const d = r.data || {};
        for (const [layer, marks] of Object.entries(d.records || {})) {
          print(`  ${layer}: +${marks.added.length} -${marks.removed.length} ~${marks.changed.length}`);
          for (const id of marks.changed) print(`    改 ${id}`);
        }
        const e = d.entities || {};
        if (e.added || e.removed || e.changed) {
          print(`  图元: +${(e.added || []).length} -${(e.removed || []).length} ~${(e.changed || []).length}`);
        }
        return;
      }

      if (action === 'correct') {
        const r = await runCapability({
          project,
          capability: 'dataset.correct',
          params: {dataset: args.take('--dataset'), source: args.take('--source')}
        });
        if (json) { print(JSON.stringify(r, null, 2)); return; }
        print(r.summary);
        const review = r.data?.review || {};
        if (review.changedHandles) print(`  变化构件：${review.changedHandles.join(', ') || '无'}`);
        if (review.available === false) print(`  复核清单不可用：${review.reason}`);
        else if (!review.suggested?.length) print('  没有设计需要复核');
        else for (const s of review.suggested) {
          const why = s.reason === 'depends-on-dataset' ? '未声明构件，按依赖整个数据集' : `用到 ${s.matched.join(', ')}`;
          print(`  待复核设计：${s.id}#${String(s.seq).padStart(3, '0')}（${s.status}；${why}）`);
        }
        for (const s of review.untouched || []) print(`  不受影响：${s.id}#${String(s.seq).padStart(3, '0')}`);
        if (review.downstream?.available && review.downstream.affected?.length) {
          print(`  下游待复核：${review.downstream.affected.map(d => `${d.id}(${d.kind})`).join('、')}`);
        } else if (review.downstream && review.downstream.available === false) {
          print(`  下游产物未判定：${review.downstream.reason}`);
        }
        print('  只读预演：没有修改任何文件；确认后由设计版本产生新版本');
        return;
      }

      throw new Error('用法：space dataset build|diff|correct --project <project.json>');
    }
  }
];
