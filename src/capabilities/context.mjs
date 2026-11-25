// L3 能力：共享运行上下文。能力实现只拿这个上下文，不直接读 process argv。
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {findPython} from '../cli/python.mjs';
import {ROOT} from '../root.mjs';
import {fail} from '../contracts/errors.mjs';
import {assertStoreInterface} from '../contracts/store.mjs';
import {openStore} from '../store/index.mjs';

export function resolveInside(base, rel) {
  const root = path.resolve(base);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw fail('E_STORE_PATH', `路径越界：${rel}`);
  return abs;
}

export function relOf(projectDir, abs) {
  return path.relative(projectDir, abs).split(path.sep).join('/');
}

export function runProcess(ctx, exec, args) {
  ctx.log(`$ ${path.basename(exec)} ${args.map(a => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);
  const r = spawnSync(exec, args, {cwd: ctx.dir, encoding: 'utf8'});
  if (r.stdout) ctx.log(r.stdout.trim());
  if (r.stderr) ctx.log(r.stderr.trim());
  if (r.error) throw fail('E_EXEC_DEPENDENCY', `无法执行 ${path.basename(exec)}：${r.error.message}`);
  if (r.status !== 0) throw fail('E_EXEC_PROCESS', `命令失败（退出码 ${r.status}）：${path.basename(exec)}`);
  return r.stdout;
}

export function createContext(projectFile, {log, actor} = {}) {
  const file = path.resolve(projectFile);
  const store = openStore(file, {actor});
  assertStoreInterface(store);
  const project = store.project || JSON.parse(fs.readFileSync(file, 'utf8'));
  const logs = [];
  const logger = (line) => { logs.push(line); if (log) log(line); };
  return {
    file,
    root: ROOT,
    dir: path.dirname(file),
    project,
    store,
    logs,
    log: logger,
    python: findPython(path.dirname(file)),
    outputDir: path.resolve(path.dirname(file), project.output || 'output')
  };
}
