// 建立 Python 虚拟环境并安装依赖。默认放项目 .space/venv，无项目时放包内 .venv。
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT} from '../root.mjs';
import {findPython} from './python.mjs';

export function runSetup({project, python} = {}) {
  const base = project ? path.resolve(project, '.space') : ROOT;
  const venv = path.join(base, project ? 'venv' : '.venv');
  const exe = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  const py = path.join(venv, exe);
  if (!fs.existsSync(py)) {
    const r = spawnSync(python || findPython(project), ['-m', 'venv', venv], {stdio: 'inherit'});
    if (r.status !== 0) throw new Error('创建虚拟环境失败');
  }
  const req = path.join(ROOT, 'requirements.txt');
  const r = spawnSync(py, ['-m', 'pip', 'install', '--upgrade', 'pip', '-q'], {stdio: 'inherit'});
  if (r.status !== 0) throw new Error('升级 pip 失败');
  const i = spawnSync(py, ['-m', 'pip', 'install', '-r', req], {stdio: 'inherit'});
  if (i.status !== 0) throw new Error('安装 Python 依赖失败');
  return {venv, python: py};
}
