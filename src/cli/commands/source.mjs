// 宿主层：图纸来源与设计同步命令。
import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from '../../root.mjs';
import {buildSourceDrawing} from '../build.mjs';
import {pythonFor, run} from '../exec.mjs';

export const commands = [
  {
    name: 'source',
    group: '项目',
    usage: 'space source add --file <路径> [--as source/drawings/x.dwg] --project <project.json> [--use 用途 --version v1 --from 来源] | space source list',
    summary: '原始资料登记：写 source/manifest.json（来源、版本、用途、sha256），lint 的 E006 靠它',
    async run(args, {print}) {
      const action = args.shift() || 'list';
      const project = args.take('--project') || (fs.existsSync('project.json') ? path.resolve('project.json') : undefined);
      if (!project) throw new Error('需要 --project <project.json>');
      const {openStore} = await import('../../store/index.mjs');
      const store = openStore(project);
      const manifestRel = 'source/manifest.json';
      const manifest = store.exists(manifestRel) ? store.readJson(manifestRel) : {schema: 'source-manifest/v1', files: []};
      manifest.files = Array.isArray(manifest.files) ? manifest.files : [];

      if (action === 'add') {
        const rel = args.take('--file');
        if (!rel) throw new Error('需要 --file <文件路径>（项目内或外部路径，配合 --as）');
        const as = args.take('--as');
        let relPath = rel.replace(/^\.\//, '');
        if (as) {
          // 从项目外收进来：一次完成「拷进 source/ + 登记存储 + 写 manifest」，不留半截状态。
          const abs = path.resolve(rel);
          if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`文件不存在：${rel}`);
          const target = as.replace(/^\.\//, '');
          if (!target.startsWith('source/')) throw new Error(`原始资料必须在 source/ 下：${target}`);
          store.writeData(target, fs.readFileSync(abs), {
            kind: 'source-file',
            note: `收进原始资料 ${target}`,
            baseHash: store.exists(target) ? store.hashOf(target) : null,
            confirm: true
          });
          relPath = target;
        } else {
          if (!store.exists(relPath)) throw new Error(`文件不存在：${relPath}`);
          if (!relPath.startsWith('source/')) throw new Error(`原始资料必须在 source/ 下：${relPath}`);
        }
        const sha256 = store.hashOf(relPath);
        const item = {
          path: relPath,
          use: args.take('--use') || '原始资料',
          version: args.take('--version') || 'v1',
          source: args.take('--from') || '未注明',
          sha256
        };
        // 同一路径重复登记视为更新（指纹变了要能改），不留下两条矛盾记录。
        const i = manifest.files.findIndex(f => (f.path || f.file) === relPath);
        if (i >= 0) manifest.files[i] = item; else manifest.files.push(item);
        store.writeData(manifestRel, JSON.stringify(manifest, null, 2), {
          kind: 'source-manifest',
          note: `登记来源 ${relPath}`,
          baseHash: store.exists(manifestRel) ? store.hashOf(manifestRel) : null,
          confirm: true
        });
        print(`已登记 ${relPath}（${sha256.slice(0, 12)}…）`);
        return;
      }

      for (const f of manifest.files) print(`  ${f.path || f.file}  ${f.use || ''}  ${f.version || ''}  ${(f.sha256 || '').slice(0, 12)}`);
      if (!manifest.files.length) print('source/manifest.json 里还没有登记任何文件');
    }
  },
  {
    name: 'cad',
    group: '图纸与资产',
    usage: 'space cad inspect <input.dxf> --out 目录 | space cad view <source.json> --out 目录',
    summary: 'DXF 图元索引与源图核对页',
    forward: true,
    async run(args, {print}) {
      const action = args.shift();
      if (action === 'inspect') {
        // Python 依赖装在项目自己的 .space/venv 里：给了 --project 用它，
        // 没给就看当前目录是不是项目根，别落到没有依赖的系统 python。
        const project = args.take('--project') || (fs.existsSync('project.json') ? path.resolve('project.json') : undefined);
        const out = args.take('--out') || 'output/cad/source';
        if (!project) {
          // 不在项目里：只做裸解析，产物按 --out 落盘，不涉及存储登记。
          run(pythonFor(undefined), [path.join(ROOT, 'src/cad/read.py'), ...args.rest, '--out', out]);
          return;
        }
        // 在项目里就走存储层：先解析到临时目录，再由 store 搬进 output/ 并登记。
        const {openStore} = await import('../../store/index.mjs');
        const store = openStore(project);
        const staging = store.staging();
        run(pythonFor(project), [path.join(ROOT, 'src/cad/read.py'), ...args.rest, '--out', staging]);
        const written = store.ingest(staging, out);
        for (const w of written) print(w.path);
        return;
      }
      if (action === 'view') {
        const out = args.take('--out');
        if (!out) throw new Error('需要 --out');
        const source = args.rest[0];
        if (!source) throw new Error('需要 source.json 路径');
        print(await buildSourceDrawing(source, out));
        return;
      }
      throw new Error('用法：space cad inspect <input.dxf> --out 目录 | space cad view <source.json> --out 目录');
    }
  },
  {
    name: 'sync',
    group: '项目',
    usage: 'space sync check --manifest <design-manifest.json>',
    summary: '设计到三维的同步门禁',
    forward: true,
    async run(args) {
      const action = args.shift();
      if (action !== 'check') throw new Error('用法：space sync check --manifest design-manifest.json');
      const manifest = args.take('--manifest');
      if (!manifest) throw new Error('需要 --manifest');
      run(pythonFor(), [path.join(ROOT, 'src/checks/design_sync.py'), manifest, ...args.rest]);
    }
  }
];
