// 宿主层：外部进程调用。退出码透传，输出直接继承给调用方。
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {findPython} from './python.mjs';

export function run(exec, args, opts = {}) {
  const r = spawnSync(exec, args, {stdio: 'inherit', ...opts});
  if (r.error) throw r.error;
  process.exitCode = r.status ?? 1;
  return r;
}

export function pythonFor(projectFile) {
  const dir = projectFile ? path.dirname(path.resolve(projectFile)) : undefined;
  return findPython(dir);
}
