// 写入/更新项目版本锁：工具版本、数据 schema、布局版本与数据指纹。
// 权威文件，经存储层的 writeData 写入，带基准哈希与显式确认。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {VERSION} from '../root.mjs';
import {openStore} from '../store/index.mjs';

export const LOCK_SCHEMA = 'space-lock/v1';

export function lockFor(project, dir) {
  const lock = {
    schema: LOCK_SCHEMA,
    toolkit: VERSION,
    schemas: {'space-project': 'v1', 'space-model': 'v1', 'design-sync': 'v1'},
    layoutVersion: 1,
    lockedAt: new Date().toISOString().slice(0, 10)
  };
  if (project?.model) {
    const model = path.resolve(dir, project.model);
    if (fs.existsSync(model)) lock.modelSha256 = crypto.createHash('sha256').update(fs.readFileSync(model)).digest('hex');
  }
  return lock;
}

export function writeLock(projectFile) {
  const store = openStore(projectFile);
  const lock = lockFor(store.project, store.dir);
  store.writeData('space.lock.json', JSON.stringify(lock, null, 2) + '\n', {
    baseHash: store.hashOf('space.lock.json'),
    confirm: true,
    kind: 'json',
    op: 'space.lock'
  });
  return {file: path.join(store.dir, 'space.lock.json'), lock};
}
