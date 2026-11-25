// 宿主层：图纸来源与设计同步命令。
import path from 'node:path';
import {ROOT} from '../../root.mjs';
import {buildSourceDrawing} from '../build.mjs';
import {pythonFor, run} from '../exec.mjs';

export const commands = [
  {
    name: 'cad',
    group: '图纸与资产',
    usage: 'space cad inspect <input.dxf> --out 目录 | space cad view <source.json> --out 目录',
    summary: 'DXF 图元索引与源图核对页',
    forward: true,
    async run(args, {print}) {
      const action = args.shift();
      if (action === 'inspect') {
        run(pythonFor(), [path.join(ROOT, 'src/cad/read.py'), ...args.rest]);
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
