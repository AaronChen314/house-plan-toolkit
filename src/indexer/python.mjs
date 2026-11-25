// L2 索引：解析器适配。外部进程只在系统临时目录里产出，索引层只读结果。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT} from '../root.mjs';
import {findPython} from '../cli/python.mjs';
import {fail} from '../contracts/errors.mjs';

export function pythonParser({cwd, python = findPython(cwd), root = ROOT, log = () => {}} = {}) {
  return async function parseDxf(sourceAbs) {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'space-parse-'));
    try {
      log(`$ python src/cad/read.py ${path.basename(sourceAbs)}`);
      const r = spawnSync(python, [path.join(root, 'src/cad/read.py'), sourceAbs, '--out', staging], {cwd, encoding: 'utf8'});
      if (r.error) throw fail('E_EXEC_DEPENDENCY', `无法执行 ${python}：${r.error.message}`);
      if (r.status !== 0) throw fail('E_EXEC_PROCESS', `DXF 解析失败（退出码 ${r.status}）：${(r.stderr || '').trim().slice(0, 400)}`);
      const file = path.join(staging, 'source.json');
      if (!fs.existsSync(file)) throw fail('E_EXEC_PROCESS', '解析器没有产出 source.json');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.schema !== 'cad-source/v1') throw fail('E_DATA_SCHEMA', `解析结果不是 cad-source/v1：${data.schema}`);
      return data;
    } finally {
      fs.rmSync(staging, {recursive: true, force: true});
    }
  };
}
