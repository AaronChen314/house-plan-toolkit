// 宿主层：家具资产与本地预览命令。透传给各自脚本，本层不做业务。
import path from 'node:path';
import {ROOT} from '../../root.mjs';
import {run} from '../exec.mjs';

export const commands = [
  {
    name: 'assets',
    group: '图纸与资产',
    usage: 'space assets list|search|add|inspect ...',
    summary: '家具资产',
    forward: true,
    async run(args) {
      run(process.execPath, [path.join(ROOT, 'src/furniture/catalog-cli.mjs'), ...args.rest]);
    }
  },
  {
    name: 'serve',
    group: '图纸与资产',
    usage: 'space serve <file.html> [--port 8765]',
    summary: '本地预览',
    forward: true,
    async run(args) {
      run(process.execPath, [path.join(ROOT, 'src/cli/preview.mjs'), ...args.rest]);
    }
  }
];
