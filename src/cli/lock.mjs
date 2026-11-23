// 写入/更新项目版本锁：工具版本、数据 schema、布局版本与数据指纹。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {VERSION} from '../root.mjs';

export function writeLock(projectFile) {
  const file = path.resolve(projectFile);
  const project = JSON.parse(fs.readFileSync(file, 'utf8'));
  const dir = path.dirname(file);
  const lock = {
    schema: 'space-lock/v1',
    toolkit: VERSION,
    schemas: {'space-project': 'v1', 'space-model': 'v1', 'design-sync': 'v1'},
    layoutVersion: 1,
    lockedAt: new Date().toISOString().slice(0, 10)
  };
  if (project.model) {
    const model = path.resolve(dir, project.model);
    if (fs.existsSync(model)) lock.modelSha256 = crypto.createHash('sha256').update(fs.readFileSync(model)).digest('hex');
  }
  const out = path.join(dir, 'space.lock.json');
  fs.writeFileSync(out, JSON.stringify(lock, null, 2) + '\n');
  return {file: out, lock};
}
